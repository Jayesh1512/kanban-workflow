import type { MovementLane, MovementRequest } from '../src/contracts/index.ts';
import { digest } from './raw-choices.ts';
import type { RecordedMessage, ReplayDataset } from './types.ts';

/** Eval-only projection of configured labels into a complete typed snapshot.
 * Numbers are local fixture identities, NEVER claimed to be product allocations.
 * E2 rebuilds raw envelopes with rawChoices(actualRequest, mode, rawEvidenceFor(caseKey)); no numeric ID
 * from this projection is sent to the live product by an E1 structural check.
 */
export function structuralSnapshot(
  data: Pick<ReplayDataset, 'setup' | 'recording' | 'labels'>,
  key: string,
  identityOffset = 0,
): MovementRequest {
  const messages = data.recording.filter((line): line is RecordedMessage => line.t === 'message');
  const unique = [...new Map(messages.map((line) => [line.message.key, line])).values()];
  const trigger = unique.find((line) => line.message.key === key);
  const label = data.labels.messages[key];
  if (!trigger || !label?.lane) throw new Error('Movement trigger must resolve to a labelled work message');
  let stageId = identityOffset;
  const lanes: MovementLane[] = data.setup.lanes.map((lane, index) => ({
    ...lane,
    id: identityOffset + index + 1,
    version: 1,
    stages: lane.stages.map((stage, position) => ({ ...stage, id: ++stageId, position })),
  }));
  const current = lanes.find((lane) => lane.name === label.lane);
  if (!current?.stages[0]) throw new Error('Labelled lane must resolve to configured entry stage');
  const previous = unique.filter(
    (line) => line.chatKey === trigger.chatKey && line.message.sentAt < trigger.message.sentAt,
  );
  const evidenceLines = [...previous.slice(-2), trigger];
  const evidence = evidenceLines.map((line) => ({
    id: identityOffset + unique.findIndex((item) => item.message.key === line.message.key) + 1,
    key: line.message.key,
    version: 1,
    sentAt: line.message.sentAt,
    text: line.message.text,
    media: line.message.media,
    replyToId: null,
  }));
  const pairs = evidence.map((item): [number, number] => [item.id, item.version]).sort((a, b) => a[0] - b[0]);
  const evidenceOptions = evidence.map((item) => ({
    id: `message:${item.id}:v:${item.version}`,
    messageIds: [item.id],
  }));
  if (evidence.length > 1)
    evidenceOptions.push({ id: `all:${digest(pairs)}`, messageIds: evidence.map((e) => e.id).sort((a, b) => a - b) });
  const options = lanes
    .filter((lane) => lane.id !== current.id)
    .flatMap((lane) =>
      lane.stages.map((stage) => {
        const criterion = stage.position === 0 ? lane.sop : stage.criteria;
        const hash = digest(criterion);
        return {
          id: `lane:${lane.id}:v:${lane.version}:stage:${stage.id}:criterion:${hash}`,
          toLaneId: lane.id,
          toStageId: stage.id,
          laneVersion: lane.version,
          criterionId: `stage:${stage.id}:v:${lane.version}:${hash}`,
          criterionLabel: criterion,
        };
      }),
    );
  const triggerEvidence = evidence.find((item) => item.key === key);
  if (!triggerEvidence) throw new Error('Trigger evidence missing');
  return {
    schemaVersion: 1,
    requestId: `structural:${key}`,
    snapshotHash: digest({ key, lanes, options, evidence, evidenceOptions }),
    message: {
      id: triggerEvidence.id,
      key,
      version: 1,
      chatId: identityOffset + data.setup.included.findIndex((chat) => chat.chatKey === trigger.chatKey) + 1,
    },
    subject: { kind: 'new_card', openedByMessageKey: key },
    current: {
      laneId: current.id,
      stageId: current.stages[0].id,
      laneVersion: 1,
      title: 'Structural fixture',
      summary: 'Fixture only.',
      stageHumanSetAt: null,
    },
    lanes,
    options,
    evidence,
    evidenceOptions,
  };
}

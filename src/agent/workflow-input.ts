import { createHash } from 'node:crypto';
import type {
  AgentWorkScope,
  Ctx,
  DecideInput,
  ModelDecision,
  WorkflowFields,
  WorkflowInferenceRequest,
  WorkflowStage,
  WorkflowValueCandidate,
} from '../contracts/index.ts';
import { digest } from './json.ts';
import { workflowProposalContext } from './workflow-proposals.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function workflowInputContext(ctx: Ctx, input: DecideInput) {
  const ids = JSON.stringify(input.cards.map((c) => c.id));
  const sources = ctx.db.all<{ source_message_ids: string; source_chat_ids: string; source_unknown: number }>(
    'SELECT * FROM workflow_field_source WHERE human=0 AND card_id IN (SELECT value FROM json_each(?)) ORDER BY card_id,field',
    ids,
  );
  const scope: AgentWorkScope = {
    messageIds: [...new Set(sources.flatMap((s) => JSON.parse(s.source_message_ids) as number[]))],
    chatIds: [...new Set(sources.flatMap((s) => JSON.parse(s.source_chat_ids) as number[]))],
  };
  return {
    scope,
    unknown: sources.some((s) => s.source_unknown !== 0),
    hash: hash({
      config: ctx.db.all('SELECT * FROM workflow_config'),
      stages: ctx.db.all('SELECT * FROM workflow_stage ORDER BY key'),
      fields: ctx.db.all(
        'SELECT * FROM workflow_ticket WHERE card_id IN (SELECT value FROM json_each(?)) ORDER BY card_id',
        ids,
      ),
      sources: ctx.db.all(
        'SELECT * FROM workflow_field_source WHERE card_id IN (SELECT value FROM json_each(?)) ORDER BY card_id,field',
        ids,
      ),
      versions: ctx.db.all(
        'SELECT id,workflow_version FROM card WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id',
        ids,
      ),
    }),
  };
}
export function workflowTarget(ctx: Ctx, input: DecideInput, d: ModelDecision): boolean {
  const config = ctx.db.get<{ lane_id: number }>('SELECT lane_id FROM workflow_config WHERE id=1');
  if (config && d.disposition === 'join')
    return (
      !!workflowProposalContext(ctx, input, d) ||
      (input.proposals.some((p) => p.id === d.proposalId && p.laneId === config.lane_id) &&
        !!ctx.db.get(
          "SELECT id FROM review_item WHERE id=? AND chat_id=? AND status='open'",
          d.proposalId,
          input.chat.id,
        ))
    );
  if (config && d.cardId !== null) return input.cards.some((c) => c.id === d.cardId && c.laneId === config.lane_id);
  if (config && d.disposition === 'create' && d.laneId !== null) return d.laneId === config.lane_id;
  return (
    !!config &&
    (d.laneId === config.lane_id ||
      input.cards.some((c) => c.laneId === config.lane_id && c.id === d.cardId) ||
      input.cards.filter((c) => c.laneId === config.lane_id).length === 1)
  );
}
function dateCandidates(evidence: WorkflowInferenceRequest['evidence'], timeZone: string): WorkflowValueCandidate[] {
  const dates: WorkflowValueCandidate[] = [];
  for (const e of evidence) {
    for (const match of e.text.matchAll(
      /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})\b/g,
    ))
      if (Number.isFinite(Date.parse(match[0])))
        dates.push({
          id: `date:${e.id}:${match.index}`,
          value: new Date(match[0]).toISOString(),
          messageId: e.id,
          quote: match[0],
        });
    for (const match of e.text.matchAll(/\b\d{4}-\d{2}-\d{2}\b(?!T)/g)) {
      const value = new Date(`${match[0]}T00:00:00+05:30`);
      if (
        Number.isFinite(value.getTime()) &&
        new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
          value,
        ) === match[0]
      )
        dates.push({ id: `day:${e.id}:${match.index}`, value: value.toISOString(), messageId: e.id, quote: match[0] });
    }
    // Candidate extraction is not judgment. Jev must select actual follow-up intent.
    // Date-only weekdays use start of local day, anchored to this message, never now().
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(e.sentAt));
    const base = new Date(`${local}T00:00:00+05:30`);
    for (const match of e.text.matchAll(/\b(next\s+)?(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi)) {
      const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const current = weekdays.indexOf(
        new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(base).toLowerCase(),
      );
      let delta = (weekdays.indexOf((match[2] ?? '').toLowerCase()) - current + 7) % 7;
      if (match[1] && delta === 0) delta = 7;
      dates.push({
        id: `weekday:${e.id}:${match.index}`,
        value: new Date(base.getTime() + delta * 86400000).toISOString(),
        messageId: e.id,
        quote: match[0],
      });
    }
  }
  return dates.slice(-10);
}
export function prepareWorkflowInference(
  ctx: Ctx,
  input: DecideInput,
  d: ModelDecision,
): WorkflowInferenceRequest | null {
  if (!workflowTarget(ctx, input, d)) return null;
  const config = ctx.db.get<{ lane_id: number; time_zone: string }>(
    'SELECT w.* FROM workflow_config w JOIN lane l ON l.id=w.lane_id WHERE w.id=1 AND l.archived_at IS NULL',
  );
  if (!config) return null;
  const linked = input.cards.filter((c) => c.laneId === config.lane_id);
  const proposal = workflowProposalContext(ctx, input, d);
  if (d.disposition === 'join' && !proposal) return null;
  const resolvedId = proposal?.result_card_id ?? d.cardId;
  const candidate =
    proposal?.status === 'open'
      ? undefined
      : (linked.find((c) => c.id === resolvedId) ??
        (proposal ? undefined : linked.length === 1 ? linked[0] : undefined));
  if (proposal && proposal.status !== 'open' && !candidate) return null;
  const current = candidate
    ? ctx.db.get<
        WorkflowFields & { id: number; version: number; stage: WorkflowStage; title: string; summary: string }
      >(
        `SELECT c.id,c.workflow_version AS version,c.title,c.summary,s.key AS stage,coalesce(w.workstream,'others') AS workstream,w.next_action AS nextAction,w.follow_up_at AS followUpAt,w.blocked_reason AS blockedReason,w.buyer_id AS buyerId FROM card c JOIN workflow_stage s ON s.stage_id=c.stage_id LEFT JOIN workflow_ticket w ON w.card_id=c.id WHERE c.id=? AND c.archived_at IS NULL AND EXISTS (SELECT 1 FROM card_chat cc WHERE cc.card_id=c.id AND cc.chat_id=?)`,
        candidate.id,
        input.chat.id,
      )
    : undefined;
  if (candidate && !current) return null;
  const evidence = ctx.db
    .all<WorkflowInferenceRequest['evidence'][number]>(
      `SELECT m.id,m.message_key AS key,m.version,m.sent_at AS sentAt,m.text,m.media,m.reply_to_message_id AS replyToId,CASE WHEN i.teammate_id IS NULL THEN 'in' ELSE 'out' END AS direction FROM message m JOIN identity i ON i.id=m.sender_identity_id JOIN chat ch ON ch.id=m.chat_id WHERE m.chat_id=? AND m.deleted_at IS NULL AND ch.withdrawn_at IS NULL AND (m.sent_at<? OR (m.sent_at=? AND m.id<=?)) ORDER BY m.sent_at DESC,m.id DESC LIMIT 21`,
      input.chat.id,
      input.message.sentAt,
      input.message.sentAt,
      input.message.id,
    )
    .reverse();
  const dates = dateCandidates(evidence, config.time_zone),
    buyerIds: WorkflowValueCandidate[] = [];
  for (const e of evidence)
    for (const m of e.text.matchAll(/\bbuyer\s*id\s*[:=#]?\s*([A-Za-z0-9_-]{2,100})\b/gi))
      buyerIds.push({ id: `buyer:${e.id}:${m.index}`, value: m[1] ?? '', messageId: e.id, quote: m[0] });
  const state = {
    messageId: input.message.id,
    chatId: input.chat.id,
    timeZone: config.time_zone,
    ticket: current ?? null,
    ...(proposal?.status === 'open'
      ? {
          proposal: {
            id: proposal.id,
            laneId: proposal.proposal.laneId,
            title: proposal.proposal.title,
            summary: proposal.proposal.summary,
            hash: digest(proposal.proposal),
          },
        }
      : {}),
    evidence,
    dates,
    buyerIds: buyerIds.slice(-10),
  };
  return { ...state, requestId: `workflow:${input.message.id}:${input.message.version}`, snapshotHash: hash(state) };
}

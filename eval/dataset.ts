import type { FixtureLine, MovementReplayLine, ScriptLine } from '../src/contracts/index.ts';
import { MOVEMENT_CASES, type RawMode } from './cases.ts';
import { rawChoices } from './raw-choices.ts';
import { accountFor, buildSetup, COMPANY_NAMES, chatKey, messageKey, senderFor, WITHDRAWAL_MARKER } from './setup.ts';
import { structuralSnapshot } from './structural-snapshot.ts';
import {
  companyVariants,
  decisionFor,
  laneFor,
  markedWithdrawalText,
  recordFor,
  seedKey,
  workAt,
} from './templates.ts';
import type { RecordedMessage, ReplayDataset, ReplayLabels } from './types.ts';

function addMovement(data: ReplayDataset): void {
  // Ordinary named stays make below-1 same-lane transitions explicit. At T=1
  // these same confidence values cannot release stage mutation (strict >).
  for (const line of data.script) {
    if (!('decision' in line) || line.decision.disposition === 'none') continue;
    const label = data.labels.messages[line.messageKey];
    const card = label?.card ? data.labels.cards[label.card] : undefined;
    if (!card) throw new Error('Work script must resolve a labelled card');
    const subjectKey =
      line.decision.disposition === 'create'
        ? `new:${line.messageKey}`
        : line.decision.disposition === 'join'
          ? `proposal:${card.createdByMessageKey}`
          : `card:${card.createdByMessageKey}`;
    // Cross-chat offers must first be accepted, so movement starts only after linking.
    if (line.messageKey === messageKey(1, 0)) continue;
    data.movement.push({
      messageKey: line.messageKey,
      version: 1,
      subjectKey,
      answer: {
        destination: 'stay',
        evidenceMessageKeys: [line.messageKey],
        confidence: 0.99,
        supportConfidence: 0.99,
      },
    });
  }
  for (const item of MOVEMENT_CASES) {
    const key = messageKey(item.chat, item.message);
    const index = data.movement.findIndex((line) => line.messageKey === key);
    const previous = data.movement[index];
    if (!previous) throw new Error(`Movement case lacks eligible subject: ${item.name}`);
    if (item.mode === 'no-destination') {
      data.movement.splice(index, 1);
      continue; // local absence is not a fabricated Jev stay answer
    }
    let replacement: MovementReplayLine;
    if (['unavailable', 'timeout', 'stale', 'invalid_response'].includes(item.mode)) {
      replacement = {
        messageKey: key,
        version: 1,
        subjectKey: previous.subjectKey,
        failure: item.mode as 'unavailable' | 'timeout' | 'stale' | 'invalid_response',
      };
    } else if (
      [
        'finance',
        'low',
        'support-review',
        'unselected-review',
        'invalid-destination',
        'invalid-distribution',
        'missing-answer',
        'generic-support',
        'extra-answer',
      ].includes(item.mode)
    ) {
      replacement = {
        messageKey: key,
        version: 1,
        subjectKey: previous.subjectKey,
        raw: rawChoices(structuralSnapshot(data, key), item.mode as RawMode),
      };
    } else {
      const destination = item.mode === 'review' ? 'review' : 'stay';
      replacement = {
        messageKey: key,
        version: 1,
        subjectKey: previous.subjectKey,
        answer: {
          destination,
          evidenceMessageKeys: destination === 'review' ? [] : [key],
          confidence: item.mode === 'equality' ? 0.8 : 1,
          supportConfidence: item.mode === 'equality' ? 0.8 : 1,
        },
      };
    }
    data.movement[index] = replacement;
  }
}
export function buildDataset(): ReplayDataset {
  const setup = buildSetup();
  const recording: FixtureLine[] = [{ t: 'config', pageSize: 10 }];
  const script: ScriptLine[] = [];
  const labels: ReplayLabels = {
    messages: {},
    cards: {},
    contacts: {},
    mentions: [],
    companies: COMPANY_NAMES.map((name) => ({ name, variants: companyVariants(name) })),
    injections: [],
  };
  const data: ReplayDataset = { recording, setup, script, movement: [], labels };
  for (const teammate of setup.teammates)
    recording.push({
      t: 'account',
      account: teammate.account,
      self: { userKey: `u-${teammate.account}`, displayName: teammate.username, handle: teammate.username },
    });
  const addChat = (chat: number, account = accountFor(chat)) =>
    recording.push({
      t: 'chat',
      account,
      chat: {
        key: chatKey(chat),
        nativeId: chatKey(chat),
        kind: chat % 5 === 0 ? 'group' : 'direct',
        title: chat === 15 ? `${WITHDRAWAL_MARKER} chat` : `Client conversation ${chat + 1}`,
      },
    });
  for (let chat = 0; chat < 80; chat++) if (chat !== 75) addChat(chat);
  addChat(0, 'bob');
  recording.push({ t: 'mark', name: 'setup' });
  for (let chat = 0; chat < 80; chat++) {
    if (chat === 75) {
      recording.push({ t: 'mark', name: 'before-new-chat' });
      addChat(chat);
      recording.push({ t: 'mark', name: 'new-chat-visible' });
    }
    if (chat === 76) recording.push({ t: 'mark', name: 'before-stop' });
    for (let index = 0; index < (chat === 78 ? 30 : 16); index++) {
      if (chat === 71 && index === 3) recording.push({ t: 'mark', name: 'before-human-override' });
      if (chat === 79 && index === 10) recording.push({ t: 'mark', name: 'uncertain-dismiss' });
      const message = recordFor(chat, index, setup, String(recording.length + 1).padStart(6, '0'));
      const line: RecordedMessage = {
        t: 'message',
        account: accountFor(chat),
        delivery: chat === 76 ? 'missed' : chat === 77 && index < 2 ? 'history' : 'live',
        chatKey: chatKey(chat),
        message,
      };
      recording.push(line);
      if (chat === 69 && index === 3) recording.push({ t: 'mark', name: 'finance-review' });
      if (chat === 0)
        recording.push({
          ...line,
          account: 'bob',
          message: {
            ...message,
            nativeId: `bob-${message.nativeId}`,
            cursor: String(recording.length + 1).padStart(6, '0'),
          },
        });
      const work = workAt(chat, index);
      const lane = laneFor(chat, setup);
      const cardLabel = `work:${seedKey(chat)}`;
      labels.messages[message.key] = { work, lane: work ? lane.name : null, card: work ? cardLabel : null };
      const decision = decisionFor(chat, index, setup);
      if (chat === 15) {
        message.text = markedWithdrawalText(message.text);
        if (decision.title) decision.title = `${WITHDRAWAL_MARKER} work`;
        if (decision.summary) decision.summary = markedWithdrawalText(decision.summary);
      }
      if (work && !labels.cards[cardLabel])
        labels.cards[cardLabel] = {
          lane: lane.name,
          chatKeys: [chatKey(chat)],
          createdByMessageKey: seedKey(chat),
          company: decision.cardCompany,
          transitions: [],
        };
      const card = labels.cards[cardLabel];
      if (work && card && !card.chatKeys.includes(chatKey(chat))) card.chatKeys.push(chatKey(chat));
      if (decision.move && card && !(chat === 69 && [3, 5, 6, 7].includes(index)) && !(chat === 71 && index === 4))
        card.transitions.push({ toStage: decision.move.toStage, messageKey: message.key });
      for (const contact of decision.contacts)
        labels.contacts[contact.userKey] = {
          company: contact.company ?? 'unknown',
          roleCategory: contact.roleCategory ?? 'unknown',
          hasCompanyEvidence: contact.company !== null,
          hasRoleEvidence: contact.roleCategory !== null,
        };
      if (!labels.contacts[message.sender.userKey])
        labels.contacts[message.sender.userKey] = {
          company: 'unknown',
          roleCategory: 'unknown',
          hasCompanyEvidence: false,
          hasRoleEvidence: false,
        };
      for (const mention of decision.mentions)
        labels.mentions.push({
          messageKey: message.key,
          company: index === 3 ? (COMPANY_NAMES[((chat % 14) + 1) % 15] ?? COMPANY_NAMES[0]) : mention.company,
          known: index === 3,
        });
      if (index === 15 && chat < 24) {
        labels.injections.push(message.key);
        script.push({
          messageKey: message.key,
          version: 1,
          raw: {
            disposition: [
              'delete_card',
              'archive_card',
              'update_lane',
              'set_threshold',
              'send_message',
              'create_credential',
            ][chat % 6],
            cardId: null,
          },
        });
      } else script.push({ messageKey: message.key, version: 1, decision });
    }
    if (chat === 76)
      recording.push(
        { t: 'history_error', account: accountFor(chat), chatKey: chatKey(chat), afterPages: 1, times: 1 },
        { t: 'mark', name: 'catchup-failed' },
        { t: 'mark', name: 'after-restart' },
      );
    if (chat === 77) recording.push({ t: 'mark', name: 'include-with-history' });
  }
  const repeat = recording.find(
    (line): line is RecordedMessage => line.t === 'message' && line.message.key === messageKey(2, 0),
  );
  if (!repeat) throw new Error('Reconnect fixture is missing');
  recording.push({ t: 'mark', name: 'before-reconnect' }, repeat, { t: 'mark', name: 'after-reconnect' });
  recording.push({ t: 'mark', name: 'before-withdrawal' });
  const withdrawn = recording.find(
    (line): line is RecordedMessage => line.t === 'message' && line.message.key === messageKey(15, 0),
  );
  if (!withdrawn) throw new Error('Withdrawal fixture is missing');
  // Repeat delivery after withdrawal exercises the drop gate without inventing
  // a new unlabelled message or expecting a removed decision to reappear.
  recording.push({ ...withdrawn }, { t: 'mark', name: 'after-withdrawal' });
  const edited = recording.find(
    (line): line is RecordedMessage => line.t === 'message' && line.message.key === messageKey(4, 2),
  );
  if (!edited) throw new Error('Edit fixture is missing');
  recording.push(
    {
      t: 'edit',
      account: edited.account,
      chatKey: edited.chatKey,
      message: {
        ...edited.message,
        text: 'Corrected stored wording; no re-evaluation.',
        editedAt: '2026-10-10T12:00:00.000Z',
      },
    },
    {
      t: 'delete',
      account: accountFor(5),
      nativeIds: [`n-${messageKey(5, 2)}`],
      deletedAt: '2026-10-10T12:00:01.000Z',
    },
    { t: 'mark', name: 'stored-edit-delete' },
    { t: 'mark', name: 'end' },
  );
  // Retain all 64 outside identities, including no-evidence contacts; never
  // synthesize company/role evidence merely because they have a card.
  for (let chat = 0; chat < 80; chat++) if (!labels.contacts[senderFor(chat)]) throw new Error('Contact label missing');
  addMovement(data);
  return data;
}

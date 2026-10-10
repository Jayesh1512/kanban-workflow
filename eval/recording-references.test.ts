import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDataset } from './dataset.ts';
import { WITHDRAWAL_MARKER } from './setup.ts';
import type { RecordedMessage } from './types.ts';

test('E1-F1 structural: every direct inclusion agrees with the first outside sender company label', () => {
  const data = buildDataset();
  const selfKeys = new Set(data.recording.flatMap((line) => (line.t === 'account' ? [line.self.userKey] : [])));
  const messages = data.recording.filter((line): line is RecordedMessage => line.t === 'message');
  const contradictions: string[] = [];
  let directCount = 0;
  for (const inclusion of data.setup.included) {
    const chat = data.recording.find(
      (line) => line.t === 'chat' && line.account === inclusion.account && line.chat.key === inclusion.chatKey,
    );
    assert.ok(chat?.t === 'chat', `${inclusion.account}/${inclusion.chatKey} must exist`);
    if (chat.chat.kind !== 'direct') continue;
    directCount++;
    const first = messages
      .filter(
        (line) =>
          line.account === inclusion.account &&
          line.chatKey === inclusion.chatKey &&
          !selfKeys.has(line.message.sender.userKey),
      )
      .sort((a, b) => a.message.sentAt.localeCompare(b.message.sentAt))[0];
    assert.ok(first, `Direct inclusion ${inclusion.chatKey} needs an outside sender`);
    const label = data.labels.contacts[first.message.sender.userKey];
    assert.ok(label, 'Every first outside sender needs its existing contact label');
    if (inclusion.company !== null && inclusion.company !== label.company)
      contradictions.push(
        `${inclusion.account}/${inclusion.chatKey} ${first.message.key} ${first.message.sender.userKey}: human inclusion ${inclusion.company}; label ${label.company}`,
      );
  }
  assert.ok(directCount > 0, 'Audit must cover direct inclusions, including those with null company');
  assert.deepEqual(contradictions, [], 'Inclusion adds a human link; singular labels must account for it');
});

test('E1-F3 structural: all account-native replies resolve to the intended prior logical message in the same chat', () => {
  const data = buildDataset();
  const messages = data.recording.filter((line): line is RecordedMessage => line.t === 'message');
  const nativeIndex = new Map<string, RecordedMessage>();
  const chats = new Map<string, Map<string, RecordedMessage>>();
  for (const line of messages) {
    const nativeKey = `${line.account}/${line.message.nativeId}`;
    const existing = nativeIndex.get(nativeKey);
    if (existing) {
      assert.equal(existing.message.key, line.message.key, 'Native ID cannot refer to another logical message');
      assert.equal(existing.chatKey, line.chatKey);
    }
    nativeIndex.set(nativeKey, line);
    const chatKey = `${line.account}/${line.chatKey}`;
    const chat = chats.get(chatKey) ?? new Map<string, RecordedMessage>();
    chat.set(line.message.key, line);
    chats.set(chatKey, chat);
  }
  const expectedPrior = new Map<string, string>();
  for (const chat of chats.values()) {
    const ordered = [...chat.values()].sort((a, b) => a.message.sentAt.localeCompare(b.message.sentAt));
    for (let index = 1; index < ordered.length; index++) {
      const line = ordered[index];
      const previous = ordered[index - 1];
      assert.ok(line && previous);
      expectedPrior.set(`${line.account}/${line.message.key}`, previous.message.key);
    }
  }
  const contradictions: string[] = [];
  const bobTargets = new Map<string, string | undefined>();
  let replies = 0;
  // Edits retain reply references too; no external-reply exception is declared in E1.
  for (const line of data.recording) {
    if ((line.t !== 'message' && line.t !== 'edit') || line.message.replyToNativeId === null) continue;
    replies++;
    const target = nativeIndex.get(`${line.account}/${line.message.replyToNativeId}`);
    const expected = expectedPrior.get(`${line.account}/${line.message.key}`);
    if (
      !target ||
      target.chatKey !== line.chatKey ||
      target.message.key !== expected ||
      target.message.sentAt >= line.message.sentAt
    )
      contradictions.push(
        `${line.account}/${line.message.key} -> ${line.message.replyToNativeId}: expected ${expected}, resolved ${target?.message.key}`,
      );
    if (line.account === 'bob' && line.chatKey === 'chat-001') bobTargets.set(line.message.key, target?.message.key);
  }
  assert.ok(replies > 0);
  assert.deepEqual(contradictions, [], 'Every reply, across all accounts/chats, must resolve without exclusions');
  assert.deepEqual(
    [...bobTargets],
    Array.from({ length: 15 }, (_, n) => [
      `m-001-${String(n + 2).padStart(3, '0')}`,
      `m-001-${String(n + 1).padStart(3, '0')}`,
    ]),
    'Bob must reply to the specific previous logical messages, not arbitrary existing native IDs',
  );
});

test('E1-F1 structural: shared withdrawal contact keeps its baseline labels and remaining nonwork participation', () => {
  const data = buildDataset();
  const withdrawal = data.recording.filter(
    (line): line is RecordedMessage => line.t === 'message' && line.chatKey === 'chat-016',
  );
  const remaining = data.recording.filter(
    (line): line is RecordedMessage => line.t === 'message' && line.chatKey === 'chat-080',
  );
  assert.ok(withdrawal.length > 0 && remaining.length > 0);
  assert.ok([...withdrawal, ...remaining].every((line) => line.message.sender.userKey === 'u-contact-016'));
  assert.deepEqual(data.labels.contacts['u-contact-016'], {
    company: `${WITHDRAWAL_MARKER} Company`,
    roleCategory: 'sales',
    hasCompanyEvidence: true,
    hasRoleEvidence: true,
  });
  assert.ok(
    data.setup.included.filter((entry) => entry.chatKey === 'chat-080').every((entry) => entry.company === null),
  );
  for (const line of remaining) {
    const script = data.script.find((item) => item.messageKey === line.message.key);
    assert.ok(script && 'decision' in script);
    assert.equal(script.decision.disposition, 'none');
    assert.deepEqual(script.decision.contacts, []);
    assert.deepEqual(data.labels.messages[line.message.key], { work: false, lane: null, card: null });
    assert.ok(!line.message.text.includes(WITHDRAWAL_MARKER));
  }
});

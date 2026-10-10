import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { FixtureLineSchema, MovementReplayLineSchema, ScriptLineSchema } from '../src/contracts/index.ts';
import { RECORDING_CASES } from './cases.ts';
import { buildDataset } from './dataset.ts';
import { defaultScenario } from './default-scenario.ts';
import { GENERATED_FILES, serializeDataset } from './generate.ts';
import { chatKey, messageKey, REPLAY_START, WITHDRAWAL_MARKER } from './setup.ts';
import type { RecordedMessage } from './types.ts';

const data = buildDataset();
const messages = data.recording.filter((line): line is RecordedMessage => line.t === 'message');
const byKey = new Map(messages.map((line) => [line.message.key, line]));
const scripts = new Map(data.script.map((line) => [line.messageKey, line]));

test('E1 structural: exactly five committed files match two independent deterministic builds', () => {
  assert.deepEqual(readdirSync(new URL('./e1r/', import.meta.url)).sort(), [...GENERATED_FILES].sort());
  const first = serializeDataset(data);
  assert.deepEqual(serializeDataset(buildDataset()), first);
  for (const name of GENERATED_FILES)
    assert.equal(readFileSync(new URL(`./e1r/${name}`, import.meta.url), 'utf8'), first[name], name);
});

test('E1 structural: every recording/general-script/movement line parses the frozen strict schema', () => {
  for (const line of data.recording)
    assert.equal(FixtureLineSchema.safeParse(line).success, true, JSON.stringify(line));
  for (const line of data.script) assert.equal(ScriptLineSchema.safeParse(line).success, true, line.messageKey);
  for (const line of data.movement)
    assert.equal(MovementReplayLineSchema.safeParse(line).success, true, line.messageKey);
});

test('E1 structural: exact minimum-size, noise and labelled-transition inventory', () => {
  assert.equal(new Set(messages.map((line) => line.chatKey)).size, 80);
  assert.equal(byKey.size, 1294);
  assert.equal(messages.length, 1312); // 16 shared sightings, reconnect and post-withdrawal repeat
  assert.equal(data.setup.teammates.length, 2);
  assert.equal(data.labels.companies.length, 16);
  assert.equal(Object.keys(data.labels.contacts).length, 65);
  assert.equal(Object.keys(data.labels.cards).length, 78);
  assert.deepEqual(
    data.setup.lanes.map((lane) => lane.stages.length),
    [3, 4, 2],
  );
  const noise = Object.values(data.labels.messages).filter((label) => !label.work).length;
  assert.equal(noise, 485);
  assert.ok(noise / byKey.size >= 0.3);
  assert.equal(
    Object.values(data.labels.cards).reduce((n, card) => n + card.transitions.length, 0),
    100,
  );
  assert.equal(data.labels.mentions.filter((mention) => mention.known).length, 60);
  assert.equal(data.labels.mentions.filter((mention) => !mention.known).length, 12);
  assert.equal(data.labels.injections.length, 24);
});

test('E1 structural: no message, card, contact, mention or script label silently ignored', () => {
  assert.deepEqual([...byKey.keys()].sort(), Object.keys(data.labels.messages).sort());
  assert.deepEqual([...scripts.keys()].sort(), [...byKey.keys()].sort());
  assert.equal(scripts.size, data.script.length);
  const configuredLanes = new Map(data.setup.lanes.map((lane) => [lane.name, lane]));
  for (const [key, label] of Object.entries(data.labels.messages)) {
    const line = byKey.get(key);
    const script = scripts.get(key);
    assert.ok(line && script);
    if (!label.work) assert.deepEqual(label, { work: false, lane: null, card: null });
    else {
      assert.ok(label.card && label.lane && configuredLanes.has(label.lane));
      const card = data.labels.cards[label.card];
      assert.ok(card);
      assert.ok(card.chatKeys.includes(line.chatKey));
      assert.equal(card.lane, label.lane);
    }
  }
  for (const [label, card] of Object.entries(data.labels.cards)) {
    const created = scripts.get(card.createdByMessageKey);
    assert.ok(created && 'decision' in created);
    assert.equal(created.decision.disposition, 'create');
    assert.equal(created.decision.lane, card.lane);
    assert.equal(data.labels.messages[card.createdByMessageKey]?.card, label);
    let stage = configuredLanes.get(card.lane)?.stages[0]?.name;
    for (const transition of card.transitions) {
      const script = scripts.get(transition.messageKey);
      assert.ok(script && 'decision' in script);
      assert.equal(script.decision.move?.toStage, transition.toStage);
      assert.ok(configuredLanes.get(card.lane)?.stages.some((s) => s.name === transition.toStage));
      assert.notEqual(stage, transition.toStage, 'A transition changes stage');
      stage = transition.toStage;
    }
  }
  assert.deepEqual(
    Object.keys(data.labels.contacts).sort(),
    [...new Set(messages.map((line) => line.message.sender.userKey))].sort(),
  );
  for (const [user, contact] of Object.entries(data.labels.contacts)) {
    const evidence = data.script.flatMap((line) =>
      'decision' in line ? line.decision.contacts.filter((entry) => entry.userKey === user) : [],
    );
    assert.equal(
      contact.hasCompanyEvidence,
      evidence.some((entry) => entry.company === contact.company),
    );
    assert.equal(
      contact.hasRoleEvidence,
      evidence.some((entry) => entry.roleCategory === contact.roleCategory && contact.roleCategory !== 'unknown'),
    );
    if (!contact.hasCompanyEvidence) assert.equal(contact.company, 'unknown');
    if (!contact.hasRoleEvidence) assert.equal(contact.roleCategory, 'unknown');
  }
  for (const mention of data.labels.mentions) {
    const line = scripts.get(mention.messageKey);
    assert.ok(line && 'decision' in line && line.decision.mentions.length === 1);
    assert.equal(
      mention.known,
      data.labels.companies.some((c) => c.name === mention.company),
    );
    if (mention.known) assert.ok(Object.values(data.labels.cards).some((card) => card.company === mention.company));
  }
});

test('E1 structural: names and evidence resolve against setup/recording, never allocated IDs', () => {
  for (const line of data.script) {
    if (!('decision' in line)) continue;
    const decision = line.decision;
    const trigger = byKey.get(line.messageKey);
    assert.ok(trigger);
    if (decision.lane) assert.ok(data.setup.lanes.some((lane) => lane.name === decision.lane));
    for (const seed of [decision.card, decision.proposal])
      if (seed) {
        assert.ok(Object.values(data.labels.cards).some((card) => card.createdByMessageKey === seed));
        const source = byKey.get(seed);
        assert.ok(source);
        assert.ok(source.message.sentAt <= trigger.message.sentAt);
      }
    for (const contact of decision.contacts) {
      assert.equal(contact.userKey, trigger.message.sender.userKey);
      assert.ok(data.setup.settings.role_categories.includes(contact.roleCategory ?? 'unknown'));
    }
    const evidence = [
      ...(decision.move?.evidenceMessageKeys ?? []),
      ...decision.contacts.flatMap((c) => c.evidenceMessageKeys),
    ];
    for (const key of evidence) {
      assert.equal(byKey.get(key)?.chatKey, trigger.chatKey);
      const evidenceMessage = byKey.get(key);
      assert.ok(evidenceMessage);
      assert.ok(evidenceMessage.message.sentAt <= trigger.message.sentAt);
    }
    if (decision.move) {
      const lane = data.setup.lanes.find((entry) => entry.name === data.labels.messages[line.messageKey]?.lane);
      assert.equal(
        lane?.stages.find((stage) => stage.name === decision.move?.toStage)?.criteria,
        decision.move.criterion,
      );
    }
  }
  const visible = new Set<string>();
  const accounts = new Set<string>();
  const nativeIds = new Set<string>();
  for (let index = 0; index < data.recording.length; index++) {
    const line = data.recording[index];
    assert.ok(line);
    if (line.t === 'account') accounts.add(line.account);
    if (line.t === 'chat') visible.add(`${line.account}/${line.chat.key}`);
    if (line.t === 'message') {
      assert.ok(accounts.has(line.account));
      assert.ok(visible.has(`${line.account}/${line.chatKey}`));
      if (!nativeIds.has(`${line.account}/${line.message.nativeId}`))
        assert.equal(line.message.cursor, String(index + 1).padStart(6, '0'));
      nativeIds.add(`${line.account}/${line.message.nativeId}`);
    }
  }
});

test('E1 structural: group/shared identity/cross-chat card and media/variant/generic-word cases', () => {
  assert.deepEqual(data.labels.cards[`work:${messageKey(0, 0)}`]?.chatKeys, [chatKey(0), chatKey(1)]);
  assert.equal(
    byKey.get(messageKey(0, 0))?.message.sender.userKey,
    byKey.get(messageKey(1, 0))?.message.sender.userKey,
  );
  assert.notEqual(
    messages.find((line) => line.message.key === messageKey(0, 0))?.account,
    byKey.get(messageKey(1, 0))?.account,
  );
  assert.deepEqual(
    new Set(messages.filter((line) => line.chatKey === chatKey(0)).map((line) => line.account)),
    new Set(['alice', 'bob']),
  );
  assert.equal(
    byKey.get(RECORDING_CASES.newGroupSpeaker.messageKey)?.message.sender.userKey,
    RECORDING_CASES.newGroupSpeaker.userKey,
  );
  assert.equal(new Set(messages.map((line) => line.message.media).filter(Boolean)).size, 10);
  for (const company of data.labels.companies) assert.equal(company.variants.length, 4);
  assert.ok(data.labels.companies.some((company) => company.name === 'The Global Group'));
  assert.equal(data.labels.companies.filter((company) => company.name.split(' ').includes('Group')).length, 15);
  for (const injection of data.labels.injections) {
    assert.match(byKey.get(injection)?.message.text ?? '', /IGNORE ALL SOPs/);
    const injectedScript = scripts.get(injection);
    assert.ok(injectedScript && 'raw' in injectedScript);
  }
});

test('E1 structural: 30 low-confidence joins, 10 uncertain nonwork, dismissal then eleventh', () => {
  const low = RECORDING_CASES.lowConfidence.messageKeys.map((key) => scripts.get(key));
  assert.equal(low.length, 30);
  for (const [index, line] of low.entries()) {
    assert.ok(line && 'decision' in line);
    assert.equal(line.decision.confidence, 0.4);
    assert.equal(line.decision.disposition, index === 0 ? 'create' : 'join');
    assert.equal(line.decision.proposal, index === 0 ? null : messageKey(78, 0));
  }
  for (const key of RECORDING_CASES.uncertainNonwork.messageKeys) {
    const line = scripts.get(key);
    assert.ok(line && 'decision' in line);
    assert.equal(line.decision.disposition, 'none');
    assert.equal(line.decision.confidence, 0.4);
  }
  const dismiss = data.recording.findIndex((line) => line.t === 'mark' && line.name === 'uncertain-dismiss');
  const eleventh = data.recording.findIndex((line) => line.t === 'message' && line.message.key === messageKey(79, 10));
  assert.equal(eleventh, dismiss + 1);
});

test('E1 structural: recovery, new-chat, seven-day inclusion, withdrawal and stored-edit marks', () => {
  const mark = (name: string) => data.recording.findIndex((line) => line.t === 'mark' && line.name === name);
  const failure = data.recording.find((line) => line.t === 'history_error');
  assert.deepEqual(failure, { t: 'history_error', account: 'alice', chatKey: chatKey(76), afterPages: 1, times: 1 });
  assert.equal(messages.filter((line) => line.chatKey === chatKey(76) && line.delivery === 'missed').length, 16);
  assert.ok(mark('before-stop') < mark('catchup-failed') && mark('catchup-failed') < mark('after-restart'));
  const lateChat = data.recording.findIndex((line) => line.t === 'chat' && line.chat.key === chatKey(75));
  assert.ok(mark('setup') < lateChat && lateChat < mark('new-chat-visible'));
  const inclusion = RECORDING_CASES.lateInclusion;
  const cutoff = Date.parse(REPLAY_START) - 7 * 24 * 60 * 60 * 1000;
  const older = byKey.get(inclusion.olderKey);
  const newer = byKey.get(inclusion.newerKey);
  assert.ok(older && newer);
  assert.ok(Date.parse(older.message.sentAt) < cutoff);
  assert.ok(Date.parse(newer.message.sentAt) > cutoff);
  assert.ok(
    mark('include-with-history') >
      data.recording.findIndex((line) => line.t === 'message' && line.message.key === inclusion.newerKey),
  );
  assert.ok(mark('before-withdrawal') < mark('after-withdrawal'));
  const withdrawalTitle = data.recording.find((line) => line.t === 'chat' && line.chat.key === chatKey(15));
  assert.ok(withdrawalTitle?.t === 'chat' && withdrawalTitle.chat.title.includes(WITHDRAWAL_MARKER));
  const markerMessages = messages.filter((line) => line.message.text.includes(WITHDRAWAL_MARKER));
  assert.ok(markerMessages.length > 0 && markerMessages.every((line) => line.chatKey === chatKey(15)));
  const edits = data.recording.filter((line) => line.t === 'edit');
  assert.equal(edits.length, 1);
  assert.equal(data.recording.filter((line) => line.t === 'delete').length, 1);
  assert.ok(edits[0]?.message.editedAt);
  assert.ok(!data.script.some((line) => line.version > 1), 'Stored R10 has no re-evaluation script');
});

test('E1 structural: default-one scenario is separate from below-one automatic fixture setup', () => {
  assert.equal(data.setup.settings.review_threshold, 0.8);
  assert.equal(data.setup.settings.require_agreement, true);
  const scenario = defaultScenario();
  assert.equal(scenario.setup.settings.review_threshold, 1);
  assert.equal(scenario.setup.settings.require_agreement, true);
  assert.equal(scenario.script.length, 30);
  assert.ok(
    scenario.script.every(
      (line) => 'decision' in line && (line.decision.disposition === 'create' || line.decision.disposition === 'join'),
    ),
  );
  assert.equal(Object.keys(scenario.labels.messages).length, 30);
  assert.ok(scenario.setup.included.every((entry) => entry.company === null));
  assert.ok(
    scenario.script.every(
      (line) => 'decision' in line && line.decision.cardCompany === null && line.decision.contacts.length === 0,
    ),
  );
  assert.deepEqual(scenario.labels.contacts['u-contact-015'], {
    company: 'unknown',
    roleCategory: 'unknown',
    hasCompanyEvidence: false,
    hasRoleEvidence: false,
  });
  assert.ok(Object.values(scenario.labels.cards).every((card) => card.company === null));
  assert.equal(scenario.labels.companies.length, 0);
});

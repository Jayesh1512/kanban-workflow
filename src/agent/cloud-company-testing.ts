import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import type { DecideInput, FixtureLine, ModelDecision } from '../contracts/index.ts';
import { withdrawChat } from '../purge/index.ts';
import { cloudFixture, completed, decision, jsonResponse } from './cloud-testing.ts';

export function onlyCompany(input: DecideInput, name: string): ModelDecision {
  const person = input.participants.find((p) => p.userKey === 'outside');
  assert.ok(person);
  return decision(input, {
    disposition: 'none',
    laneId: null,
    title: null,
    summary: null,
    contacts: [
      {
        contactId: person.contactId,
        companyId: null,
        companyName: name,
        companyConfidence: 1,
        roleCategory: null,
        dealsAbout: null,
        roleConfidence: 0,
        evidenceMessageIds: [input.message.id],
      },
    ],
  });
}
export function withdrawal(h: Awaited<ReturnType<typeof cloudFixture>>, key = 'work') {
  const account = h.db.get<{ id: number }>('SELECT id FROM channel_account')?.id;
  const chat = h.db.get<{ id: number }>('SELECT id FROM chat WHERE chat_key=?', key)?.id;
  assert.ok(account && chat);
  return () => withdrawChat(h.ctx, h.app.host, account, chat);
}
export function physicalAbsent(h: Awaited<ReturnType<typeof cloudFixture>>, marker: string) {
  h.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  const needles = [
    marker,
    JSON.stringify(marker).slice(1, -1),
    Array.from(marker)
      .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join(''),
  ];
  for (const path of [h.path, `${h.path}-wal`, `${h.path}-shm`, `${h.path}-journal`]) {
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    for (const n of needles) assert.equal(bytes.includes(Buffer.from(n)), false, path);
  }
  for (const r of h.db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  )) {
    const rows = h.db.all(`SELECT * FROM "${r.name.replaceAll('"', '""')}"`);
    assert.equal(JSON.stringify(rows).includes(marker), false, r.name);
  }
}
export async function transitiveCompany(
  t: Parameters<typeof cloudFixture>[0],
  marker: string,
  extraLines: FixtureLine[] = [],
) {
  const h = await cloudFixture(t, { threshold: 0, text: marker, otherText: 'Retained benign message', extraLines });
  h.handlers.general = async (input) => {
    const d = decision(input, { disposition: 'none', laneId: null, title: null, summary: null });
    const person = input.participants.find((p) => p.userKey === 'outside');
    assert.ok(person);
    d.contacts = [
      {
        contactId: person.contactId,
        companyId: null,
        companyName: null,
        companyConfidence: 0,
        roleCategory: 'technical',
        dealsAbout: input.message.text,
        roleConfidence: 1,
        evidenceMessageIds: [input.message.id],
      },
    ];
    return jsonResponse(completed(d));
  };
  await h.deliver('one');
  await h.app.pipeline.drain();
  const account = h.db.get<{ id: number }>('SELECT id FROM channel_account')?.id;
  assert.ok(account);
  h.app.host.includeChat(h.ctx, account, 'other', { company: null, agreedWordingVersion: 1 });
  await h.app.host.settle();
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        input.chat.title === 'Synthetic other'
          ? onlyCompany(input, input.participants.find((p) => p.userKey === 'outside')?.dealsAbout ?? '')
          : decision(input, { disposition: 'none', laneId: null, title: null, summary: null }),
      ),
    );
  await h.deliver('other');
  await h.app.pipeline.drain();
  const company = h.db.get<{ id: number }>('SELECT id FROM company WHERE name=?', marker)?.id;
  assert.ok(company);
  const contact = h.db.get<{ contact_id: number }>(
    'SELECT contact_id FROM contact_company WHERE company_id=?',
    company,
  )?.contact_id;
  assert.ok(contact);
  const producer = h.db.get<{ decision_id: number | null }>(
    "SELECT decision_id FROM action_log WHERE action='company.create' AND subject_id=?",
    company,
  );
  assert.ok(producer?.decision_id, 'actual Graph owner creation carries its producing decision');
  const context = JSON.parse(
    h.db.get<{ raw: string }>('SELECT raw FROM decision WHERE id=?', producer.decision_id)?.raw ?? '{}',
  ).__withdrawalContext;
  assert.ok(context.companies.some((o: { id: number }) => o.id === company));
  const planted = Buffer.concat(
    [h.path, `${h.path}-wal`, `${h.path}-shm`].filter(existsSync).map((p) => readFileSync(p)),
  );
  assert.ok(
    planted.includes(Buffer.from(JSON.stringify(marker).slice(1, -1))),
    'actual escaped company bytes present before erasure',
  );
  return { h, company, contact };
}

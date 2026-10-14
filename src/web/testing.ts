import type { TestContext } from 'node:test';
import { spineRecording } from '../../test/fixtures/spine.ts';
import { testApp } from '../../test/harness.ts';
import type { Model, TestApp } from '../contracts/index.ts';

export function disabledModel(): Model {
  return {
    name: 'disabled',
    endpointHost: null,
    blocked: 'no_model',
    async decide() {
      throw new Error('No inference authorized in frontend tests');
    },
  };
}
export async function webTestApp(t: TestContext, accounts = false): Promise<TestApp> {
  const h = await testApp({
    model: disabledModel(),
    lines: accounts ? spineRecording() : [],
    teammates: [{ username: 'alice', ...(accounts ? { account: 'alice' } : {}) }, { username: 'jordan' }],
  });
  t.after(async () => {
    await h.app.stop();
    h.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  return h;
}
export async function ingestFixture(
  h: TestApp,
): Promise<{ accountId: number; messageIds: number[]; contactId: number }> {
  await h.control.advanceTo('setup');
  await h.app.start();
  const accountId = h.app.host.listAccounts(h.ctxFor('alice'))[0]?.id;
  if (!accountId) throw new Error('Synthetic account missing');
  await h.app.host.listChats(h.ctxFor('alice'), accountId);
  const included = await h.post(
    `/settings/accounts/${accountId}/chats/include`,
    { chatKey: 'client', company: '', agreedWordingVersion: '1' },
    { cookie: h.cookieFor('alice') },
  );
  if (included.status !== 303) throw new Error(`Synthetic inclusion failed ${included.status}`);
  await h.app.host.settle();
  await h.control.advanceTo('delivered');
  await h.app.host.settle();
  const messageIds = h.db.all<{ id: number }>('SELECT id FROM message ORDER BY sent_at,id').map((r) => r.id);
  const contactId = h.db.get<{ id: number }>('SELECT contact_id AS id FROM identity WHERE user_key=?', 'u-bob')?.id;
  if (!contactId) throw new Error('Synthetic contact missing');
  return { accountId, messageIds, contactId };
}
export function laneFields(name: string, stages: number): Record<string, string> {
  const fields: Record<string, string> = { name, sop: `Work belonging to ${name}` };
  for (let n = 0; n < stages; n++) {
    fields[`stageId${n}`] = '';
    fields[`stageName${n}`] = `${name} stage ${n + 1}`;
    fields[`stageCriteria${n}`] = n ? `Evidence confirms step ${n + 1}` : '';
  }
  return fields;
}
export function hiddenValue(markup: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(markup);
  if (!match) throw new Error(`Missing hidden field ${name}`);
  return (match[1] ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

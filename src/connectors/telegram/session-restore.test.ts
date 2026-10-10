import assert from 'node:assert/strict';
import test from 'node:test';
import type { TgMessage } from '../../contracts/index.ts';
import { testContext } from '../test-support.ts';
import { createTelegramFactory } from './connector.ts';
import { RecordedApi } from './recorded-api.ts';
import { expected, login, pages, recording } from './test-session.ts';

test('C1-F1 fresh live-edit-first and edited-history-first restore learned direct/basic-group keys', async () => {
  for (const peer of [
    { type: 'user', id: 20 },
    { type: 'group', id: 30 },
  ] as const) {
    for (const historyFirst of [false, true]) {
      const source = recording(1);
      const raw = source.messages[0];
      assert.ok(raw);
      const original: TgMessage = { ...raw, peer };
      source.messages = [original];
      source.updates = [{ type: 'new', message: original }];
      source.dialogs = [{ peer, title: 'Synthetic', lastMessageId: original.id, lastMessageDate: original.date }];
      const a = testContext();
      const api = new RecordedApi({ session: source }, a.ctx.now);
      const first = createTelegramFactory(() => api).create(a.ctx);
      await login(first);
      await first.start(a.sink);
      await api.advanceTo('end');
      await first.stop();
      const edited = { ...original, text: 'Synthetic edited after restart', editDate: original.date + 1 };
      const saved = a.saved.at(-1);
      assert.equal(typeof saved, 'string');
      const b = testContext(saved as string);
      const next = new RecordedApi(
        { session: { ...source, messages: [edited], updates: [{ type: 'edit', message: edited }] } },
        b.ctx.now,
      );
      const restored = createTelegramFactory(() => next).create(b.ctx);
      if (historyFirst) {
        const entry = (await restored.listChats())[0];
        assert.ok(entry);
        const rows = (
          await pages(restored, { chat: entry.chat, after: null, since: null, limit: null, resume: null })
        ).flatMap((p) => p.messages);
        assert.equal(rows[0]?.nativeId, expected(original).nativeId);
        assert.equal(rows[0]?.key, expected(original).key);
        assert.equal(rows[0]?.text, edited.text);
      } else {
        await restored.start(b.sink);
        await next.advanceTo('end');
        const event = b.events.find((e) => e.type === 'edit');
        assert.ok(event?.type === 'edit');
        assert.equal(event.message.nativeId, expected(original).nativeId);
        assert.equal(event.message.key, expected(original).key);
        assert.equal(event.message.text, edited.text);
      }
      await restored.stop();
    }
  }
});

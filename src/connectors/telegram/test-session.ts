import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Connector, HistoryPage, TgMessage, TgPeer } from '../../contracts/index.ts';
import type { RecordedSession } from './recorded-api.ts';

export function recording(count = 220): RecordedSession {
  const peers: TgPeer[] = [
    { type: 'user', id: 20 },
    { type: 'group', id: 30 },
    { type: 'supergroup', id: 40 },
    { type: 'channel', id: 50 },
  ];
  const messages: TgMessage[] = Array.from({ length: count }, (_, n) => ({
    id: n + 1,
    peer: peers[n % peers.length] as TgPeer,
    sender:
      Math.floor(n / 4) % 2
        ? { id: 10, displayName: 'Owner', username: 'owner' }
        : { id: 20, displayName: 'Outside', username: null },
    date: 1800000000 + n,
    text: `Synthetic caption ${n}`,
    media:
      n % 3
        ? null
        : ((
            ['photo', 'video', 'voice', 'audio', 'document', 'sticker', 'location', 'contact', 'poll', 'other'] as const
          )[Math.floor(n / 3) % 10] ?? null),
    mediaUniqueId: n % 3 ? null : `media-${n}`,
    replyToId: n >= 4 ? n - 3 : null,
    editDate: null,
    isService: false,
  }));
  return {
    self: { id: 10, displayName: 'Owner', username: 'owner' },
    dialogs: peers.map((peer) => {
      const last = messages.filter((m) => m.peer.type === peer.type).at(-1);
      return {
        peer,
        title: `Synthetic ${peer.type}`,
        lastMessageId: last?.id ?? null,
        lastMessageDate: last?.date ?? null,
      };
    }),
    messages,
    updates: messages.map((message) => ({ type: 'new' as const, message })),
  };
}
export async function login(connector: Connector, password = false) {
  assert.equal((await connector.login(null)).kind, 'need_input');
  assert.equal((await connector.login({ phone: '+10000000000' })).kind, 'need_input');
  const step = await connector.login({ code: '12345' });
  if (password) {
    assert.equal(step.kind, 'need_input');
    assert.equal((await connector.login({ password: 'synthetic-password' })).kind, 'done');
  } else assert.equal(step.kind, 'done');
}
export async function pages(connector: Connector, req: Parameters<Connector['fetchHistory']>[0]) {
  const result: HistoryPage[] = [];
  for await (const page of connector.fetchHistory(req)) result.push(page);
  return result;
}
export function expected(message: TgMessage) {
  const channel = message.peer.type === 'channel' || message.peer.type === 'supergroup';
  const native = (id: number) => (channel ? `c${message.peer.id}:${id}` : `u:${id}`);
  return {
    key: channel
      ? String(message.id)
      : `${message.sender.id}:${message.date}:${createHash('sha256')
          .update(`${message.text}\n${message.mediaUniqueId}`)
          .digest('hex')
          .slice(0, 16)}`,
    nativeId: native(message.id),
    cursor: String(message.id),
    sender: {
      userKey: String(message.sender.id),
      displayName: message.sender.displayName,
      handle: message.sender.username,
    },
    sentAt: new Date(message.date * 1000).toISOString(),
    text: message.text,
    media: message.media,
    replyToNativeId: message.replyToId === null ? null : native(message.replyToId),
    editedAt: null,
  };
}

import type { Message, Peer, PeerSender } from '@mtcute/node';
import type { PeerSnapshot } from '../shared/domain.js';
import type { TelegramChatMigration, TelegramDialog, TelegramMessageInput } from '../shared/ports.js';
import { DomainError } from '../shared/api.js';

export function decimalId(value: number): string {
  if (!Number.isSafeInteger(value) || value === 0) throw new DomainError('validation', 'Unsafe Telegram identifier');
  return String(value);
}
export function peerNumber(value: string): number {
  const n = Number(value);
  if (!/^-?[1-9]\d*$/.test(value) || !Number.isSafeInteger(n)) throw new DomainError('validation', 'Telegram identifier exceeds mtcute safe integer range');
  return n;
}
export function peerSnapshot(peer: PeerSender, observedAt: string): PeerSnapshot {
  if (peer.type === 'anonymous') return { id: null, kind: 'anonymous', names: peer.displayName ? [peer.displayName] : [], usernames: [], visiblePhones: [], visibleEmails: [], observedAt };
  const names = peer.type === 'user' ? [peer.displayName, peer.firstName, peer.lastName] : [peer.title];
  return { id: decimalId(peer.id), kind: peer.type === 'user' ? 'user' : peer.chatType === 'group' ? 'chat' : 'channel', names: [...new Set(names.filter((v): v is string => Boolean(v)))], usernames: [...new Set([peer.username, ...(peer.usernames?.map((u) => u.username) ?? [])].filter((v): v is string => Boolean(v)))], visiblePhones: peer.type === 'user' && peer.phoneNumber ? [peer.phoneNumber] : [], visibleEmails: [], observedAt };
}
// Raw MTProto migration fields carry bare IDs (mtcute 0.32.4 passes them through
// unmarked despite its "marked" docs); store marked IDs like every other chat.
export const markedBasicGroupId = (id: number): string => decimalId(id > 0 ? -id : id);
export const markedSupergroupId = (id: number): string => decimalId(id > 0 ? -1e12 - id : id);
export function normalizeDialog(peer: Peer, archived: boolean): TelegramDialog {
  const migratedToId = peer.type === 'chat' ? peer.migratedToId : null; // basic group already upgraded
  return { id: decimalId(peer.id), kind: peer.type === 'user' ? 'user' : peer.chatType === 'group' ? 'group' : peer.chatType === 'channel' || peer.chatType === 'gigagroup' ? 'channel' : 'supergroup', title: peer.type === 'user' ? peer.displayName : peer.title, username: peer.username, archived,
    ...(migratedToId ? { migratedToId: decimalId(migratedToId) } : {}) };
}
/** Upgrade service messages: the old group's last message and the supergroup's first. */
export function messageMigration(message: Message): TelegramChatMigration {
  const action = message.action;
  return action?.type === 'chat_migrate_to' ? { migratedToId: markedSupergroupId(action.id) }
    : action?.type === 'channel_migrate_from' ? { migratedFromId: markedBasicGroupId(action.id) } : {};
}
export function normalizeMessage(message: Message, observedAt = new Date().toISOString()): TelegramMessageInput {
  let sourceUrl: string | null = null;
  try { sourceUrl = message.link; } catch { /* DMs/basic groups have no supported public permalink. */ }
  const sender = peerSnapshot(message.sender, observedAt), peer = peerSnapshot(message.chat, observedAt);
  const forward = message.forward;
  const original = forward ? peerSnapshot(forward.sender, observedAt) : null;
  const reply = message.replyToMessage;
  return { chatId: decimalId(message.chat.id), id: message.id, senderId: sender.kind === 'user' ? sender.id : null, sender, peer,
    sentAt: message.date.toISOString(), editedAt: message.editDate?.toISOString() ?? null, text: message.text,
    replyToId: reply && (reply.origin === 'same_chat' || reply.chat?.id === message.chat.id) ? reply.id : null,
    sourceUrl,
    forward: forward ? { isForwarded: true, sourceKind: 'forwarded', originPeer: original?.kind === 'anonymous' ? null : original, originName: original?.kind === 'anonymous' ? original.names[0] ?? null : null, originDate: forward.date.toISOString(), originMessageId: forward.fromMessageId }
      : { isForwarded: false, sourceKind: 'own', originPeer: null, originName: null, originDate: null, originMessageId: null },
    ...messageMigration(message),
  };
}

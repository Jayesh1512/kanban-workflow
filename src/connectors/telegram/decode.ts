import { createHash } from 'node:crypto';
import type { ChatRef, MessageRecord, ParticipantRef, TgMessage, TgPeer, TgUser } from '../../contracts/index.ts';
export function participant(user: TgUser): ParticipantRef {
  return { userKey: String(user.id), displayName: user.displayName, handle: user.username };
}
export function nativeId(peer: TgPeer, id: number): string {
  return peer.type === 'channel' || peer.type === 'supergroup' ? `c${peer.id}:${id}` : `u:${id}`;
}
export function chatRef(peer: TgPeer, selfId: number, title: string): ChatRef {
  return {
    key:
      peer.type === 'user'
        ? `u:${Math.min(selfId, peer.id)}:${Math.max(selfId, peer.id)}`
        : peer.type === 'group'
          ? `g:${peer.id}`
          : `c:${peer.id}`,
    nativeId: `${peer.type}:${peer.id}`,
    kind: peer.type === 'user' ? 'direct' : peer.type === 'channel' ? 'broadcast' : 'group',
    title,
  };
}
export function createDecoder(keys = new Map<string, string>()) {
  return (message: TgMessage): MessageRecord | null => {
    if (message.isService) return null;
    const id = nativeId(message.peer, message.id);
    let key = keys.get(id);
    if (key === undefined) {
      key =
        message.peer.type === 'channel' || message.peer.type === 'supergroup'
          ? String(message.id)
          : `${message.sender.id}:${message.date}:${createHash('sha256')
              .update(`${message.text}\n${message.mediaUniqueId}`)
              .digest('hex')
              .slice(0, 16)}`;
      if (id.startsWith('u:')) keys.set(id, key);
    }
    return {
      key,
      nativeId: id,
      cursor: String(message.id),
      sender: participant(message.sender),
      sentAt: new Date(message.date * 1000).toISOString(),
      text: message.text,
      media: message.media,
      replyToNativeId: message.replyToId === null ? null : nativeId(message.peer, message.replyToId),
      editedAt: message.editDate === null ? null : new Date(message.editDate * 1000).toISOString(),
    };
  };
}

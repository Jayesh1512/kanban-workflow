import type { Message, Peer } from '@mtcute/node';
import type { TgMessage, TgPeer, TgUser } from '../../contracts/index.ts';

export function mtPeer(peer: Peer): TgPeer {
  return {
    type:
      peer.type === 'user'
        ? 'user'
        : peer.chatType === 'group'
          ? 'group'
          : peer.chatType === 'channel'
            ? 'channel'
            : 'supergroup',
    id: peer.raw.id,
  };
}
export function mtUser(peer: Peer): TgUser {
  // Anonymous admins/channel posts retain the SDK's marked sender identity, avoiding collisions with user IDs.
  return { id: peer.id, displayName: peer.displayName, username: peer.username };
}
export function mtMessage(message: Message): TgMessage {
  const raw = message.raw;
  const media = message.media;
  let kind: TgMessage['media'] = null;
  if (media) {
    switch (media.type) {
      case 'photo':
      case 'video':
      case 'voice':
      case 'audio':
      case 'document':
      case 'sticker':
      case 'location':
      case 'contact':
      case 'poll':
        kind = media.type;
        break;
      case 'live_location':
      case 'venue':
        kind = 'location';
        break;
      default:
        kind = 'other';
    }
  } else if (raw._ === 'message' && raw.media && raw.media._ !== 'messageMediaEmpty') kind = 'other';
  return {
    id: message.id,
    peer: mtPeer(message.chat),
    sender: mtUser(message.sender),
    date: raw.date,
    text: message.text,
    media: kind,
    mediaUniqueId: media && 'uniqueFileId' in media ? media.uniqueFileId : null,
    replyToId: raw.replyTo?._ === 'messageReplyHeader' ? (raw.replyTo.replyToMsgId ?? null) : null,
    editDate: raw._ === 'message' ? (raw.editDate ?? null) : null,
    isService: message.isService,
  };
}

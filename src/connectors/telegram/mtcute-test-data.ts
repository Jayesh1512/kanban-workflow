import type { tl } from '@mtcute/node';
import { Long, Message, PeersIndex } from '@mtcute/node';

export function sdkData() {
  const users: tl.TypeUser[] = [
    { _: 'user', id: 10, firstName: 'Owner', username: 'owner', accessHash: Long.ONE, self: true },
    { _: 'user', id: 20, firstName: 'Outside', accessHash: Long.ONE },
  ];
  const chats: tl.TypeChat[] = [
    {
      _: 'chat',
      id: 30,
      title: 'Group',
      photo: { _: 'chatPhotoEmpty' },
      participantsCount: 2,
      date: 1800000000,
      version: 1,
    },
    {
      _: 'channel',
      id: 40,
      title: 'Supergroup',
      photo: { _: 'chatPhotoEmpty' },
      date: 1800000000,
      megagroup: true,
      accessHash: Long.ONE,
    },
    {
      _: 'channel',
      id: 50,
      title: 'Channel',
      photo: { _: 'chatPhotoEmpty' },
      date: 1800000000,
      broadcast: true,
      accessHash: Long.ONE,
    },
  ];
  const peers: tl.TypePeer[] = [
    { _: 'peerUser', userId: 20 },
    { _: 'peerChat', chatId: 30 },
    { _: 'peerChannel', channelId: 40 },
    { _: 'peerChannel', channelId: 50 },
  ];
  const messages: tl.RawMessage[] = Array.from({ length: 220 }, (_, n) => ({
    _: 'message',
    id: n + 1,
    peerId: peers[n % 4] as tl.TypePeer,
    fromId: { _: 'peerUser', userId: Math.floor(n / 4) % 2 ? 10 : 20 },
    out: Math.floor(n / 4) % 2 === 1,
    date: 1800000000 + n,
    message: `Synthetic caption ${n}`,
    replyTo: n >= 4 ? { _: 'messageReplyHeader', replyToMsgId: n - 3 } : undefined,
    media:
      n % 11 === 0
        ? {
            _: 'messageMediaContact',
            phoneNumber: 'synthetic',
            firstName: 'Synthetic',
            lastName: '',
            vcard: '',
            userId: 20,
          }
        : undefined,
  }));
  const index = PeersIndex.from({ users, chats });
  const parsed = messages.map((m) => new Message(m, index));
  const dialogs: tl.RawDialog[] = peers.map((peer, n) => ({
    _: 'dialog',
    peer,
    topMessage: 217 + n,
    readInboxMaxId: 0,
    readOutboxMaxId: 0,
    unreadCount: 1,
    unreadMentionsCount: 0,
    unreadReactionsCount: 0,
    unreadPollVotesCount: 0,
    notifySettings: { _: 'peerNotifySettings' },
  }));
  return { users, chats, peers, messages, parsed, index, dialogs };
}

export function sdkMedia(): { media: tl.TypeMessageMedia; kind: string; file: boolean }[] {
  const document = (attributes: tl.TypeDocumentAttribute[]): tl.TypeMessageMedia => ({
    _: 'messageMediaDocument',
    document: {
      _: 'document',
      id: Long.fromNumber(999),
      accessHash: Long.ONE,
      fileReference: new Uint8Array(),
      date: 1800000000,
      mimeType: 'application/octet-stream',
      size: 10,
      dcId: 2,
      attributes,
    },
  });
  const geo: tl.TypeGeoPoint = { _: 'geoPoint', long: 1, lat: 2, accessHash: Long.ONE };
  return [
    {
      media: {
        _: 'messageMediaPhoto',
        photo: {
          _: 'photo',
          id: Long.fromNumber(888),
          accessHash: Long.ONE,
          fileReference: new Uint8Array(),
          date: 1800000000,
          dcId: 2,
          sizes: [{ _: 'photoSize', type: 'x', w: 10, h: 10, size: 10 }],
        },
      },
      kind: 'photo',
      file: true,
    },
    { media: document([{ _: 'documentAttributeVideo', duration: 1, w: 10, h: 10 }]), kind: 'video', file: true },
    { media: document([{ _: 'documentAttributeAudio', duration: 1, voice: true }]), kind: 'voice', file: true },
    { media: document([{ _: 'documentAttributeAudio', duration: 1 }]), kind: 'audio', file: true },
    { media: document([]), kind: 'document', file: true },
    {
      media: document([{ _: 'documentAttributeSticker', alt: 'S', stickerset: { _: 'inputStickerSetEmpty' } }]),
      kind: 'sticker',
      file: true,
    },
    { media: { _: 'messageMediaGeo', geo }, kind: 'location', file: false },
    {
      media: {
        _: 'messageMediaVenue',
        geo,
        title: 'Synthetic',
        address: 'Synthetic',
        provider: '',
        venueId: '',
        venueType: '',
      },
      kind: 'location',
      file: false,
    },
    { media: { _: 'messageMediaGeoLive', geo, period: 60 }, kind: 'location', file: false },
    {
      media: {
        _: 'messageMediaContact',
        phoneNumber: 'synthetic',
        firstName: 'Synthetic',
        lastName: '',
        vcard: '',
        userId: 20,
      },
      kind: 'contact',
      file: false,
    },
    {
      media: {
        _: 'messageMediaPoll',
        poll: {
          _: 'poll',
          id: Long.ONE,
          question: { _: 'textWithEntities', text: 'Synthetic?', entities: [] },
          answers: [],
          hash: Long.ZERO,
        },
        results: { _: 'pollResults' },
      },
      kind: 'poll',
      file: false,
    },
    { media: { _: 'messageMediaDice', value: 1, emoticon: '🎲' }, kind: 'other', file: false },
  ];
}

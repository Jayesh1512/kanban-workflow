/**
 * Link that opens a stored chat in the Telegram app. Built only from our own numeric chat id
 * and a validated public username, never from message text.
 */
export function telegramChatUrl(chat: { id: string; kind: string; username: string | null }, latestMessageId?: number | null): string | null {
  if (chat.username && /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(chat.username)) return `https://t.me/${chat.username}`;
  if (!/^-?\d+$/.test(chat.id)) return null;
  if (chat.kind === 'user') return `tg://openmessage?user_id=${chat.id}`;
  // Marked supergroup/channel ids start with -100; the link needs the id without that prefix.
  if (chat.id.startsWith('-100')) return `https://t.me/c/${chat.id.slice(4)}/${latestMessageId && latestMessageId > 0 ? latestMessageId : 1}`;
  if (chat.id.startsWith('-')) return `tg://openmessage?chat_id=${chat.id.slice(1)}`;
  return null;
}

import { describe, expect, it } from 'vitest';
import { telegramChatUrl } from '../../src/shared/telegram-link.js';

describe('telegramChatUrl', () => {
  it('uses a valid public username first', () => { expect(telegramChatUrl({ id: '123', kind: 'user', username: 'filip_c3' })).toBe('https://t.me/filip_c3'); });
  it('ignores an unsafe or malformed username', () => { expect(telegramChatUrl({ id: '123', kind: 'user', username: 'a/../b' })).toBe('tg://openmessage?user_id=123'); });
  it('opens a direct chat by user id', () => { expect(telegramChatUrl({ id: '987654', kind: 'user', username: null })).toBe('tg://openmessage?user_id=987654'); });
  it('opens a private supergroup at its latest message', () => { expect(telegramChatUrl({ id: '-1001234567890', kind: 'supergroup', username: null }, 42)).toBe('https://t.me/c/1234567890/42'); });
  it('falls back to the first message without a known one', () => { expect(telegramChatUrl({ id: '-1001234567890', kind: 'supergroup', username: null })).toBe('https://t.me/c/1234567890/1'); });
  it('opens a basic group by chat id', () => { expect(telegramChatUrl({ id: '-4455', kind: 'group', username: null })).toBe('tg://openmessage?chat_id=4455'); });
  it('returns nothing for a non-numeric id', () => { expect(telegramChatUrl({ id: 'x', kind: 'user', username: null })).toBeNull(); });
  it('returns nothing for an email thread', () => { expect(telegramChatUrl({ id: '-4000000000000000001', kind: 'email', username: null })).toBeNull(); });
});

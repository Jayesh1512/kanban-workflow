import type { MessageRecord } from './index.ts';

export interface TelegramApi {
  importSession(session: string): Promise<void>;
  exportSession(): Promise<string>;
  sendCode(phone: string): Promise<{ phoneCodeHash: string }>;
  signIn(a: { phone: string; phoneCodeHash: string; code: string }): Promise<TgUser | 'password_needed'>;
  checkPassword(password: string): Promise<TgUser>;
  getMe(): Promise<TgUser>;
  dialogs(o: { offset: string | null; limit: number }): Promise<{ dialogs: TgDialog[]; next: string | null }>;
  history(peer: TgPeer, o: { minId: number; maxId: number; limit: number }): Promise<TgMessage[]>;
  startUpdates(h: {
    onNew(m: TgMessage): Promise<void>;
    onEdit(m: TgMessage): Promise<void>;
    onDelete(d: { ids: number[]; channelId: number | null }): Promise<void>;
    onState(s: 'connected' | 'disconnected' | 'auth_lost'): void;
  }): Promise<void>;
  logOut(): Promise<void>;
  destroy(): Promise<void>;
}

export class TgFloodWait extends Error {
  seconds: number;
  constructor(seconds: number) {
    super('flood wait');
    this.seconds = seconds;
  }
}

export interface TgUser {
  id: number;
  displayName: string;
  username: string | null;
}

export interface TgPeer {
  type: 'user' | 'group' | 'supergroup' | 'channel';
  id: number;
}

export interface TgDialog {
  peer: TgPeer;
  title: string;
  lastMessageId: number | null;
  lastMessageDate: number | null;
}

export interface TgMessage {
  id: number;
  peer: TgPeer;
  sender: TgUser;
  date: number;
  text: string;
  media: MessageRecord['media'];
  mediaUniqueId: string | null;
  replyToId: number | null;
  editDate: number | null;
  isService: boolean;
}

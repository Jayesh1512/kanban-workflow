import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { TelegramApi, TgMessage, TgPeer, TgUser } from '../../contracts/index.ts';
import { AppError, TgDialogSchema, TgFloodWait, TgMessageSchema, TgUserSchema } from '../../contracts/index.ts';

const updateSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('new'), message: TgMessageSchema }).strict(),
  z.object({ type: z.literal('edit'), message: TgMessageSchema }).strict(),
  z
    .object({
      type: z.literal('delete'),
      ids: z.array(z.number().int().positive()),
      channelId: z.number().int().positive().nullable(),
    })
    .strict(),
  z.object({ type: z.literal('state'), state: z.enum(['connected', 'disconnected', 'auth_lost']) }).strict(),
  z.object({ type: z.literal('mark'), name: z.string() }).strict(),
]);
const sessionSchema = z
  .object({
    self: TgUserSchema,
    passwordNeeded: z.boolean().default(false),
    dialogs: z.array(TgDialogSchema),
    messages: z.array(TgMessageSchema),
    updates: z.array(updateSchema),
    failures: z
      .array(z.object({ op: z.enum(['dialogs', 'history']), seconds: z.number().nonnegative() }).strict())
      .default([]),
  })
  .strict();
export type RecordedSession = z.input<typeof sessionSchema>;
export type RecordedCall = {
  op: keyof TelegramApi;
  atMs: number;
  limit?: number;
  offset?: string | null;
  minId?: number;
  maxId?: number;
  peer?: TgPeer;
};
export class RecordedApi implements TelegramApi {
  readonly calls: RecordedCall[] = [];
  private session: z.output<typeof sessionSchema>;
  private now: () => Date;
  private authenticated = false;
  private handlers: Parameters<TelegramApi['startUpdates']>[0] | null = null;
  private position = 0;
  private advancing = false;
  private failures: z.output<typeof sessionSchema>['failures'];
  constructor(source: { path: string } | { session: RecordedSession }, now: () => Date) {
    const parsed = sessionSchema.safeParse(
      'session' in source ? source.session : (JSON.parse(readFileSync(source.path, 'utf8')) as unknown),
    );
    if (!parsed.success) throw new AppError('invalid', 'Invalid synthetic session');
    this.session = structuredClone(parsed.data);
    this.failures = [...this.session.failures];
    this.now = now;
  }
  private record(op: keyof TelegramApi, args: Omit<RecordedCall, 'op' | 'atMs'> = {}) {
    this.calls.push({ op, atMs: this.now().getTime(), ...args });
  }
  private ready() {
    if (!this.authenticated) throw new AppError('unauthenticated', 'Synthetic login required');
  }
  private flood(op: 'dialogs' | 'history') {
    if (this.failures[0]?.op === op) {
      const failure = this.failures.shift();
      if (failure) throw new TgFloodWait(failure.seconds);
    }
  }
  async importSession(session: string) {
    this.record('importSession');
    try {
      const parsed = z
        .object({ v: z.literal(1), selfId: z.number().int() })
        .strict()
        .parse(JSON.parse(session));
      if (parsed.selfId !== this.session.self.id) throw new Error('mismatch');
      this.authenticated = true;
    } catch {
      throw new AppError('unauthenticated', 'Invalid synthetic session token');
    }
  }
  async exportSession() {
    this.record('exportSession');
    this.ready();
    return JSON.stringify({ v: 1, selfId: this.session.self.id });
  }
  async sendCode(_phone: string) {
    this.record('sendCode');
    return { phoneCodeHash: 'synthetic-code-hash' };
  }
  async signIn(a: { phone: string; phoneCodeHash: string; code: string }): Promise<TgUser | 'password_needed'> {
    this.record('signIn');
    if (a.phoneCodeHash !== 'synthetic-code-hash' || a.code !== '12345')
      throw new AppError('unauthenticated', 'Invalid synthetic login code');
    if (this.session.passwordNeeded) return 'password_needed';
    this.authenticated = true;
    return structuredClone(this.session.self);
  }
  async checkPassword(password: string) {
    this.record('checkPassword');
    if (password !== 'synthetic-password') throw new AppError('unauthenticated', 'Invalid synthetic password');
    this.authenticated = true;
    return structuredClone(this.session.self);
  }
  async getMe() {
    this.record('getMe');
    this.ready();
    return structuredClone(this.session.self);
  }
  async dialogs(o: { offset: string | null; limit: number }) {
    this.record('dialogs', o);
    this.ready();
    this.flood('dialogs');
    if (o.limit < 1 || o.limit > 100 || (o.offset !== null && !/^\d+$/.test(o.offset)))
      throw new AppError('invalid', 'Invalid synthetic dialog page');
    const offset = Number(o.offset ?? 0);
    const dialogs = this.session.dialogs.slice(offset, offset + o.limit);
    return {
      dialogs: structuredClone(dialogs),
      next: offset + o.limit < this.session.dialogs.length ? String(offset + o.limit) : null,
    };
  }
  async history(peer: TgPeer, o: { minId: number; maxId: number; limit: number }): Promise<TgMessage[]> {
    this.record('history', { ...o, peer: structuredClone(peer) });
    this.ready();
    this.flood('history');
    if (o.limit < 1 || o.limit > 100) throw new AppError('invalid', 'Invalid synthetic history page');
    return structuredClone(
      this.session.messages
        .filter(
          (m) =>
            m.peer.type === peer.type && m.peer.id === peer.id && m.id > o.minId && (o.maxId === 0 || m.id < o.maxId),
        )
        .sort((a, b) => b.id - a.id)
        .slice(0, o.limit),
    );
  }
  async startUpdates(h: Parameters<TelegramApi['startUpdates']>[0]) {
    this.record('startUpdates');
    this.ready();
    this.handlers = h;
    h.onState('connected');
  }
  async logOut() {
    this.record('logOut');
    this.handlers = null;
    this.authenticated = false;
  }
  async destroy() {
    this.record('destroy');
    this.handlers = null;
  }
  /** Test-only replay control. Stopped sessions never receive queued or future updates. */
  async advanceTo(mark: string) {
    if (this.advancing) throw new AppError('conflict', 'Synthetic advance already active');
    if (mark !== 'end' && !this.session.updates.slice(this.position).some((u) => u.type === 'mark' && u.name === mark))
      throw new AppError('invalid', 'Unknown or passed synthetic mark');
    this.advancing = true;
    try {
      while (this.position < this.session.updates.length) {
        const update = this.session.updates[this.position++];
        if (!update) break;
        if (update.type === 'mark') {
          if (update.name === mark) break;
          continue;
        }
        const h = this.handlers;
        if (!h) continue;
        if (update.type === 'new') await h.onNew(structuredClone(update.message));
        else if (update.type === 'edit') await h.onEdit(structuredClone(update.message));
        else if (update.type === 'delete') await h.onDelete({ ids: [...update.ids], channelId: update.channelId });
        else h.onState(update.state);
      }
    } finally {
      this.advancing = false;
    }
  }
}

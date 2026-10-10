import type { ConnectorContext, TelegramApi, TgMessage } from '../../contracts/index.ts';
import { AppError } from '../../contracts/index.ts';
import { createDecoder } from './decode.ts';

export const sessionPrefix = 'kanban:telegram-session:';
const invalid = () => new AppError('invalid', 'Invalid saved connector session');
const failed = () => new AppError('invalid', 'Connector session persistence failed');
const canonicalNumber = (s: string) => Number.isFinite(Number(s)) && String(Number(s)) === s;

/** Credentials are opaque; validation inspects only the private wrapper and derived identities. */
export function readSession(saved: string) {
  if (!saved.startsWith(sessionPrefix)) return { sdkSession: saved, keys: new Map<string, string>(), legacy: true };
  try {
    const suffix = saved.slice(sessionPrefix.length);
    const value: unknown = JSON.parse(suffix);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const obj = value as Record<string, unknown>;
    if (
      Object.keys(obj).join() !== 'v,sdkSession,keys' ||
      obj.v !== 1 ||
      typeof obj.sdkSession !== 'string' ||
      !obj.sdkSession.length ||
      !Array.isArray(obj.keys)
    )
      throw invalid();
    const keys = new Map<string, string>();
    let previous: string | null = null;
    for (const tuple of obj.keys) {
      if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== 'string' || typeof tuple[1] !== 'string')
        throw invalid();
      const [native, key] = tuple as [string, string];
      if (!native.startsWith('u:') || !canonicalNumber(native.slice(2)) || (previous !== null && native <= previous))
        throw invalid();
      const parts = key.split(':');
      if (
        parts.length !== 3 ||
        !canonicalNumber(parts[0] ?? '') ||
        !canonicalNumber(parts[1] ?? '') ||
        !/^[0-9a-f]{16}$/.test(parts[2] ?? '')
      )
        throw invalid();
      keys.set(native, key);
      previous = native;
    }
    if (suffix !== JSON.stringify({ v: 1, sdkSession: obj.sdkSession, keys: [...keys] })) throw invalid();
    return { sdkSession: obj.sdkSession, keys, legacy: false };
  } catch {
    throw invalid();
  }
}

/** Serializes learning/saving, without holding a lock while the host accepts a delivered message. */
export function createSessionState(ctx: ConnectorContext, api: TelegramApi, onFailure: () => Promise<void>) {
  let saved = ctx.session;
  let restored = false;
  let sdkSession: string | null = null;
  let keys = new Map<string, string>();
  let candidate: Map<string, string> | null = null;
  let failure = false;
  let queue: Promise<unknown> = Promise.resolve();
  function restore() {
    if (restored) return;
    if (saved !== null) {
      const value = readSession(saved);
      sdkSession = value.sdkSession;
      keys = value.keys;
      if (value.legacy) ctx.log('info', 'connector.legacy_session', { accountId: ctx.accountId, retainedKeys: 0 });
    }
    restored = true;
  }
  function healthy() {
    if (failure) throw failed();
  }
  async function latch(): Promise<never> {
    if (!failure) {
      failure = true;
      await onFailure();
    }
    throw failed();
  }
  function serial<T>(run: () => T | Promise<T>, allowFailed = false): Promise<T> {
    const pending = queue.then(() => {
      if (!allowFailed) healthy();
      return run();
    });
    queue = pending.catch(() => {});
    return pending;
  }
  function persist(next: Map<string, string>, opaque: string) {
    candidate = next; // On failure retain the entire candidate; recovery requires explicit authoritative recreation.
    if (!opaque.length) throw failed();
    const entries = [...next].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const envelope = sessionPrefix + JSON.stringify({ v: 1, sdkSession: opaque, keys: entries });
    ctx.saveSession(envelope); // Synchronous atomic replacement or throw; never acknowledge first.
    saved = envelope;
    sdkSession = opaque;
    keys = next;
    candidate = null;
  }
  return {
    restore,
    healthy,
    isFailed: () => failure,
    opaque() {
      restore();
      healthy();
      return sdkSession;
    },
    async learn(messages: TgMessage[], valid: () => boolean) {
      return serial(async () => {
        if (!valid()) throw new AppError('invalid', 'Connector stopped');
        restore();
        try {
          const next = new Map(keys);
          const decode = createDecoder(next);
          const records = messages.map(decode).filter((m) => m !== null);
          if (next.size !== keys.size) {
            if (sdkSession === null) throw failed();
            persist(next, sdkSession);
          }
          return records;
        } catch {
          return latch();
        }
      });
    },
    async save(valid: () => boolean = () => true) {
      healthy();
      let opaque: string;
      try {
        opaque = await api.exportSession();
      } catch {
        return serial(() => latch());
      }
      // Read keys here, AFTER export: concurrent live/history learning must not be overwritten.
      return serial(async () => {
        if (!valid()) throw new AppError('invalid', 'Connector stopped');
        restore();
        try {
          persist(new Map(keys), opaque);
        } catch {
          return latch();
        }
      });
    },
    async clear() {
      return serial(async () => {
        try {
          ctx.saveSession(null);
          saved = null;
          sdkSession = null;
          keys.clear();
          candidate = null;
          restored = true;
          failure = false;
        } catch {
          return latch();
        }
      }, true);
    },
    // Deliberately private instance state; never logged or exported to a client.
    failedCandidate: () => candidate,
  };
}

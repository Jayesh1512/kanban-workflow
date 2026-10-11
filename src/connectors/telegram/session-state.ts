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
  let token = 0;
  let terminal = false;
  let cleanup: Promise<void> | null = null;
  const faults = new Map<number, AppError>();
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
  function latch(): never {
    if (!failure) {
      failure = true;
      faults.set(token, failed());
      cleanup = Promise.resolve(onFailure());
      void cleanup.catch(() => {});
    }
    throw failed();
  }
  function serial<T>(run: (current: () => boolean) => T, allowFailed = false): Promise<T> {
    const admission = token;
    const current = () => admission === token && !terminal;
    const pending = queue.then(() => {
      if (!allowFailed) healthy();
      if (!current()) throw new AppError('invalid', 'Connector stopped');
      return run(current);
    });
    queue = pending.catch(() => {});
    return pending;
  }
  function persist(next: Map<string, string>, opaque: string, current: () => boolean) {
    candidate = next; // On failure retain the entire candidate; recovery requires explicit authoritative recreation.
    if (!opaque.length) throw failed();
    const entries = [...next].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const envelope = sessionPrefix + JSON.stringify({ v: 1, sdkSession: opaque, keys: entries });
    ctx.saveSession(envelope); // Synchronous atomic replacement or throw; never acknowledge first.
    if (!current()) {
      candidate = null;
      throw new AppError('invalid', 'Connector stopped');
    }
    saved = envelope;
    sdkSession = opaque;
    keys = next;
    candidate = null;
  }
  return {
    restore,
    healthy,
    guard() {
      const admission = token;
      return () => {
        const error = faults.get(admission);
        if (error) throw error;
      };
    },
    isFailed: () => failure,
    opaque() {
      restore();
      healthy();
      return sdkSession;
    },
    async learn(messages: TgMessage[], valid: () => boolean) {
      return serial((current) => {
        if (!valid()) throw new AppError('invalid', 'Connector stopped');
        restore();
        try {
          const next = new Map(keys);
          const decode = createDecoder(next);
          const records = messages.map(decode).filter((m) => m !== null);
          if (next.size !== keys.size) {
            if (sdkSession === null) throw failed();
            persist(next, sdkSession, () => current() && valid());
          }
          return records;
        } catch {
          if (!current() || !valid()) throw new AppError('invalid', 'Connector stopped');
          return latch();
        }
      });
    },
    async save(valid: () => boolean = () => true) {
      const admission = token;
      healthy();
      if (terminal || !valid()) throw new AppError('invalid', 'Connector stopped');
      let opaque: string;
      try {
        opaque = await api.exportSession();
      } catch {
        return serial(() => {
          // A late canceled export must not fault a stopped or successfully cleared session.
          if (admission !== token || terminal || !valid()) throw new AppError('invalid', 'Connector stopped');
          return latch();
        });
      }
      if (admission !== token || terminal) throw new AppError('invalid', 'Connector stopped');
      // Read keys here, AFTER export: concurrent live/history learning must not be overwritten.
      return serial((current) => {
        if (!valid()) throw new AppError('invalid', 'Connector stopped');
        restore();
        try {
          persist(new Map(keys), opaque, () => current() && valid());
        } catch {
          if (!current() || !valid()) throw new AppError('invalid', 'Connector stopped');
          return latch();
        }
      });
    },
    barrier() {
      const snapshot = { saved, error: failure ? failed() : null, cleanup };
      terminal = true;
      ++token;
      queue = Promise.resolve(); // Async old fault cleanup never owns this synchronous lane.
      return snapshot;
    },
    invalidate() {
      ++token;
      queue = Promise.resolve();
    },
    async clear() {
      const admission = token;
      return queue.then(() => {
        if (admission !== token) throw new AppError('invalid', 'Connector stopped');
        try {
          ctx.saveSession(null);
          if (admission !== token) throw new AppError('invalid', 'Connector stopped');
          saved = null;
          sdkSession = null;
          keys = new Map();
          candidate = null;
          restored = true;
          failure = false;
        } catch {
          if (admission === token) failure = true;
          throw failed();
        }
      });
    },
    finish() {
      terminal = false;
      ++token;
      queue = Promise.resolve();
    },
    // Deliberately private instance state; never logged or exported to a client.
    failedCandidate: () => candidate,
  };
}

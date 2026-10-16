import { AsyncLocalStorage } from 'node:async_hooks';
import type { QueryResultRow } from 'pg';
import type { Database, SqlExecutor } from '../../src/shared/ports.js';

/** Deterministic scheduling/signal model ONLY. This is not proof of PostgreSQL locks/session loss. */
export function schedulingDatabase(base: Database) {
  const context = new AsyncLocalStorage<{ keys: Set<string>; controller: AbortController }>();
  const locks = new Map<string, Promise<void>>();
  const check = () => context.getStore()?.controller.signal.throwIfAborted();
  const guarded: SqlExecutor = { async query<R extends QueryResultRow>(text: string, values?: unknown[]) { check(); const result = await base.query<R>(text, values); check(); return result; } };
  const db: Database = {
    ...guarded,
    async transaction(work) { check(); return base.transaction(async (tx) => { const scoped: SqlExecutor = { async query<R extends QueryResultRow>(text: string, values?: unknown[]) { check(); const result = await tx.query<R>(text, values); check(); return result; } }; const value = await work(scoped); check(); return value; }); },
    async withSessionLock(key, work) {
      check(); const existing = context.getStore(); if (existing?.keys.has(key)) return work(guarded, existing.controller.signal);
      const previous = locks.get(key) ?? Promise.resolve(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const tail = previous.then(() => gate); locks.set(key, tail);
      await previous; check();
      const scope = existing ?? { keys: new Set<string>(), controller: new AbortController() }; scope.keys.add(key);
      try { return await context.run(scope, () => work(guarded, scope.controller.signal)); }
      finally { scope.keys.delete(key); if (!existing) scope.controller.abort(new Error('Deterministic session closed')); release(); if (locks.get(key) === tail) locks.delete(key); }
    },
    async close() { await base.close(); },
  };
  return { db, disconnect() { const scope = context.getStore(); if (!scope) throw new Error('No deterministic session'); scope.controller.abort(new Error('Deterministic connection loss')); } };
}

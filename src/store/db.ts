import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { AgentWorkScope, Db, SqlValue } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new DatabaseSync(path);
  let depth = 0;
  let boundary = false;
  let delivering = false;
  let closing = false;
  let closed = false;
  let fault: AppError | undefined;
  let hasLoss = false;
  let loss: unknown;
  const cleanup = new Map<'state' | 'rollback' | 'close', AppError>();
  const registrations = new Set<{ scope: AgentWorkScope; controller: AbortController }>();
  const pending = new Set<AbortController>();
  const abort = AbortController.prototype.abort;
  const controllerSignal = Object.getOwnPropertyDescriptor(AbortController.prototype, 'signal')?.get;
  const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;

  function nativeState(): 'idle' | 'active' | 'retired' | 'unknown' {
    try {
      const open = sqlite.isOpen;
      if (open === false) return 'retired';
      if (open !== true) return 'unknown';
      const active = sqlite.isTransaction;
      return active === true ? 'active' : active === false ? 'idle' : 'unknown';
    } catch {
      if (!cleanup.has('state')) cleanup.set('state', new AppError('invalid', 'Database state inspection failed'));
      return 'unknown';
    }
  }
  function captureAll() {
    for (const registration of registrations) pending.add(registration.controller);
  }
  function latchFault() {
    fault ??= new AppError('invalid', 'Database is faulted; close and restart required');
    captureAll();
    return fault;
  }
  function rollback() {
    try {
      sqlite.exec('ROLLBACK');
    } catch {
      if (!cleanup.has('rollback'))
        cleanup.set('rollback', new AppError('invalid', 'Database rollback cleanup failed'));
    }
  }
  function closeNative() {
    try {
      sqlite.close();
    } catch {
      if (!cleanup.has('close')) cleanup.set('close', new AppError('invalid', 'Database close cleanup failed'));
    }
  }
  // One attempt per boundary. Fault retirement precedes every listener, even on a post-effect close throw.
  function retireFailure() {
    let state = nativeState();
    if (state === 'active' || state === 'unknown') {
      rollback();
      state = nativeState();
    }
    if (state === 'active' || state === 'unknown') latchFault();
    if (fault && state !== 'retired') {
      closeNative();
      state = nativeState();
    }
    return state;
  }
  function flushAgentAborts() {
    if (depth > 0 || boundary || delivering) return;
    const state = nativeState();
    if (fault ? state !== 'retired' : state !== 'idle' && state !== 'retired') return;
    delivering = true;
    try {
      while (pending.size > 0) {
        const batch = [...pending];
        pending.clear();
        for (const controller of batch) {
          for (const registration of registrations) {
            if (registration.controller === controller) registrations.delete(registration);
          }
          abort.call(controller);
        }
      }
    } finally {
      delivering = false;
    }
  }
  function unexpectedState(): never {
    const error = latchFault();
    boundary = true;
    try {
      retireFailure();
    } finally {
      boundary = false;
    }
    flushAgentAborts();
    throw error;
  }
  function fence() {
    if (fault) throw fault;
    if (closed) throw new AppError('invalid', 'Database is closed');
    if (closing || delivering || (boundary && depth === 0)) {
      throw new AppError('invalid', 'Database boundary is active');
    }
    if (hasLoss) throw loss;
    const state = nativeState();
    if (depth === 0 ? state !== 'idle' : state !== 'active') {
      if (depth > 0) {
        hasLoss = true;
        loss = new AppError('invalid', 'Database transaction was lost');
        throw loss;
      }
      unexpectedState();
    }
  }
  function statement<T>(work: () => T): T {
    fence();
    let result: T | undefined;
    let primary: unknown;
    let hasPrimary = false;
    try {
      result = work();
    } catch (error) {
      hasPrimary = true;
      primary = error;
    }
    const state = nativeState();
    if (depth > 0 && state !== 'active' && !hasLoss) {
      hasLoss = true;
      loss = hasPrimary ? primary : new AppError('invalid', 'Database transaction was lost');
    } else if (depth === 0 && state !== 'idle') {
      latchFault();
      boundary = true;
      try {
        retireFailure();
      } finally {
        boundary = false;
      }
      flushAgentAborts();
    }
    if (hasPrimary) throw primary;
    if (fault) throw fault;
    if (hasLoss) throw loss;
    return result as T;
  }
  function copyScope(scope: AgentWorkScope, message: string): AgentWorkScope {
    if (
      !scope ||
      !Array.isArray(scope.chatIds) ||
      !Array.isArray(scope.messageIds) ||
      scope.chatIds.length + scope.messageIds.length === 0 ||
      [...scope.chatIds, ...scope.messageIds].some((id) => !Number.isSafeInteger(id) || id <= 0)
    ) {
      throw new AppError('invalid', message);
    }
    return {
      chatIds: [...new Set(scope.chatIds)].sort((a, b) => a - b),
      messageIds: [...new Set(scope.messageIds)].sort((a, b) => a - b),
    };
  }
  function queue(controller: AbortController) {
    pending.add(controller);
    if (depth > 0 || boundary || delivering) return;
    const state = nativeState();
    if (!fault && state !== 'idle' && state !== 'retired') unexpectedState();
    flushAgentAborts();
  }

  // Initialization owns the entire native lifetime, including failures before the migration loop.
  try {
    sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;');
    sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migration (name TEXT PRIMARY KEY) STRICT');
    const migrations = fileURLToPath(new URL('./migrations/', import.meta.url));
    for (const name of readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      if (sqlite.prepare('SELECT name FROM schema_migration WHERE name=?').get(name)) continue;
      sqlite.exec('BEGIN IMMEDIATE');
      sqlite.exec(readFileSync(`${migrations}/${name}`, 'utf8'));
      sqlite.prepare('INSERT INTO schema_migration(name) VALUES (?)').run(name);
      sqlite.exec('COMMIT');
    }
    if (nativeState() !== 'idle') throw latchFault();
  } catch (primary) {
    const state = nativeState();
    if (state === 'active' || state === 'unknown') rollback();
    if (nativeState() !== 'retired') closeNative();
    if (nativeState() !== 'retired') latchFault();
    throw primary;
  }
  return {
    get<T>(sql: string, ...params: SqlValue[]): T | undefined {
      return statement(() => sqlite.prepare(sql).get(...params) as T | undefined);
    },
    all<T>(sql: string, ...params: SqlValue[]): T[] {
      return statement(() => sqlite.prepare(sql).all(...params) as T[]);
    },
    run(sql: string, ...params: SqlValue[]) {
      return statement(() => {
        if (/^\s*(INSERT|UPDATE|DELETE)\s+(INTO\s+)?action_log\b/i.test(sql) && depth === 0) {
          throw new Error('action log writes require Db.tx');
        }
        try {
          const result = sqlite.prepare(sql).run(...params);
          return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
        } catch (error) {
          if (error instanceof Error && 'errcode' in error) {
            if (error.errcode === 2067 || error.errcode === 1555)
              throw new AppError('conflict', 'Conflicting stored value');
            if (error.errcode === 787) throw new AppError('invalid', 'Invalid reference (FOREIGN KEY)');
            if (error.errcode === 1299 || error.errcode === 275) throw new AppError('invalid', 'Invalid stored value');
          }
          throw error;
        }
      });
    },
    tx<T>(fn: () => T): T {
      fence();
      if (fn.constructor.name === 'AsyncFunction') throw new Error('Db.tx requires a synchronous callback');
      if (depth > 0) {
        const result = fn();
        if (result instanceof Promise) throw new Error('Db.tx requires a synchronous callback');
        fence();
        return result;
      }
      boundary = true;
      let result: T | undefined;
      let primary: unknown;
      let hasPrimary = false;
      try {
        sqlite.exec('BEGIN IMMEDIATE');
        if (nativeState() !== 'active') throw latchFault();
        depth = 1;
        result = fn();
        if (result instanceof Promise) throw new Error('Db.tx requires a synchronous callback');
        if (hasLoss) throw loss;
        if (nativeState() !== 'active') throw latchFault();
        sqlite.exec('COMMIT');
        if (nativeState() !== 'idle') throw latchFault();
      } catch (error) {
        hasPrimary = true;
        primary = error;
        retireFailure();
      } finally {
        depth = 0;
        boundary = false;
        hasLoss = false;
        loss = undefined;
      }
      // Delivery is deliberately outside the SQL catch: it cannot roll back a committed transaction.
      flushAgentAborts();
      if (hasPrimary) throw primary;
      if (fault) throw fault;
      return result as T;
    },
    registerAgentCancellation(scope, controller) {
      if (fault) throw fault;
      if (closed) throw new AppError('invalid', 'Database is closed');
      if (depth > 0 || boundary || closing || delivering) {
        throw new AppError('invalid', 'Agent cancellation registration requires an idle transaction boundary');
      }
      fence();
      const message = 'Invalid agent cancellation registration';
      const copied = copyScope(scope, message);
      try {
        if (!controllerSignal || !signalAborted || signalAborted.call(controllerSignal.call(controller))) {
          throw new Error();
        }
      } catch {
        throw new AppError('invalid', message);
      }
      const registration = { scope: copied, controller };
      registrations.add(registration);
      return {
        release() {
          registrations.delete(registration);
        },
        cancel() {
          queue(controller);
        },
      };
    },
    invalidateAgentWork(scope) {
      fence();
      const copied = copyScope(scope, 'Invalid agent invalidation scope');
      for (const registration of registrations) {
        if (
          copied.chatIds.some((id) => registration.scope.chatIds.includes(id)) ||
          copied.messageIds.some((id) => registration.scope.messageIds.includes(id))
        ) {
          pending.add(registration.controller);
        }
      }
      flushAgentAborts();
    },
    close() {
      if (depth > 0 || boundary || delivering || closing) {
        if (fault) throw fault;
        throw new AppError('invalid', 'Database boundary is active');
      }
      if (fault) {
        boundary = true;
        let state: ReturnType<typeof nativeState>;
        try {
          state = retireFailure();
        } finally {
          boundary = false;
        }
        flushAgentAborts();
        if (state !== 'retired') throw fault;
        return;
      }
      if (closed) return;
      fence();
      closing = true;
      captureAll();
      flushAgentAborts();
      let hasPrimary = false;
      let primary: unknown;
      try {
        sqlite.close();
      } catch (error) {
        hasPrimary = true;
        primary = error;
        latchFault();
      }
      if (nativeState() !== 'retired') latchFault();
      closed = !fault;
      closing = false;
      if (hasPrimary) throw primary;
      if (fault) throw fault;
    },
  };
}

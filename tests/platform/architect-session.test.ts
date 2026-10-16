import { EventEmitter } from 'node:events';
import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PgDatabase } from '../../src/platform/database.js';

class ProbeClient extends EventEmitter {
  readonly statements: string[] = [];
  readonly release = vi.fn();
  async query<R extends QueryResultRow>(text: string): Promise<QueryResult<R>> {
    this.statements.push(text);
    return { rows: [], rowCount: 0, fields: [], command: 'SELECT', oid: 0 };
  }
}
function harness() {
  const db = new PgDatabase('postgresql://unused:unused@127.0.0.1:1/unused');
  const clients: ProbeClient[] = [];
  const connect = vi.fn(async () => { const client = new ProbeClient(); clients.push(client); return client; });
  const direct = vi.fn(async () => { throw new Error('Unexpected extra pool borrower'); });
  Object.defineProperty(db.pool, 'connect', { value: connect });
  Object.defineProperty(db.pool, 'query', { value: direct });
  return { db, clients, connect, direct };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('architect session scope regressions (controlled client, no real connections)', () => {
  it('reuses one client for nested SQL, short transactions and reentrant lock calls', async () => {
    const h = harness();
    try {
      await h.db.withSessionLock('ticket:one', async (session, signal) => {
        await h.db.query('SELECT outer');
        await h.db.transaction(async (tx) => { await tx.query('SELECT transaction'); await h.db.query('SELECT nested'); });
        await h.db.withSessionLock('ticket:one', async (nested, nestedSignal) => {
          expect(nested).toBe(session); expect(nestedSignal).toBe(signal);
          await nested.query('SELECT reentrant');
        });
      });
      expect(h.connect).toHaveBeenCalledTimes(1); expect(h.direct).not.toHaveBeenCalled();
      expect(h.clients[0]!.statements.filter((s) => s.startsWith('SELECT pg_advisory_lock('))).toHaveLength(1);
      expect(h.clients[0]!.statements).toContain('COMMIT');
      expect(h.clients[0]!.release).toHaveBeenCalledWith(false);
    } finally { await h.db.close(); }
  });
  it('rejects connection loss, aborts work and permanently fences every late nested operation', async () => {
    const h = harness(), entered = deferred(), resume = deferred(), lateFinished = deferred();
    let signal: AbortSignal | undefined;
    const failures: unknown[] = [];
    try {
      const work = h.db.withSessionLock('ticket:lost', async (session, currentSignal) => {
        signal = currentSignal; entered.resolve(); await resume.promise;
        const attempts = [() => session.query('SELECT stale direct'), () => h.db.query('SELECT stale nested'),
          () => h.db.transaction(async (tx) => { await tx.query('SELECT stale transaction'); }),
          () => h.db.withSessionLock('ticket:lost', async (sql) => { await sql.query('SELECT stale lock'); })];
        for (const attempt of attempts) {
          try { await attempt(); } catch (error) { failures.push(error); }
        }
        lateFinished.resolve();
      });
      const rejected = expect(work).rejects.toMatchObject({ code: 'upstream_unavailable' });
      await entered.promise;
      h.clients[0]!.emit('error', new Error('private upstream detail must be sanitized'));
      await rejected;
      expect(signal?.aborted).toBe(true);
      expect(h.clients[0]!.release).toHaveBeenCalledWith(true);
      resume.resolve(); await lateFinished.promise;
      expect(failures).toHaveLength(4);
      expect(failures.every((e) => e instanceof Error && !e.message.includes('private upstream'))).toBe(true);
      expect(h.connect).toHaveBeenCalledTimes(1);
      expect(h.clients[0]!.statements.some((s) => s.includes('stale'))).toBe(false);
      await h.db.withSessionLock('ticket:lost', async (sql) => { await sql.query('SELECT fresh attempt'); });
      expect(h.connect).toHaveBeenCalledTimes(2);
    } finally { resume.resolve(); await h.db.close(); }
  });
  it('rejects use after successful scope closure and refuses remote lock entry inside a transaction', async () => {
    const h = harness(), resume = deferred();
    let late: Promise<unknown> | undefined;
    try {
      await h.db.withSessionLock('ticket:closed', async () => {
        late = (async () => { await resume.promise; return h.db.withSessionLock('ticket:closed', async () => {}); })();
        await h.db.transaction(async () => {
          await expect(h.db.withSessionLock('ticket:closed', async () => {})).rejects.toMatchObject({ code: 'conflict' });
        });
      });
      const rejected = expect(late).rejects.toMatchObject({ code: 'conflict' });
      resume.resolve(); await rejected;
      expect(h.connect).toHaveBeenCalledTimes(1);
    } finally { resume.resolve(); await h.db.close(); }
  });
});

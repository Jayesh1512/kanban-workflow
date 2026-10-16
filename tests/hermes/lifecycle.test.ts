import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { lifecycleHarness, until } from './lifecycle-fixture.js';
import { connectClient } from './client.js';

describe('actual app.close begins workflow shutdown before HTTP drain', () => {
  it.each(['mcp', 'http'] as const)('closes an active %s request without client abort and keeps DB until held domain completion', async (transport) => {
    const h = await lifecycleHarness({ hold: true }); let finished = false;
    const request = transport === 'mcp' ? h.client.callTool({ name: 'list_companies', arguments: { limit: 1 } }).catch(() => null) : fetch(`${h.url}/api/companies?limit=1`).then((r) => r.json());
    let closing: Promise<void> | null = null;
    try {
      await h.entered.promise; closing = h.app.close().then(() => { finished = true; });
      await until(() => !h.subscribed()); const count = h.phases();
      const first = h.workflow.stop(), repeated = h.workflow.stop(); expect(repeated).toBe(first);
      let repeatedFinished = false; void repeated.then(() => { repeatedFinished = true; });
      // More than one full scheduler interval; it must not begin another phase.
      await delay(1100); expect(h.phases()).toBe(count); expect(finished).toBe(false); expect(repeatedFinished).toBe(false); expect(h.closed()).toBe(false);
      h.release.resolve(); await Promise.race([closing, delay(2000).then(() => { throw new Error('app.close still blocked after domain completion'); })]);
      await request; await first; expect(h.events.indexOf('domain_complete')).toBeLessThan(h.events.indexOf('db_closed')); expect(h.closed()).toBe(true);
      expect(h.workflow.stop()).toBe(first);
    } finally { h.release.resolve(); await h.client.close(); await closing?.catch(() => {}); await h.app.close().catch(() => {}); }
  });
  it('closes normally after a completed SDK call and repeated close/stop stays idempotent', async () => {
    const h = await lifecycleHarness();
    try {
      expect((await h.client.callTool({ name: 'list_companies', arguments: { limit: 1 } })).isError).not.toBe(true);
      const count = h.phases(); await h.app.close(); await h.app.close(); await h.workflow.stop(); expect(h.phases()).toBe(count); expect(h.events.filter((e) => e === 'db_closed')).toHaveLength(1); expect(h.events.filter((e) => e === 'unsubscribed')).toHaveLength(1);
    } finally { await h.client.close(); await h.app.close(); }
  });
  it('repeated stop shares rejection after still draining captured work when cleanup fails', async () => {
    const h = await lifecycleHarness({ hold: true, failUnsubscribe: true });
    const request = h.client.callTool({ name: 'list_companies', arguments: { limit: 1 } }).catch(() => null);
    try {
      await h.entered.promise; const first = h.workflow.stop(); const outcome = first.catch((error: unknown) => error); expect(h.workflow.stop()).toBe(first);
      await delay(10); expect(h.closed()).toBe(false); h.release.resolve(); expect(await outcome).toBeInstanceOf(AggregateError); await request;
      await expect(h.workflow.stop()).rejects.toBeInstanceOf(AggregateError); expect(h.events).toContain('domain_complete');
      await expect(h.app.close()).rejects.toBeInstanceOf(AggregateError); expect(h.closed()).toBe(true);
      expect(h.events.indexOf('domain_complete')).toBeLessThan(h.events.indexOf('db_closed'));
    } finally { h.release.resolve(); await h.client.close(); await h.app.close().catch(() => {}); }
  });
  it('SIGTERM through app.close drains a real SDK child request and exits without client abort', async () => {
    const child = fork(fileURLToPath(new URL('./lifecycle-child.ts', import.meta.url)), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const events: string[] = []; let url: string | null = null, exited = false, code: number | null = null, stderr = '';
    child.on('message', (raw) => { const value = raw as { event: string; url?: string }; events.push(value.event); if (value.url) url = value.url; });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('exit', (value) => { exited = true; code = value; });
    let client: Awaited<ReturnType<typeof connectClient>> | null = null;
    try {
      await until(() => url !== null); client = await connectClient(url!);
      const request = client.callTool({ name: 'list_companies', arguments: { limit: 1 } }).catch(() => null); await until(() => events.includes('domain_entered'));
      child.kill('SIGTERM'); await until(() => events.includes('unsubscribed'));
      const count = events.filter((e) => e === 'scheduler_phase').length;
      await delay(1100); expect(events.filter((e) => e === 'scheduler_phase')).toHaveLength(count); expect(events).not.toContain('db_closed'); expect(exited).toBe(false);
      child.send('release'); await until(() => exited); await request;
      expect(code).toBe(0); expect(stderr).toBe(''); expect(events).toContain('app_closed');
      expect(events.indexOf('domain_complete')).toBeLessThan(events.indexOf('db_closed'));
      expect(events.filter((e) => e === 'db_closed')).toHaveLength(1);
    } finally { if (!exited) { child.kill('SIGKILL'); await new Promise<void>((resolve) => child.once('exit', () => resolve())); } await client?.close(); }
  });

});

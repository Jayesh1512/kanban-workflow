import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { testApp } from '../../test/harness.ts';
import { createCredential, revokeCredential } from '../auth/index.ts';
import { configureWorkflow } from '../board/index.ts';
import type { WorkflowTicket } from '../contracts/index.ts';

test('official MCP SDK transport reads and writes real workflow with scoped synthetic credentials', {
  timeout: 10000,
}, async () => {
  const h = await testApp({ teammates: [{ username: 'ravi' }] });
  const clients: Client[] = [];
  try {
    const ctx = h.ctxFor('ravi');
    configureWorkflow(ctx);
    const connect = async (token: string) => {
      const c = new Client(
        { name: 'synthetic-hermis-sdk-proof', version: '1.0.0' },
        { versionNegotiation: { mode: 'auto' } },
      );
      const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8787/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: async (url, init) => h.app.fetch(new Request(String(url), init)),
      });
      clients.push(c);
      await c.connect(transport);
      return c;
    };
    const writerCredential = createCredential(ctx, {
      name: 'synthetic-hermis-writer',
      scopeMessages: false,
      scopeWrite: true,
    });
    const writer = await connect(writerCredential.token);
    const tools = await writer.listTools();
    assert.deepEqual(
      tools.tools.map((t) => t.name).sort(),
      [
        'get_company',
        'get_board',
        'list_tickets',
        'get_ticket',
        'get_daily_priorities',
        'create_ticket',
        'update_ticket',
        'move_ticket',
      ].sort(),
    );
    const call = async (c: Client, name: string, args: Record<string, unknown>) =>
      c.callTool({ name, arguments: args });
    const created = await call(writer, 'create_ticket', {
      title: 'Dap Looker',
      workstream: 'buyer',
      nextAction: 'Follow up Monday',
      followUpAt: '2026-10-19T09:00:00+05:30',
    });
    assert.equal(created.isError, undefined);
    const ticket = (created.structuredContent as { result: WorkflowTicket }).result;
    assert.equal(ticket.workflowStage, 'to_be_started');
    assert.equal(ticket.card.lastChangeBy, 'credential');
    assert.equal((await call(writer, 'get_board', {})).isError, undefined);
    assert.equal((await call(writer, 'get_ticket', { cardId: ticket.card.id })).isError, undefined);
    assert.equal((await call(writer, 'get_daily_priorities', { at: '2026-10-19T00:00:00Z' })).isError, undefined);
    assert.equal(
      (
        await call(writer, 'update_ticket', {
          cardId: ticket.card.id,
          version: ticket.version,
          buyerId: 'buyer-reference',
        })
      ).isError,
      undefined,
    );
    assert.equal(
      (
        await call(writer, 'move_ticket', {
          cardId: ticket.card.id,
          version: ticket.version,
          to: 'completed',
          reason: 'Stale must fail',
        })
      ).isError,
      true,
    );
    const listed = await call(writer, 'list_tickets', { workstream: 'buyer' });
    const latest = (listed.structuredContent as { result: WorkflowTicket[] }).result[0];
    assert.ok(latest);
    const moved = await call(writer, 'move_ticket', {
      cardId: latest.card.id,
      version: latest.version,
      to: 'archive',
      reason: 'Explicit unwanted work',
    });
    assert.equal((moved.structuredContent as { result: WorkflowTicket }).result.workflowStage, 'archive');
    const readerCredential = createCredential(ctx, { name: 'synthetic-reader', scopeMessages: false });
    const reader = await connect(readerCredential.token);
    assert.equal((await call(reader, 'list_tickets', {})).isError, undefined);
    assert.equal((await call(reader, 'create_ticket', { title: 'Forbidden' })).isError, true);
    const bad = await call(writer, 'create_ticket', { title: 'Strict args', fake: true });
    assert.equal(bad.isError, true);
    revokeCredential(ctx, writerCredential.id);
    await assert.rejects(() => call(writer, 'create_ticket', { title: 'Revoked' }));
    assert.equal(h.db.all('SELECT id FROM card').length, 1);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    h.close();
  }
});

test('MCP scopeMessages protects quoted workflow blocker evidence and history while text-scoped credentials can read it', {
  timeout: 10000,
}, async (t) => {
  const { workflowFixture } = await import('../../test/workflow-support.ts');
  const h = await workflowFixture(t);
  assert.ok(h.ticket);
  await h.deliver('blocked');
  await h.app.pipeline.drain();
  const clients: Client[] = [];
  try {
    for (const scopeMessages of [false, true]) {
      const credential = createCredential(h.ctx, { name: `synthetic-scope-${scopeMessages}`, scopeMessages });
      const c = new Client({ name: 'synthetic-scope-sdk', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      clients.push(c);
      await c.connect(
        new StreamableHTTPClientTransport(new URL(`${h.config.origin}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${credential.token}` } },
          fetch: async (url, init) => h.app.fetch(new Request(String(url), init)),
        }),
      );
      for (const name of ['get_board', 'list_tickets', 'get_ticket', 'get_daily_priorities']) {
        const result = await c.callTool({ name, arguments: name === 'get_ticket' ? { cardId: h.ticket.card.id } : {} });
        assert.equal(result.isError, undefined);
        if (scopeMessages) assert.match(JSON.stringify(result), /PRIVATE_WORKFLOW_BLOCKER_MARKER/);
        else assert.doesNotMatch(JSON.stringify(result), /PRIVATE_WORKFLOW_BLOCKER_MARKER/);
      }
    }
  } finally {
    await Promise.all(clients.map((c) => c.close()));
  }
});

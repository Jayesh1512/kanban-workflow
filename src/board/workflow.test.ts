import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testApp } from '../../test/harness.ts';
import { getSetting } from '../auth/index.ts';
import {
  archiveCard,
  configureWorkflow,
  createCard,
  createLane,
  createWorkflowTicket,
  getDailyPriorities,
  getWorkflowBoard,
  getWorkflowTicket,
  moveCard,
  moveWorkflowTicket,
  updateWorkflowTicket,
} from './index.ts';

test('opt-in idempotent workflow preserves generic lanes, archived cards and global policy', async () => {
  const t = await testApp({ teammates: [{ username: 'ravi' }] });
  try {
    const ctx = t.ctxFor('ravi');
    const l = createLane(ctx, {
      name: 'Existing',
      sop: 'Existing SOP',
      stages: [
        { name: 'Start', criteria: '' },
        { name: 'End', criteria: '' },
      ],
    });
    const old = createCard(ctx, { laneId: l.id, title: 'Old lead' });
    archiveCard(ctx, old.id);
    assert.equal(getWorkflowBoard(ctx).lane, null);
    const b = configureWorkflow(ctx);
    assert.equal(configureWorkflow(ctx).lane?.id, b.lane?.id);
    assert.equal(t.db.all('SELECT id FROM lane').length, 2);
    assert.equal(t.db.all('SELECT id FROM card WHERE archived_at IS NOT NULL').length, 1);
    assert.equal(getSetting(t.db, 'review_threshold'), 1);
    assert.deepEqual(
      b.stages.map((s) => s.key),
      ['to_be_started', 'work_in_progress', 'integrations', 'blocked', 'completed', 'archive'],
    );
    assert.equal(b.automatic, true);
    assert.equal(b.confidenceThreshold, 0.85);
    const c = createWorkflowTicket(ctx, { title: 'Dap Looker', workstream: 'buyer', nextAction: 'Send outreach' });
    assert.equal(c.workflowStage, 'to_be_started');
    assert.equal(c.buyerId, null);
    assert.throws(
      () => moveWorkflowTicket(ctx, c.card.id, { version: c.version, to: 'blocked', reason: 'Wait' }),
      /Blocked requires/,
    );
    const u = updateWorkflowTicket(ctx, c.card.id, {
      version: c.version,
      blockedReason: 'Engineering dependency',
      nextAction: 'Follow up Monday',
      followUpAt: '2026-10-19T09:00:00+05:30',
    });
    assert.throws(() => updateWorkflowTicket(ctx, c.card.id, { version: c.version, nextAction: 'stale' }), /Stale/);
    const blocked = moveWorkflowTicket(ctx, c.card.id, {
      version: u.version,
      to: 'blocked',
      reason: 'Engineering is waiting',
    });
    const p = getDailyPriorities(ctx, { at: '2026-10-18T20:00:00Z' });
    assert.equal(p.dueToday[0]?.card.id, c.card.id);
    assert.equal(p.blocked.length, 1);
    assert.equal(p.overdue.length, 0);
    const archived = moveWorkflowTicket(ctx, c.card.id, {
      version: blocked.version,
      to: 'archive',
      reason: 'Unwanted work, explicit command',
    });
    assert.equal(archived.workflowStage, 'archive');
    assert.equal(getDailyPriorities(ctx).blocked.length, 0);
    const restored = moveWorkflowTicket(ctx, c.card.id, {
      version: archived.version,
      to: 'to_be_started',
      reason: 'Explicit destination',
    });
    assert.equal(restored.workflowStage, 'to_be_started');
    moveCard(ctx, c.card.id, { stageId: b.stages[1]?.id as number });
    assert.throws(
      () => updateWorkflowTicket(ctx, c.card.id, { version: restored.version, buyerId: 'reference' }),
      /Stale/,
    );
    assert.equal(getWorkflowTicket(ctx, c.card.id).workflowStage, 'work_in_progress');
  } finally {
    t.close();
  }
});

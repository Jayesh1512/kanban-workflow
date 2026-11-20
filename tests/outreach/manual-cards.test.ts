import { afterEach, describe, expect, it } from 'vitest';
import { fixtureDatabase } from '../workflow/database.js';
import { OutreachWorkflow } from '../../src/outreach/service.js';
import type { Member } from '../../src/access/service.js';
import type { RuntimeConfig } from '../../src/shared/ports.js';
import { SALES_STAGES } from '../../src/shared/outreach-domain.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const base = ['202610250001_outreach_core.sql', '202610260001_outreach_workflow.sql', '202610260002_stable_outreach_sources.sql',
  '202610270004_operator_intake_approvals.sql', '202610280001_crm_first.sql', '202610290001_native_workspace.sql',
  '202611200001_initial_placement_removal.sql', '202611200002_workstream_counterparty.sql', '202611200004_manual_crm_cards.sql'];
const migrations = base.map((name) => new URL(`../../db/migrations/${name}`, import.meta.url));
const config: RuntimeConfig['jev'] = { provider: 'openai', endpoint: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna', apiKey: null, timeoutMs: 1000, maxAttempts: 1 };

async function setup() {
  const db = await fixtureDatabase(migrations); cleanup.push(() => db.close());
  const actor = (await db.query("INSERT INTO workspace_members(email,display_name,role) VALUES('crm@example.com','Crm Manager','crm_manager') RETURNING id,email,display_name,role,version,enabled")).rows[0]! as unknown as Member;
  const viewer = (await db.query("INSERT INTO workspace_members(email,display_name,role) VALUES('viewer@example.com','Vera Viewer','viewer') RETURNING id,email,display_name,role,version,enabled")).rows[0]! as unknown as Member;
  const service = new OutreachWorkflow(db, { now: () => new Date('2026-11-20T00:00:00Z') }, config, { nativeBoard: true });
  return { db, service, actor, viewer };
}
const card = { idempotencyKey: 'manual-card-1', companyName: 'Grovio', stage: 'qualification' as const, workstream: 'Buyer' as const, summary: 'Met the founder offline', reason: 'Offline conversation; no imported Telegram source' };

describe('manual CRM cards (local SQL; no imported source)', () => {
  it('creates a staged relationship with no source and lists it on the accepted pipeline', async () => {
    const h = await setup();
    const created = await h.service.createManual(card, h.actor);
    const detail = await h.service.get(created.id);
    expect(detail.relationship).toMatchObject({ displayName: 'Grovio', acceptedStage: 'qualification', stageBasis: 'accepted', creationOrigin: 'manual', creationNote: card.reason, workstream: 'Buyer', sourceCount: 0 });
    expect(detail.activeSources).toEqual([]);
    expect((await h.db.query('SELECT count(*)::int AS n FROM outreach_relationship_sources')).rows[0]!.n).toBe(0);
    // It shows on the accepted board and never in the initial-placement queue.
    expect((await h.service.list({})).items.map((r) => r.id)).toEqual([created.id]);
    expect((await h.service.listReviewRelationships({})).items).toEqual([]);
    const audit = (await h.db.query('SELECT action,after_value FROM workspace_audit WHERE resource_id=$1', [created.id])).rows[0]!;
    expect(audit).toMatchObject({ action: 'crm.manual.create' });
    expect(audit.after_value).toMatchObject({ companyName: 'Grovio', stage: 'qualification', reason: card.reason });
  });
  it('replays the same key, rejects a different stage for that key, and refuses a second card for the same company', async () => {
    const h = await setup();
    const created = await h.service.createManual(card, h.actor);
    expect((await h.service.createManual(card, h.actor)).id).toBe(created.id);
    await expect(h.service.createManual({ ...card, stage: 'negotiation' }, h.actor)).rejects.toThrow('reused');
    await expect(h.service.createManual({ ...card, idempotencyKey: 'manual-card-2' }, h.actor)).rejects.toThrow('already has a CRM card');
    expect((await h.db.query('SELECT count(*)::int AS n FROM outreach_relationships')).rows[0]!.n).toBe(1);
  });
  it('places an unplaced relationship for that company instead of creating a duplicate', async () => {
    const h = await setup();
    await h.db.query("INSERT INTO companies(canonical_name) VALUES('Grovio')");
    const company = (await h.db.query("SELECT id FROM companies WHERE canonical_name='Grovio'")).rows[0]!;
    const unplaced = (await h.db.query("INSERT INTO outreach_relationships(identity_key,kind,company_id,display_name) VALUES($1,'company',$2,'Grovio') RETURNING id", [`company:${company.id}`, company.id])).rows[0]!;
    const created = await h.service.createManual(card, h.actor);
    expect(created.id).toBe(String(unplaced.id));
    expect((await h.service.get(created.id)).relationship).toMatchObject({ acceptedStage: 'qualification', creationOrigin: 'manual', sourceCount: 0 });
    expect((await h.db.query('SELECT count(*)::int AS n FROM outreach_relationships')).rows[0]!.n).toBe(1);
  });
  it('places an unplaced relationship that already has a source without labelling it manual', async () => {
    const h = await setup();
    await h.db.query("INSERT INTO companies(canonical_name) VALUES('Grovio')");
    const company = (await h.db.query("SELECT id FROM companies WHERE canonical_name='Grovio'")).rows[0]!;
    const rel = (await h.db.query("INSERT INTO outreach_relationships(identity_key,kind,company_id,display_name) VALUES($1,'company',$2,'Grovio') RETURNING id", [`company:${company.id}`, company.id])).rows[0]!;
    const thread = (await h.db.query("INSERT INTO outreach_source_threads(kind,source_key,source_revision) VALUES('email_report','report:grovio','r1') RETURNING id")).rows[0]!;
    await h.db.query('INSERT INTO outreach_relationship_sources(source_thread_id,relationship_id) VALUES($1,$2)', [thread.id, rel.id]);
    const created = await h.service.createManual(card, h.actor);
    expect(created.id).toBe(String(rel.id));
    expect((await h.service.get(created.id)).relationship).toMatchObject({ acceptedStage: 'qualification', creationOrigin: 'pipeline' });
  });
  it.each(SALES_STAGES)('moves a manual card to $label without a source and audits the reason', async ({ id }) => {
    const h = await setup();
    const created = await h.service.createManual(card, h.actor);
    const before = (await h.service.get(created.id)).relationship;
    expect(before.acceptedStage).toBe('qualification');
    if (id === 'qualification') return;
    await h.service.moveByHuman({ relationshipId: created.id, expectedEvidenceRevision: before.evidenceRevision, targetStage: id, idempotencyKey: `move-${id}`, reason: 'Offline stage update' }, h.actor);
    const after = (await h.service.get(created.id)).relationship;
    expect(after).toMatchObject({ acceptedStage: id, stageVersion: 2, creationOrigin: 'manual' });
    expect((await h.db.query("SELECT after_value FROM workspace_audit WHERE action='crm.move' AND resource_id=$1", [created.id])).rows[0]!.after_value).toMatchObject({ stage: id, reason: 'Offline stage update' });
  });
  it('refuses a viewer and a stale stage revision', async () => {
    const h = await setup();
    await expect(h.service.createManual(card, h.viewer)).rejects.toThrow('CRM management');
    const created = await h.service.createManual(card, h.actor);
    await expect(h.service.moveByHuman({ relationshipId: created.id, expectedEvidenceRevision: 0, targetStage: 'negotiation', idempotencyKey: 'stale-move', reason: 'Offline move' }, h.actor)).rejects.toThrow('Conversation changed');
  });
});

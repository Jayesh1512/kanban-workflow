import { describe, expect, it } from 'vitest';
import { loginPage, workspacePage } from '../../src/board/page.js';
import { nativeOutreachPage, outreachPage } from '../../src/outreach/page.js';

const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);

describe('native workspace pages (static shell checks)', () => {
  for (const [name, html] of Object.entries({ loginPage, workspacePage, nativeOutreachPage, outreachPage })) {
    it(`${name}: inline scripts parse and no template placeholder leaks`, () => {
      for (const script of scripts(html)) expect(() => new Function(script)).not.toThrow();
      expect(html).not.toMatch(/\$\{/);
    });
  }
  it('offers password sign-in and invited sign-up, never a magic link', () => {
    expect(loginPage).toContain('/auth/login');
    expect(loginPage).toContain('/auth/signup');
    expect(loginPage.toLowerCase()).not.toContain('magic');
  });
  it('shows the six Work lanes and five CRM stages', () => {
    for (const label of ['To be started', 'Work in progress', 'Integrations', 'Blocked', 'Archived', 'Completed', 'Lead / Prospect', 'Qualification', 'Negotiation', 'Deal Won']) expect(workspacePage).toContain(label);
  });
  it('lets permitted users drag cards between lanes via the existing move endpoints', () => {
    for (const part of ['card.draggable=true', 'column.ondrop', "'/api/board/crm/'+row.id+'/move'", "'/api/board/work/'+row.id+'/move'", "'/api/board/tasks/'+row.id", 'expectedStageVersion', 'expectedEvidenceRevision', 'expectedVersion']) expect(workspacePage).toContain(part);
    expect(workspacePage).toContain("member.role!=='viewer'&&row.owner_id===member.id");
  });
  it('shows a read-only permissions popup from an info icon on each member row', () => {
    for (const part of ['info-btn', 'View permissions for', 'permissionsDialog(m)', 'Move CRM cards between stages']) expect(workspacePage).toContain(part);
    expect(workspacePage).not.toContain('View your permissions');
  });
  it('CRM cards show only the next step and ETA, not the repeated name and stage', () => {
    expect(workspacePage).toContain('r.nextStep');
    expect(workspacePage).not.toContain("node('p',r.title,'muted'))");
    expect(nativeOutreachPage).toContain('r.nextStep||r.title');
  });
  it('native CRM page carries the shared nav, and role-aware move', () => {
    expect(nativeOutreachPage).toContain('window.nativeWorkspace=true');
    expect(nativeOutreachPage).toContain('/api/board/crm/');
    expect(nativeOutreachPage).not.toContain('<header>');
    expect(nativeOutreachPage).toContain('class="topbar"');
  });
  it('legacy outreach page is unchanged in shape (no workspace flag, original header)', () => {
    expect(outreachPage).not.toContain('window.nativeWorkspace=true');
    expect(outreachPage).toContain('<header>');
  });
  it('human moves say no Telegram message is sent; AI suggestions are never presented as applied', () => {
    expect(nativeOutreachPage).toContain('No Telegram message is sent');
    expect(nativeOutreachPage).toContain('not applied');
  });
  it('only the direct human endpoint reads as an immediate save; old manual items do not', () => {
    const source = scripts(nativeOutreachPage).join('\n');
    const grab = (name: string) => source.match(new RegExp(`function ${name}\\(p\\)\\{.*`))![0];
    const run = new Function('stages', 'stamp', 'nativeWorkspace', `${source.match(/const stageName=.*/)![0]}${grab('proposalTitle')}${grab('proposalState')}return {proposalTitle,proposalState};`) as
      (...a: unknown[]) => { proposalTitle: (p: object) => string; proposalState: (p: object) => string };
    const { proposalTitle, proposalState } = run([{ id: 'qualification', label: 'Qualification' }], () => 'date', true);
    const base = { command_kind: 'stage', target_stage: 'qualification' };
    const human = { ...base, origin: 'manual', human_move: true, state: 'approved', decision_source: 'http', decided_at: '2026-10-30T00:00:00Z' };
    const oldManual = { ...base, origin: 'manual', human_move: false, state: 'approved', decision_source: 'telegram' };
    const pendingManual = { ...base, origin: 'manual', human_move: false, state: 'pending', decision_source: null };
    const ai = { ...base, origin: 'openai', human_move: false, state: 'pending', decision_source: null };
    expect([proposalTitle(human), proposalState(human)]).toEqual(['Moved to Qualification', 'Saved immediately · date']);
    expect([proposalTitle(oldManual), proposalState(oldManual)]).toEqual(['Move request: Qualification', 'Approved in Telegram']);
    expect(proposalState({ ...oldManual, decision_source: 'http' })).toBe('Approved in Approvals');
    expect(proposalState({ ...oldManual, decision_source: null })).toBe('Approved');
    expect(proposalState({ ...oldManual, state: 'rejected', decision_source: 'http' })).toBe('Rejected in Approvals');
    expect([proposalTitle(pendingManual), proposalState(pendingManual)]).toEqual(['Move request: Qualification', 'Pending approval · not applied']);
    expect([proposalTitle(ai), proposalState(ai)]).toEqual(['AI suggestion: move to Qualification', 'Pending approval · not applied']);
  });
  it('placement review is gone from the dashboard and native CRM, kept only on the legacy page and in Approvals', () => {
    for (const html of [workspacePage, nativeOutreachPage]) {
      expect(html).not.toContain('Awaiting CRM placement');
      expect(html).not.toContain('Context &amp; placement review');
      expect(html).not.toContain('id="placement-review"');
      expect(html).not.toContain('id="review"');
    }
    expect(outreachPage).toContain('Context &amp; placement review');
    expect(workspacePage).toContain('/api/board/approvals/placements');
    expect(workspacePage).toContain('id="approvals-link" hidden');
    expect(nativeOutreachPage).toContain('id="approvals-link" hidden');
  });
  it('approvals only call the reviewer endpoints and gate on role', () => {
    for (const path of ['/proposals', '/work', '/intake', '/place', '/decision']) expect(workspacePage).toContain(path);
    expect(workspacePage).toContain("if(!canReview()){location.replace('/dashboard')");
    expect(workspacePage).toContain("n!=='proposals'");
  });
});

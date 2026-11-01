import { describe, expect, it } from 'vitest';
import { loginPage, workspacePage } from '../../src/board/page.js';
import { directoryPage, teamPage } from '../../src/board/directory.js';
import { nativeOutreachPage, outreachPage } from '../../src/outreach/page.js';

const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);

describe('native workspace pages (static shell checks)', () => {
  for (const [name, html] of Object.entries({ loginPage, workspacePage, nativeOutreachPage, outreachPage, directoryPage, teamPage })) {
    it(`${name}: inline scripts parse and no template placeholder leaks`, () => {
      for (const script of scripts(html)) expect(() => new Function(script)).not.toThrow();
      expect(html).not.toMatch(/\$\{/);
    });
  }
  it('shows the My tasks link and page only when the session says myTasks', () => {
    expect(workspacePage).toContain('id="mytasks-link" hidden');
    expect(workspacePage).toContain('hidden=!member.myTasks');
    expect(workspacePage).toContain("mode==='work'&&!member.myTasks");
  });
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
  it('approval cards show the change up front, one status badge and the AI reasoning behind Why?', () => {
    for (const part of ["'Waiting for you'", "'AI suggests'", "'Why?'", "'New relationship'", "w.source_lane+' → '+w.target_lane", 'cleanStep(r.nextStep)', 'Review initial placement|Next action not recorded', 'ETA: (Not set']) expect(workspacePage).toContain(part);
    for (const old of ['AI suggestion pending', 'Pending approval · not applied', 'proposal-note']) expect(workspacePage).not.toContain(old);
  });
  it('CRM Pipeline has one compact filter/sort row (native only), persisted in localStorage and the URL', () => {
    for (const id of ['id="filters"', 'id="f-ws"', 'id="f-fu"', 'id="f-pending"', 'id="f-archived"', 'id="f-sort"', 'id="f-clear"', 'id="f-shown"']) expect(nativeOutreachPage).toContain(id);
    expect(outreachPage).not.toContain('id="filters"');
    for (const part of ["localStorage.setItem(viewKey", 'history.replaceState', 'Sort: Last activity', 'Show Archived']) expect(nativeOutreachPage).toContain(part);
  });
  it('CRM filters and in-stage sorts work on loaded rows', () => {
    const source = scripts(nativeOutreachPage).join('\n');
    const line = (start: string) => source.split('\n').find((l) => l.startsWith(start))!;
    const run = new Function('view', `${line('const dayKey=')}${line('function passes(r)')}${line('const sorters=')}return {passes,sorters,dayKey};`) as
      (view: object) => { passes: (r: object) => boolean; sorters: Record<string, (a: object, b: object) => number>; dayKey: (d: Date) => string };
    const base = { ws: '', fu: '', pending: '', archived: '', sort: 'activity' };
    const { passes, dayKey } = run(base);
    const today = dayKey(new Date()), past = '2000-01-01', far = '2999-01-01';
    expect(passes({ acceptedStage: 'archived' })).toBe(false);
    expect(run({ ...base, archived: '1' }).passes({ acceptedStage: 'archived' })).toBe(true);
    expect(run({ ...base, ws: 'Buyer' }).passes({ acceptedStage: 'lead', workstream: 'Provider' })).toBe(false);
    expect(run({ ...base, ws: 'none' }).passes({ acceptedStage: 'lead', workstream: null })).toBe(true);
    const overdue = run({ ...base, fu: 'overdue' }).passes, week = run({ ...base, fu: 'week' }).passes, none = run({ ...base, fu: 'none' }).passes;
    expect([overdue({ followUpDate: past }), overdue({ followUpDate: today }), overdue({})]).toEqual([true, false, false]);
    expect([week({ followUpDate: today }), week({ followUpDate: far }), week({ followUpDate: past })]).toEqual([true, false, false]);
    expect([none({}), none({ followUpDate: today })]).toEqual([true, false]);
    expect(run({ ...base, pending: '1' }).passes({ pendingSuggestionCount: 0 })).toBe(false);
    const { sorters } = run(base), rows = [{ n: 'a', latestSourceAt: '2026-10-01T00:00:00Z', followUpDate: null, createdAt: '2026-10-05T00:00:00Z' }, { n: 'b', latestSourceAt: '2026-10-09T00:00:00Z', followUpDate: '2026-11-02', createdAt: '2026-10-01T00:00:00Z' }];
    expect([...rows].sort(sorters.activity).map((r) => r.n)).toEqual(['b', 'a']);
    expect([...rows].sort(sorters.followup).map((r) => r.n)).toEqual(['b', 'a']);
    expect([...rows].sort(sorters.added).map((r) => r.n)).toEqual(['a', 'b']);
  });
  it('drops the duplicate Unique companies card and widens search to fields the rows carry', () => {
    for (const html of [workspacePage, nativeOutreachPage]) expect(html).not.toContain('Unique companies');
    expect(nativeOutreachPage).toContain('[r.displayName,r.title,r.nextStep,r.summary,r.workstream]');
    expect(workspacePage).toContain('[row.title,row.company,row.summary,row.nextAction,row.description,row.displayName,row.owner_name]');
  });
  it('My Tasks has a filter/sort row for mine/team only, with owner only in team scope', () => {
    for (const id of ['id="filters"', 'id="f-type"', 'id="f-due"', 'id="f-ws"', 'id="f-company"', 'id="f-owner"', 'id="f-sort"', 'id="f-clear"', 'id="f-shown"']) expect(workspacePage).toContain(id);
    for (const part of ["mode==='work'&&(source==='mine'||source==='team')", "source==='team'?owners:[]", 'localStorage.setItem(viewKey', 'history.replaceState', 'Sort: Due date']) expect(workspacePage).toContain(part);
  });
});

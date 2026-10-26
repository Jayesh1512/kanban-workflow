import { randomUUID } from 'node:crypto';
import { DomainError } from '../shared/api.js';
import { LANES, WORKSTREAMS } from '../shared/domain.js';
import type { Lane, RemoteId, ServiceStatus, Workstream } from '../shared/domain.js';
import type { BoardBinding, RemoteTask, RuntimeConfig, VikunjaPort } from '../shared/ports.js';
import type { PgDatabase } from '../platform/database.js';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new DomainError('upstream_unavailable', 'Invalid Vikunja object response');
  return v as ObjectValue;
};
const id = (v: unknown): string => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v);
  if (typeof v === 'string' && /^[1-9]\d*$/.test(v)) return v;
  throw new DomainError('upstream_unavailable', 'Invalid or unsafe Vikunja identifier');
};
const wireId = (v: string): number => {
  const n = Number(v);
  if (!/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(n)) throw new DomainError('validation', 'Vikunja identifier exceeds safe JSON numeric range');
  return n;
};
const text = (v: unknown) => typeof v === 'string' ? v : '';

export class VikunjaAdapter implements VikunjaPort {
  private token: string | null;
  private state: ServiceStatus;
  constructor(private readonly config: RuntimeConfig['vikunja'], private readonly db: PgDatabase) {
    this.token = config.apiToken;
    this.state = this.makeStatus(config.apiToken || config.password ? 'connecting' : 'unconfigured', 'bootstrap_pending', 'Vikunja bootstrap has not completed');
  }
  private makeStatus(state: ServiceStatus['state'], code: string | null, detail: string | null): ServiceStatus { return { state, code, detail, checkedAt: new Date().toISOString() }; }
  async status(): Promise<ServiceStatus> { return this.state; }
  private signal(): AbortSignal {
    const session = this.db.sessionSignal;
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 10_000);
    return session ? AbortSignal.any([session, timeout]) : timeout;
  }
  private async login(): Promise<void> {
    if (!this.config.password) throw new DomainError('not_configured', 'Configure Vikunja service credentials');
    const response = await fetch(`${this.config.baseUrl}/api/v2/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.config.username, password: this.config.password }),
      signal: this.signal(), redirect: 'error',
    });
    this.db.sessionSignal?.throwIfAborted();
    if (!response.ok) throw new DomainError('upstream_unavailable', `Vikunja login failed (HTTP ${response.status}); check service credentials`, response.status >= 500);
    const result = object(await response.json());
    this.db.sessionSignal?.throwIfAborted();
    if (typeof result['token'] !== 'string' || !result['token']) throw new DomainError('upstream_unavailable', 'Vikunja login returned no access token');
    this.token = result['token'];
  }
  private async request(method: string, path: string, body?: unknown, optional404 = false): Promise<unknown> {
    try {
      if (!this.token) await this.login();
      let response: Response | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        response = await fetch(`${this.config.baseUrl}/api/v2${path}`, {
          method, headers: { 'Content-Type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json', Authorization: `Bearer ${this.token}` },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: this.signal(), redirect: 'error',
        });
        this.db.sessionSignal?.throwIfAborted();
        if (response.status !== 401 || this.config.apiToken || attempt === 1) break;
        await response.body?.cancel();
        this.token = null;
        await this.login();
      }
      if (!response) throw new Error('No response');
      // Vikunja v2 returns 304 for an unchanged Merge Patch. Callers still
      // read back the task and verify its managed lane after this no-op.
      if (method === 'PATCH' && /^\/tasks\/[1-9]\d*$/.test(path) && response.status === 304) { await response.body?.cancel(); return null; }
      if (response.status === 404 && optional404) { await response.body?.cancel(); return null; }
      if (!response.ok) {
        await response.body?.cancel();
        throw new DomainError('upstream_unavailable', `Vikunja ${method} failed (HTTP ${response.status})`, response.status >= 500 || response.status === 429);
      }
      const result = response.status === 204 ? null : await response.json();
      this.db.sessionSignal?.throwIfAborted();
      return result;
    } catch (error) {
      const failure = error instanceof DomainError ? error : new DomainError('upstream_unavailable', 'Vikunja connection failed or timed out; check its URL and health', true);
      this.state = this.makeStatus(failure.code === 'not_configured' ? 'unconfigured' : 'unavailable', failure.code, failure.message);
      throw failure;
    }
  }
  private async list(path: string): Promise<ObjectValue[]> {
    const items: ObjectValue[] = [];
    for (let page = 1; page <= 100_000; page++) {
      const result = object(await this.request('GET', `${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=100`));
      if (!Array.isArray(result['items'])) throw new DomainError('upstream_unavailable', 'Vikunja v2 list response has no items');
      items.push(...result['items'].map(object));
      const totalPages = Number(result['total_pages']);
      if (page >= totalPages || result['items'].length === 0) return items;
      if (!Number.isSafeInteger(totalPages) || totalPages < 0) throw new DomainError('upstream_unavailable', 'Invalid Vikunja pagination');
    }
    throw new DomainError('upstream_unavailable', 'Vikunja pagination exceeded safety bound');
  }
  async ensureBoard(): Promise<BoardBinding> {
    try { return await this.db.withLock('antseed:board-bootstrap', async (sql) => {
      await sql.query("INSERT INTO app_settings(key,value) VALUES('vikunja_namespace',to_jsonb($1::text)) ON CONFLICT DO NOTHING", [randomUUID()]);
      const namespace = (await sql.query<{ value: string }>("SELECT value FROM app_settings WHERE key='vikunja_namespace'")).rows[0]?.value;
      if (!namespace) throw new Error('Missing board namespace');
      const marker = `[antseed-board:${namespace}]`;
      const binding = (await sql.query<{ project_id: string; view_id: string }>('SELECT project_id,view_id FROM board_bindings WHERE singleton')).rows[0];
      let project: ObjectValue | null = binding ? (await this.request('GET', `/projects/${binding.project_id}`, undefined, true) as ObjectValue | null) : null;
      if (!project) {
        const matches = (await this.list('/projects')).filter((p) => text(p['description']).includes(marker));
        if (matches.length > 1) throw new DomainError('conflict', 'Multiple managed Vikunja projects share the bootstrap marker');
        project = matches[0] ?? object(await this.request('POST', '/projects', { title: this.config.projectTitle, description: marker }));
      }
      const projectId = id(project['id']);
      const views = await this.list(`/projects/${projectId}/views`);
      let view = views.find((v) => binding?.view_id === id(v['id']) && v['view_kind'] === 'kanban' && v['bucket_configuration_mode'] === 'manual')
        ?? views.find((v) => v['view_kind'] === 'kanban' && v['bucket_configuration_mode'] === 'manual');
      view ??= object(await this.request('POST', `/projects/${projectId}/views`, { title: 'Kanban', view_kind: 'kanban', bucket_configuration_mode: 'manual' }));
      const viewId = id(view['id']);
      await sql.query('INSERT INTO board_bindings(singleton,project_id,view_id) VALUES(true,$1,$2) ON CONFLICT(singleton) DO UPDATE SET project_id=$1,view_id=$2,updated_at=now()', [projectId, viewId]);
      const root = `/projects/${projectId}/views/${viewId}`;
      const remoteBuckets = await this.list(`${root}/buckets`);
      const knownBuckets = (await sql.query<{ lane: Lane; bucket_id: string }>('SELECT lane,bucket_id FROM board_buckets')).rows;
      const defaults: Partial<Record<Lane, string>> = { 'To be started': 'To-Do', 'Work in progress': 'Doing', Completed: 'Done' };
      const buckets = {} as BoardBinding['buckets'];
      for (const [position, lane] of LANES.entries()) {
        const saved = knownBuckets.find((b) => b.lane === lane);
        const matches = remoteBuckets.filter((b) => b['title'] === lane);
        if (matches.length > 1) throw new DomainError('conflict', `Duplicate managed lane: ${lane}`);
        let bucket = remoteBuckets.find((b) => saved?.bucket_id === id(b['id'])) ?? matches[0] ?? remoteBuckets.find((b) => b['title'] === defaults[lane]);
        if (bucket) bucket = object(await this.request('PUT', `${root}/buckets/${id(bucket['id'])}`, { ...bucket, title: lane, position: (position + 1) * 100, limit: 0 }));
        else bucket = object(await this.request('POST', `${root}/buckets`, { title: lane, position: (position + 1) * 100, limit: 0 }));
        buckets[lane] = id(bucket['id']);
        await sql.query('INSERT INTO board_buckets(lane,bucket_id) VALUES($1,$2) ON CONFLICT(lane) DO UPDATE SET bucket_id=$2', [lane, buckets[lane]]);
      }
      const expected = new Set(Object.values(buckets));
      if (remoteBuckets.some((b) => !expected.has(id(b['id'])))) throw new DomainError('conflict', 'Managed view contains unexpected buckets; reconcile them before bootstrap continues');
      await this.request('PUT', root, { ...view, filter: null, default_bucket_id: wireId(buckets['To be started']), done_bucket_id: wireId(buckets.Completed) });
      const remoteLabels = await this.list('/labels');
      const knownLabels = (await sql.query<{ workstream: Workstream; label_id: string }>('SELECT workstream,label_id FROM board_labels')).rows;
      const labels = {} as BoardBinding['labels'];
      for (const workstream of WORKSTREAMS) {
        const saved = knownLabels.find((l) => l.workstream === workstream);
        let label = remoteLabels.find((l) => saved?.label_id === id(l['id']));
        if (!label) {
          const matches = remoteLabels.filter((l) => l['title'] === workstream);
          if (matches.length > 1) throw new DomainError('conflict', `Duplicate workstream label: ${workstream}`);
          label = matches[0] ?? object(await this.request('POST', '/labels', { title: workstream }));
        }
        labels[workstream] = id(label['id']);
        await sql.query('INSERT INTO board_labels(workstream,label_id) VALUES($1,$2) ON CONFLICT(workstream) DO UPDATE SET label_id=$2', [workstream, labels[workstream]]);
      }
      this.state = this.makeStatus('ready', null, 'Managed board and labels verified');
      return { projectId, viewId, buckets, labels };
    }); } catch (error) {
      const failure = error instanceof DomainError ? error : new DomainError('upstream_unavailable', 'Vikunja bootstrap metadata is unavailable; check database health', true);
      this.state = this.makeStatus(failure.code === 'not_configured' ? 'unconfigured' : 'unavailable', failure.code, failure.message);
      throw failure;
    }
  }
  private async binding(): Promise<BoardBinding> {
    const row = (await this.db.query<{ project_id: string; view_id: string }>('SELECT project_id,view_id FROM board_bindings WHERE singleton')).rows[0];
    if (!row) throw new DomainError('not_configured', 'Vikunja board bootstrap is pending');
    const buckets = Object.fromEntries((await this.db.query<{ lane: Lane; bucket_id: string }>('SELECT lane,bucket_id FROM board_buckets')).rows.map((r) => [r.lane, r.bucket_id])) as BoardBinding['buckets'];
    const labels = Object.fromEntries((await this.db.query<{ workstream: Workstream; label_id: string }>('SELECT workstream,label_id FROM board_labels')).rows.map((r) => [r.workstream, r.label_id])) as BoardBinding['labels'];
    if (!LANES.every((l) => buckets[l]) || !WORKSTREAMS.every((w) => labels[w])) throw new DomainError('not_configured', 'Vikunja board bootstrap is incomplete');
    return { projectId: row.project_id, viewId: row.view_id, buckets, labels };
  }
  async getTask(taskId: RemoteId): Promise<RemoteTask | null> {
    const task = await this.request('GET', `/tasks/${id(taskId)}`, undefined, true);
    if (!task) return null;
    const t = object(task), board = await this.binding();
    if (id(t['project_id']) !== board.projectId) throw new DomainError('conflict', 'Task is outside the managed project');
    // The flat view tasks endpoint reports bucket_id=0 in 2.7.0. Only grouped
    // buckets/tasks resolves the actual per-view assignment. This variant is
    // explicitly unpaginated; filtering by the one task bounds its payload.
    const grouped = object(await this.request('GET', `/projects/${board.projectId}/views/${board.viewId}/buckets/tasks?filter=${encodeURIComponent(`id = ${taskId}`)}`));
    if (!Array.isArray(grouped['items'])) throw new DomainError('upstream_unavailable', 'Vikunja grouped bucket response has no items');
    const bucket = grouped['items'].map(object).find((b) => Array.isArray(b['tasks']) && b['tasks'].some((v: unknown) => id(object(v)['id']) === taskId));
    if (!bucket) throw new DomainError('conflict', 'Task is not visible in the managed view');
    return { id: id(t['id']), projectId: board.projectId, bucketId: id(bucket['id']), title: text(t['title']), description: text(t['description']), updatedAt: text(t['updated']) };
  }
  async ensureTask(input: Parameters<VikunjaPort['ensureTask']>[0]): Promise<RemoteTask> {
    return this.db.withLock(`antseed:ticket:${input.ticketId}`, async (sql) => {
      const ticket = (await sql.query<{ vikunja_task_id: string | null }>('SELECT vikunja_task_id FROM tickets WHERE id=$1', [input.ticketId])).rows[0];
      if (!ticket) throw new DomainError('not_found', 'Ticket does not exist');
      if (ticket.vikunja_task_id) {
        const existing = await this.getTask(ticket.vikunja_task_id);
        if (existing) return existing;
        throw new DomainError('conflict', 'Previously projected Vikunja task was removed');
      }
      const board = await this.binding(), marker = `[antseed-ticket:${input.ticketId}]`;
      const matches = (await this.list(`/projects/${board.projectId}/tasks`)).filter((t) => text(t['description']).includes(marker));
      if (matches.length > 1) throw new DomainError('conflict', 'Duplicate ticket projection markers');
      const task = matches[0] ?? object(await this.request('POST', `/projects/${board.projectId}/tasks`, { title: input.title, description: `${input.description}\n\n${marker}` }));
      const taskId = id(task['id']);
      // Do not reset a recovered task's lane: a remote human might have moved it.
      await this.setWorkstream(taskId, input.workstream, board);
      await sql.query('UPDATE tickets SET vikunja_task_id=$2,updated_at=now() WHERE id=$1', [input.ticketId, taskId]);
      const result = await this.getTask(taskId);
      if (!result) throw new DomainError('upstream_unavailable', 'Created task cannot be read back');
      return result;
    });
  }
  private async setWorkstream(taskId: string, workstream: Workstream, board: BoardBinding): Promise<void> {
    const labels = await this.list(`/tasks/${taskId}/labels`);
    for (const label of labels) {
      const labelId = id(label['id']);
      if (Object.values(board.labels).includes(labelId) && labelId !== board.labels[workstream]) await this.request('DELETE', `/tasks/${taskId}/labels/${labelId}`);
    }
    if (!labels.some((l) => id(l['id']) === board.labels[workstream])) await this.request('POST', `/tasks/${taskId}/labels`, { label_id: wireId(board.labels[workstream]) });
  }
  private async withTaskLock<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const ticket = (await this.db.query<{ id: string }>('SELECT id FROM tickets WHERE vikunja_task_id=$1', [id(taskId)])).rows[0];
    if (!ticket) throw new DomainError('conflict', 'Task is not linked to a managed ticket');
    return this.db.withSessionLock(`antseed:ticket:${ticket.id}`, async (sql) => {
      const linked = await sql.query('SELECT id FROM tickets WHERE id=$1 AND vikunja_task_id=$2', [ticket.id, taskId]);
      if (!linked.rowCount) throw new DomainError('conflict', 'Ticket projection changed before the write');
      return work();
    });
  }
  async updateTaskDetails(input: Parameters<VikunjaPort['updateTaskDetails']>[0]): Promise<RemoteTask> {
    return this.withTaskLock(input.taskId, async () => {
      const before = await this.getTask(input.taskId);
      if (!before) throw new DomainError('not_found', 'Vikunja task does not exist');
      const marker = before.description.match(/\[antseed-ticket:[\da-f-]+\]/i)?.[0];
      const description = marker && !input.description.includes(marker) ? `${input.description}\n\n${marker}` : input.description;
      // Real 2.7 v2 Merge Patch: no stale done/bucket/project/other fields in this payload.
      await this.request('PATCH', `/tasks/${input.taskId}`, { title: input.title, description });
      await this.setWorkstream(input.taskId, input.workstream, await this.binding());
      const after = await this.getTask(input.taskId);
      if (!after || after.bucketId !== before.bucketId || after.title !== input.title || after.description !== description) throw new DomainError('conflict', 'Task details or lane changed during detail projection; reconciliation required');
      return after;
    });
  }
  async moveTask(input: Parameters<VikunjaPort['moveTask']>[0]): Promise<void> {
    return this.withTaskLock(input.taskId, async () => {
      const board = await this.binding();
      if (board.projectId !== input.projectId || board.viewId !== input.viewId || !Object.values(board.buckets).includes(input.targetBucketId)) throw new DomainError('conflict', 'Move is outside the managed board');
      const task = await this.getTask(input.taskId);
      if (!task) throw new DomainError('not_found', 'Vikunja task does not exist');
      if (task.bucketId !== input.targetBucketId) await this.request('PUT', `/projects/${input.projectId}/views/${input.viewId}/buckets/${input.targetBucketId}/tasks`, { task_id: wireId(input.taskId) });
      if ((await this.getTask(input.taskId))?.bucketId !== input.targetBucketId) throw new DomainError('upstream_unavailable', 'Vikunja move could not be verified', true);
    });
  }
  async check(): Promise<void> {
    const board = await this.binding();
    await this.request('GET', `/projects/${board.projectId}/views/${board.viewId}`);
    this.state = this.makeStatus('ready', null, 'Managed board is reachable');
  }
}

import { DomainError } from '../shared/api.js';
import type { Database, RuntimeConfig } from '../shared/ports.js';
import type { MeetingRemoteTask, MeetingTaskPort, MeetingTaskSnapshot } from './domain.js';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid response');
  return v as ObjectValue;
};
const id = (v: unknown): string => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v);
  if (typeof v === 'string' && /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v))) return v;
  throw new Error('Invalid identifier');
};
const failure = (message: string) => new DomainError('upstream_unavailable', message);
/** Independent action tasks reuse the existing project without touching tickets, buckets or ownership. */
export class VikunjaMeetingTaskAdapter implements MeetingTaskPort {
  private token: string | null;
  private projectId: string | null = null;
  private readonly fetcher: typeof fetch;
  private readonly base: string;
  constructor(private readonly db: Database, private readonly config: RuntimeConfig['vikunja'], private readonly options: { projectId?: string | null; fetch?: typeof fetch } = {}) {
    this.token = config.apiToken;
    this.fetcher = options.fetch ?? fetch;
    try {
      const endpoint = new URL(config.baseUrl);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
      this.base = endpoint.toString().replace(/\/$/, '');
    } catch { throw new DomainError('validation', 'Vikunja URL must be an HTTP(S) service endpoint without credentials or query parameters'); }
  }
  private signal(parent?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 15_000);
    return parent ? AbortSignal.any([parent, timeout]) : timeout;
  }
  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, parent?: AbortSignal, login = false, optional404 = false): Promise<unknown> {
    const signal = this.signal(parent);
    try {
      signal.throwIfAborted();
      const response = await this.fetcher(`${this.base}/api/v2${path}`, {
        method, signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(!login ? { Authorization: `Bearer ${this.token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 404 && optional404) { await response.body?.cancel(); return null; }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) this.token = this.config.apiToken;
        throw failure(`Vikunja ${login ? 'authentication' : method} failed (HTTP ${response.status})`);
      }
      return response.status === 204 ? null : await response.json();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw failure('Vikunja request failed, timed out or returned an invalid response');
    }
  }
  async prepare(signal?: AbortSignal): Promise<void> {
    if (!this.token) {
      if (!this.config.password) throw new DomainError('not_configured', 'Configure existing Vikunja credentials');
      const result = object(await this.request('POST', '/login', { username: this.config.username, password: this.config.password }, signal, true));
      if (typeof result.token !== 'string' || !result.token) throw failure('Vikunja authentication returned no token');
      this.token = result.token;
    }
    try {
      const configured = this.options.projectId;
      const existing = configured ?? (await this.db.query<{ project_id: string }>('SELECT project_id FROM board_bindings WHERE singleton')).rows[0]?.project_id;
      if (!existing) throw new DomainError('not_configured', 'Choose an existing Vikunja project or configure the existing board first');
      const projectId = id(existing);
      const project = object(await this.request('GET', `/projects/${projectId}`, undefined, signal));
      if (id(project.id) !== projectId) throw new Error();
      signal?.throwIfAborted();
      this.projectId = projectId;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw failure('Vikunja existing project verification failed');
    }
  }
  private task(value: unknown): MeetingRemoteTask {
    const task = object(value);
    if (id(task.project_id) !== this.projectId) throw new Error('Wrong project');
    const taskId = id(task.id);
    const publicBase = this.config.publicUrl ?? this.base;
    const endpoint = new URL(publicBase);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Unsafe public URL');
    return { id: taskId, url: `${endpoint.toString().replace(/\/$/, '')}/tasks/${taskId}` };
  }
  async find(marker: string, signal?: AbortSignal): Promise<MeetingRemoteTask[]> {
    if (!this.projectId || !this.token) throw new DomainError('not_configured', 'Prepare the existing Vikunja project before task lookup');
    const matches: MeetingRemoteTask[] = [], seen = new Set<string>();
    let expectedPages: number | null = null;
    try {
      for (let page = 1; page <= 10_000; page++) {
        const result = object(await this.request('GET', `/projects/${this.projectId}/tasks?page=${page}&per_page=100`, undefined, signal));
        signal?.throwIfAborted();
        if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total_pages) || Number(result.total_pages) < 0 || Number(result.total_pages) > 10_000) throw new Error();
        const pages = Number(result.total_pages);
        if (expectedPages !== null && pages !== expectedPages) throw new Error('Pagination changed; retry a complete read');
        expectedPages = pages;
        if ((!pages && result.items.length) || (page < pages && !result.items.length)) throw new Error();
        for (const item of result.items) {
          const remote = object(item), taskId = id(remote.id);
          if (seen.has(taskId)) throw new Error('Repeated pagination');
          seen.add(taskId);
          // Only a complete marker on its own line qualifies, never a prefix substring.
          if (typeof remote.description === 'string' && remote.description.split(/\r?\n/).some(line => line.trim() === marker)) matches.push(this.task(remote));
        }
        if (page >= pages) return matches;
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw failure('Vikunja task lookup was incomplete or returned invalid task data');
    }
    throw failure('Vikunja task lookup exceeded the pagination safety bound');
  }
  async create(snapshot: MeetingTaskSnapshot, marker: string, signal?: AbortSignal): Promise<MeetingRemoteTask> {
    if (!this.projectId || !this.token) throw new DomainError('not_configured', 'Prepare the existing Vikunja project before task creation');
    const owner = snapshot.assignee ? [snapshot.assignee.name, snapshot.assignee.email, snapshot.assignee.team].filter(Boolean).join(' / ') : 'Unassigned in source';
    const description = [snapshot.description, `Meeting: ${snapshot.meetingTitle}`, `Customers: ${snapshot.customerNames.join(', ') || 'Unresolved'}`, `Source owner: ${owner}`, snapshot.sourceUrl ? `Recording: ${snapshot.sourceUrl}` : null, snapshot.timestamp ? `Recording timestamp: ${snapshot.timestamp}` : null, snapshot.playbackUrl ? `Playback: ${snapshot.playbackUrl}` : null, marker].filter(v => v !== null).join('\n\n');
    // No POST retrier, credential replay, inferred user ID, deadline or project bootstrap.
    const response = await this.request('POST', `/projects/${this.projectId}/tasks`, { title: snapshot.title, description, due_date: null }, signal);
    try { return this.task(response); }
    catch { throw failure('Vikunja task creation response was invalid; its outcome is unknown'); }
  }
  async retire(taskId: string, marker: string, signal?: AbortSignal): Promise<void> {
    if (!this.projectId || !this.token) throw new DomainError('not_configured', 'Prepare the existing Vikunja project before task retirement');
    const task = await this.request('GET', `/tasks/${id(taskId)}`, undefined, signal, false, true);
    if (task) {
      const value = object(task);
      if (id(value.project_id) !== this.projectId || typeof value.description !== 'string' || !value.description.split(/\r?\n/).some(line => line.trim() === marker))
        throw new DomainError('conflict', 'Meeting task retirement refused outside its exact managed marker');
      await this.request('DELETE', `/tasks/${id(taskId)}`, undefined, signal);
    }
    if (await this.request('GET', `/tasks/${id(taskId)}`, undefined, signal, false, true)) throw new DomainError('conflict', 'Retired meeting task still exists');
  }
}

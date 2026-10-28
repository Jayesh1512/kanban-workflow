import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { FathomClient, fathomMeetingSchema } from '../../src/meetings/fathom.js';
import { fathomHttp } from './ingestion-test-helper.js';

const bounds = { createdAfter: '2026-10-01T00:00:00Z', createdBefore: '2026-10-26T00:00:00Z' };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
describe('Fathom REST contract against real HTTP', () => {
  it('sends documented includes, server-side API key and cursor without invented page-size parameters', async () => {
    const fixture = JSON.parse(await readFile(new URL('fixtures/fathom-meeting.json', import.meta.url), 'utf8'));
    const requests: URL[] = [];
    const http = await fathomHttp((request, response) => {
      expect(request.headers['x-api-key']).toBe('synthetic-secret');
      const url = new URL(request.url!, 'http://localhost'); requests.push(url);
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ items: [{ ...fixture, extra: { kept: true } }], next_cursor: requests.length === 1 ? 'page+2/=' : null, limit: 50 }));
    }); cleanup.push(http.close);
    const client = new FathomClient({ apiKey: 'synthetic-secret', baseUrl: http.baseUrl });
    const first = await client.listMeetings(bounds); const last = await client.listMeetings({ ...bounds, cursor: first.next_cursor });
    expect(first.items[0]?.extra).toEqual({ kept: true }); expect(last.next_cursor).toBeNull();
    expect(requests[0]!.pathname).toBe('/external/v1/meetings');
    expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({ include_transcript: 'true', include_summary: 'true', include_action_items: 'true', include_crm_matches: 'true', created_after: bounds.createdAfter, created_before: bounds.createdBefore });
    expect(requests[1]!.searchParams.get('cursor')).toBe('page+2/=');
    expect(fathomMeetingSchema.parse({ ...fixture, transcript: null, action_items: null }).action_items).toBeNull();
    const { transcript: _transcript, ...omitted } = fixture; expect('transcript' in fathomMeetingSchema.parse(omitted)).toBe(false);
  });
  it.each([[401, 'authentication'], [403, 'authentication'], [429, 'rate_limited'], [503, 'unavailable']] as const)('classifies HTTP %s and honors Retry-After', async (status, code) => {
    const http = await fathomHttp((_request, response) => { response.writeHead(status, { 'retry-after': '7' }); response.end('private upstream error'); }); cleanup.push(http.close);
    await expect(new FathomClient({ apiKey: 'key', baseUrl: http.baseUrl }).listMeetings(bounds)).rejects.toMatchObject({ code, status, retryAfterMs: code === 'authentication' ? null : 7000 });
  });
  it('treats the live API empty terminal cursor as exhausted without accepting a missing cursor', async () => {
    let terminal = true;
    const http = await fathomHttp((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(terminal ? { items: [], next_cursor: '', limit: 10 } : { items: [] }));
    }); cleanup.push(http.close);
    const client = new FathomClient({ apiKey: 'synthetic-secret', baseUrl: http.baseUrl });
    expect((await client.listMeetings(bounds)).next_cursor).toBeNull();
    terminal = false;
    await expect(client.listMeetings(bounds)).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('handles date Retry-After, malformed pages, timeout and caller cancellation', async () => {
    let mode = 'date';
    const http = await fathomHttp((_request, response) => {
      if (mode === 'date') { response.writeHead(429, { 'retry-after': 'Mon, 26 Oct 2026 00:00:10 GMT' }); response.end(); }
      if (mode === 'invalid') response.end(JSON.stringify({ items: [{ recording_id: 'invented' }], next_cursor: null }));
    }); cleanup.push(http.close);
    const client = new FathomClient({ apiKey: 'key', baseUrl: http.baseUrl, timeoutMs: 30, clock: { now: () => new Date('2026-10-26T00:00:00Z') } });
    await expect(client.listMeetings(bounds)).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: 10000 });
    mode = 'invalid'; await expect(client.listMeetings(bounds)).rejects.toMatchObject({ code: 'invalid_response' });
    mode = 'hang'; await expect(client.listMeetings(bounds)).rejects.toMatchObject({ code: 'timeout' });
    await expect(client.listMeetings(bounds, AbortSignal.abort())).rejects.toMatchObject({ code: 'aborted' });
  });
  it('refuses redirects so the API key cannot follow a provider redirect', async () => {
    let requests = 0;
    const http = await fathomHttp((_request, response) => { requests++; response.writeHead(307, { location: '/capture-secret' }); response.end(); }); cleanup.push(http.close);
    await expect(new FathomClient({ apiKey: 'secret', baseUrl: http.baseUrl }).listMeetings(bounds)).rejects.toMatchObject({ code: 'unavailable' });
    expect(requests).toBe(1);
  });
});

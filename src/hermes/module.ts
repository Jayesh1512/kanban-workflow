import type { FastifyInstance } from 'fastify';
import type { DomainServices } from '../shared/ports.js';
import { DomainError } from '../shared/api.js';
import { createBindings } from './bindings.js';
import { registerHttp } from './http.js';
import { registerMcp } from './mcp.js';

/** One domain service graph, no scheduler/subscriber/provider construction here. */
export function registerTransports(app: FastifyInstance, services: DomainServices, ready: () => Promise<void>) {
  let stopped = false; const calls = new Set<Promise<unknown>>();
  async function track<T>(work: () => Promise<T>): Promise<T> {
    if (stopped) throw new DomainError('upstream_unavailable', 'Workflow transport is stopping', true);
    const result = Promise.resolve().then(work); calls.add(result); try { return await result; } finally { calls.delete(result); }
  }
  registerHttp(app, createBindings(services, 'http'), ready, track);
  const mcp = registerMcp(app, createBindings(services, 'mcp'), ready, track);
  return { async close() { stopped = true; await mcp.close(); await Promise.allSettled([...calls]); } };
}

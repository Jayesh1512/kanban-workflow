import type { FastifyInstance } from 'fastify';
import type { ServiceStatus } from '../shared/domain.js';

/** Extends A's existing successful status response; never shadows its route/payload. */
export function registerStatus(app: FastifyInstance, components: () => Promise<Record<string, ServiceStatus>>): void {
  app.addHook('preSerialization', async (request, reply, payload) => {
    if (request.method !== 'GET' || request.routeOptions.url !== '/api/status' || reply.statusCode < 200 || reply.statusCode >= 300 || !payload || typeof payload !== 'object' || !('components' in payload)) return payload;
    const previous = payload.components; if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return payload;
    return { ...payload, components: { ...previous, ...await components() } };
  });
}

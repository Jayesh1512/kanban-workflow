import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_OPERATIONS, DomainError, ERROR_HTTP_STATUS } from '../shared/api.js';
import { apiError, type Binding } from './bindings.js';

/** HTTP path IDs are authoritative; contradictory duplicate body IDs are invalid. */
function inputFor(request: FastifyRequest): Record<string, unknown> {
  const query = request.query as Record<string, unknown>; const params = request.params as Record<string, unknown>;
  let body: Record<string, unknown> = {};
  if (request.body !== undefined && request.body !== null) {
    if (typeof request.body !== 'object' || Array.isArray(request.body)) throw new DomainError('validation', 'Expected a JSON object');
    body = request.body as Record<string, unknown>;
  }
  if (request.method === 'GET' && Object.keys(body).length) throw new DomainError('validation', 'GET operations use query parameters');
  if (request.method !== 'GET' && Object.keys(query).length) throw new DomainError('validation', 'Mutation operations use JSON bodies');
  for (const [key, value] of Object.entries(params)) {
    if (body[key] !== undefined && body[key] !== value) throw new DomainError('validation', 'Body ID differs from route ID');
    if (query[key] !== undefined && query[key] !== value) throw new DomainError('validation', 'Query ID differs from route ID');
  }
  const input = { ...(request.method === 'GET' ? query : body), ...params };
  if (request.method === 'GET' && typeof input.limit === 'string') {
    if (!/^\d+$/.test(input.limit)) throw new DomainError('validation', 'Invalid page limit'); input.limit = Number(input.limit);
  }
  return input;
}
export function registerHttp(app: FastifyInstance, bindings: Record<string, Binding>, ready: () => Promise<void>, track: <T>(work: () => Promise<T>) => Promise<T>): void {
  for (const operation of API_OPERATIONS) {
    if (operation.service.startsWith('chats.')) continue;
    app.route({ method: operation.method, url: operation.path,
      errorHandler(error, request, reply) { const invalid = 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500; const result = apiError(invalid ? new DomainError('validation', 'Invalid request') : error, request.id); return reply.code(ERROR_HTTP_STATUS[result.error.code]).send(result); },
      async handler(request, reply) {
        try { return await track(() => bindings[operation.service]!.call(inputFor(request), ready)); }
        catch (error) { const result = apiError(error, request.id); return reply.code(ERROR_HTTP_STATUS[result.error.code]).send(result); }
      },
    });
  }
}

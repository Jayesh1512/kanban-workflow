import Fastify from 'fastify';
import { ZodError } from 'zod';
import { DomainError, ERROR_HTTP_STATUS } from './shared/api.js';
import type { ApplicationModule } from './shared/ports.js';

export interface AppOptions { modules?: ApplicationModule[]; logger?: boolean }

/** Pure construction: no listen, credentials, database, or external writes. */
export async function buildApp({ modules = [], logger = false }: AppOptions = {}) {
  const app = Fastify({ logger, bodyLimit: 1_048_576 });
  const names = modules.map((m) => m.name);
  if (new Set(names).size !== names.length) throw new Error('Duplicate application module name');
  app.setErrorHandler((error, request, reply) => {
    const invalid = error instanceof ZodError || (error instanceof Error && ('validation' in error || ('statusCode' in error && error.statusCode === 400)));
    const domain = error instanceof DomainError ? error : invalid
      ? new DomainError('validation', 'Invalid request') : new DomainError('internal', 'Internal server error');
    if (domain.code === 'internal') request.log.error({ err: error }, 'Request failed');
    return reply.code(ERROR_HTTP_STATUS[domain.code]).send({ error: { code: domain.code, message: domain.message, retryable: domain.retryable, requestId: request.id } });
  });
  app.get('/health/live', async () => ({ status: 'ok', service: 'antseed-kanban' }));
  app.get('/health/ready', async (_request, reply) => {
    const states = await Promise.all(modules.map(async (m) => ({ name: m.name, ...await m.status() })));
    const ready = states.length > 0 && states.every((s) => s.state === 'ready');
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', modules: states, detail: states.length ? null : 'Domain modules are not configured in the M0 foundation' });
  });
  let stopped = false;
  try { for (const module of modules) await module.register(app); }
  catch (error) { await stopModules(); await app.close(); throw error; }
  app.addHook('onReady', async () => {
    try { for (const module of modules) await module.start(); }
    catch (error) { await stopModules(); throw error; }
  });
  async function stopModules() {
    if (stopped) return;
    stopped = true;
    const errors: unknown[] = [];
    for (const module of [...modules].reverse()) {
      try { await module.stop(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Module shutdown failed');
  }
  app.addHook('onClose', stopModules);
  return app;
}

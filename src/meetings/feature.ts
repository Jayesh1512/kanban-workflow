import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DomainError, ERROR_HTTP_STATUS } from '../shared/api.js';
import { apiError } from '../hermes/bindings.js';
import type { PlatformServices } from '../shared/ports.js';
import type { MeetingConfig, MeetingTaskPort } from './domain.js';
import { MEETING_SCHEMA_VERSION } from './domain.js';
import { MeetingRepository } from './repository.js';
import { fathomMeetingSchema } from './fathom.js';
import { MeetingSync } from './sync.js';
import { MeetingTaskPublisher } from './tasks.js';
import { VikunjaMeetingTaskAdapter } from './vikunja.js';
import { registerFathomWebhook } from './webhook.js';
import { setMeetingCustomersSchema } from './schemas.js';
import { meetingPage } from './page.js';

export const disabledMeetingConfig: MeetingConfig = {
  enabled: false, apiKey: null, webhookSecret: null, pollIntervalMs: 300_000,
  timeoutMs: 30_000, internalDomains: [], projectId: null,
};
const importRequest = z.strictObject({
  idempotencyKey: z.string().trim().min(1).max(200),
  createdAfter: z.iso.datetime({ offset: true }).optional(),
  createdBefore: z.iso.datetime({ offset: true }).optional(),
});

/** Shares storage and readiness with the incumbent workflow; owns no Telegram or board cards. */
export function createMeetingFeature(platform: Pick<PlatformServices, 'db' | 'clock' | 'config'>, options: { demo?: boolean; taskPort?: MeetingTaskPort | null } = {}) {
  const config = platform.config.meetings ?? disabledMeetingConfig;
  const archive = new MeetingRepository(platform.db, platform.clock, { internalDomains: config.internalDomains });
  const sync = new MeetingSync(platform.db, archive, config, platform.clock);
  const taskPort = options.taskPort === undefined
    ? new VikunjaMeetingTaskAdapter(platform.db, platform.config.vikunja, { projectId: config.projectId })
    : options.taskPort;
  const publisher = new MeetingTaskPublisher(platform.db, taskPort, platform.clock);
  return {
    archive, sync, publisher,
    async tick(signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      const results = await Promise.allSettled([sync.tick(signal), publisher.tick(signal)]);
      signal?.throwIfAborted();
      if (results.some(result => result.status === 'rejected')) throw new Error('Meeting synchronization is waiting for retry');
    },
    async status() {
      const [source, tasks] = await Promise.all([sync.status(), publisher.status()]);
      return { schemaVersion: MEETING_SCHEMA_VERSION, mode: options.demo ? 'demo' : 'live', taskMode: 'automatic', timezone: platform.config.timezone, source, tasks };
    },
    async register(app: FastifyInstance, ready: () => Promise<void>): Promise<void> {
      app.get('/meetings', async (_request, reply) => reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(meetingPage));
      app.get('/api/meetings/status', async (_request, reply) => { await ready(); return reply.header('Cache-Control', 'no-store').send(await this.status()); });
      app.post('/api/meetings/sync', async request => {
        const input = importRequest.parse(request.body); await ready();
        return sync.requestImport({ idempotencyKey: input.idempotencyKey, ...(input.createdAfter ? { createdAfter: input.createdAfter } : {}), ...(input.createdBefore ? { createdBefore: input.createdBefore } : {}) });
      });
      app.post('/api/meetings/import', { bodyLimit: 20 * 1024 * 1024, errorHandler(error, request, reply) {
        const tooLarge = error.code === 'FST_ERR_CTP_BODY_TOO_LARGE';
        const result = apiError(tooLarge ? new DomainError('validation', 'Meeting import exceeds the 20 MiB request limit') : error, request.id);
        return reply.code(tooLarge ? 413 : ERROR_HTTP_STATUS[result.error.code]).send(result);
      } }, async request => {
        const input = z.strictObject({ meetings: z.array(fathomMeetingSchema).min(1).max(200) }).parse(request.body);
        await ready();
        return { schemaVersion: MEETING_SCHEMA_VERSION, ...await archive.ingestPage(input.meetings, { origin: 'manual' }) };
      });
      app.put('/api/meetings/:id/customers', async request => {
        const params = z.strictObject({ id: z.uuid() }).parse(request.params);
        const body = z.strictObject({ companyIds: z.array(z.uuid()).max(30), expectedVersion: z.number().int().nonnegative(), reason: z.string().trim().min(1).max(2000) }).parse(request.body);
        const input = setMeetingCustomersSchema.parse({ ...body, id: params.id });
        await ready(); return archive.setCustomers(input);
      });
      await registerFathomWebhook(app, { db: platform.db, secret: config.webhookSecret, clock: platform.clock, ready });
    },
  };
}

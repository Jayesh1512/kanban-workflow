import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { createModel, createMovementProvider } from './agent/index.ts';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { buildConnectors } from './connectors/registry.ts';
import { AppError } from './contracts/index.ts';
import { createOpLog } from './log/operational.ts';
import { openDb } from './store/index.ts';

const config = loadConfig(process.env);
const now = () => new Date();
const sleep = async (ms: number) => {
  await setTimeout(ms);
};
const oplog = createOpLog(now, (line) => process.stderr.write(line));
const db = openDb(join(config.dataDir, 'kanban.db'));
const model = await createModel(config.model, { db, oplog });
const movement = await createMovementProvider(config.movement, {
  db,
  oplog,
  now,
  sleep,
  http: {
    async post() {
      throw new AppError('invalid', 'not built: movementHttp');
    },
  },
});
const app = createApp({ db, model, movement, config, now, sleep, oplog, connectors: buildConnectors(config) });
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });
await app.start();
process.once('SIGTERM', () => {
  server.close(() => {
    void app.stop().then(() => db.close());
  });
});

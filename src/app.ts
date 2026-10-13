import { createPipeline } from './agent/index.ts';
import type { App, AppDeps } from './contracts/index.ts';
import { createHost } from './ingest/index.ts';
import { createMcp } from './mcp/index.ts';
import { createWeb } from './web/index.ts';

export type { App, AppDeps } from './contracts/index.ts';

export function createApp(deps: AppDeps): App {
  const pipeline = createPipeline({
    db: deps.db,
    model: deps.model,
    modelMaxAttempts: deps.config.model.maxAttempts,
    movement: deps.movement,
    now: deps.now,
    sleep: deps.sleep,
    oplog: deps.oplog,
  });
  const host = createHost(deps);
  const web = createWeb({ ...deps, host, pipeline });
  const mcp = createMcp(deps);
  return {
    host,
    pipeline,
    fetch: (req) => (new URL(req.url).pathname === '/mcp' ? mcp.fetch(req) : web.fetch(req)),
    async start() {
      await host.startAll();
      pipeline.start();
    },
    async stop() {
      await pipeline.stop();
      await host.stopAll();
    },
  };
}

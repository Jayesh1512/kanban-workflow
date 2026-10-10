import { createPipeline } from './agent/index.ts';
import type { App, AppDeps } from './contracts/index.ts';
import { createHost } from './ingest/index.ts';
import { createMcp } from './mcp/index.ts';
import { createWeb } from './web/index.ts';

export type { App, AppDeps } from './contracts/index.ts';

export function createApp(deps: AppDeps): App {
  const host = createHost(deps);
  const pipeline = createPipeline(deps);
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

import { buildApp } from './app.js';
import { createModules } from './composition.js';

const port = Number(process.env['PORT'] ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer in 1..65535');
const app = await buildApp({ modules: await createModules(), logger: true });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try { await app.close(); } catch (error) { app.log.error(error); process.exitCode = 1; }
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
try { await app.listen({ port, host: process.env['HOST'] ?? '127.0.0.1' }); }
catch (error) { app.log.error(error); process.exitCode = 1; await shutdown(); }

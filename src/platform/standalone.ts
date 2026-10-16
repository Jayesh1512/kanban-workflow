/** M1-only integration harness. PM-owned production composition replaces this after integration. */
import { buildApp } from '../app.js';
import { loadRuntimeConfig } from './config.js';
import { createPlatformModule } from './module.js';

const config = await loadRuntimeConfig();
const platform = await createPlatformModule(config);
const app = await buildApp({ modules: [platform] });
process.once('SIGTERM', () => { void app.close(); });
process.once('SIGINT', () => { void app.close(); });
try { await app.listen(config.http); }
catch { await app.close(); process.exitCode = 1; }

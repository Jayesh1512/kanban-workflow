import { writeFile } from 'node:fs/promises';
import { nativeFixture } from './fixture.js';

// Explicit synthetic local demo for the installed Hermes CLI, never production data.
const h = await nativeFixture(); const url = await h.app.listen({ host: '127.0.0.1', port: 4937 });
await writeFile('/tmp/antseed-b-m4-public.json', JSON.stringify({ url, companyId: h.h.ticket.companyId, ticketId: h.h.ticket.id, evidenceId: h.h.evidenceId, query: 'AntSeed M4 Synthetic Cedar' }));
console.log('Synthetic MCP demo listening on loopback port 4937; no live AI/Telegram credentials loaded');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void h.close().then(() => process.exit(0), () => process.exit(1)); });

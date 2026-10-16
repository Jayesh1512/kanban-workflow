import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** Official SDK client with a strict-optional callback bridge (no protocol stand-in). */
export async function connectClient(url: string) {
  const client = new Client({ name: 'antseed-contract-client', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', url));
  const wire: Transport = { start: () => transport.start(), send: (message, options) => transport.send(message, options), close: () => transport.close(), setProtocolVersion: (version) => transport.setProtocolVersion(version) };
  transport.onmessage = (message) => wire.onmessage?.(message);
  transport.onclose = () => wire.onclose?.(); transport.onerror = (error) => wire.onerror?.(error);
  await client.connect(wire); return client;
}

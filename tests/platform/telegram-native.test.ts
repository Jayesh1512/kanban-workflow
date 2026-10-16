import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramClient } from '@mtcute/node';
import { LogManager } from '@mtcute/node/utils.js';
import { describe, expect, it } from 'vitest';

describe('actual pinned mtcute native session storage, offline and unauthenticated', () => {
  it('opens, closes and reopens its own persistent SQLite file with no RPC', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'antseed-m2-native-')), path = join(directory, 'client.session'); let calls = 0;
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        const client = new TelegramClient({ apiId: 1, apiHash: 'synthetic-offline-probe', storage: path, updates: false, logLevel: LogManager.OFF });
        client.call = async () => { calls++; throw new Error('Offline native probe forbids RPC'); };
        try { await client.prepare(); expect((await stat(path)).size).toBeGreaterThan(0); }
        finally { await client.destroy(); }
      }
      expect(calls).toBe(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

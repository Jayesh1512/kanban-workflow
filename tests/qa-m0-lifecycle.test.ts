import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ApplicationModule } from '../src/shared/ports.js';

// Probe real foundation cleanup, including modules that never reached start/register.
function probe(name: string, events: string[], fail?: 'register' | 'start' | 'stop'): ApplicationModule {
  return {
    name,
    async register() { events.push(`register:${name}`); if (fail === 'register') throw new Error('register probe'); },
    async start() { events.push(`start:${name}`); if (fail === 'start') throw new Error('start probe'); },
    async stop() { events.push(`stop:${name}`); if (fail === 'stop') throw new Error('stop probe'); },
    async status() { return { state: 'ready', code: null, detail: null, checkedAt: '2026-10-17T00:00:00Z' }; },
  };
}

describe('QA M0 partial lifecycle cleanup', () => {
  it('releases the never-registered dependent when platform registration fails', async () => {
    const events: string[] = [];
    await expect(buildApp({ modules: [probe('platform', events, 'register'), probe('workflow', events)] })).rejects.toThrow('register probe');
    expect(events).toEqual(['register:platform', 'stop:workflow', 'stop:platform']);
  });

  it('releases the never-started dependent once when the first start fails', async () => {
    const events: string[] = [];
    const app = await buildApp({ modules: [probe('platform', events, 'start'), probe('workflow', events)] });
    try {
      await expect(app.ready()).rejects.toThrow('start probe');
    } finally {
      await app.close();
      await app.close();
    }
    expect(events).toEqual(['register:platform', 'register:workflow', 'start:platform', 'stop:workflow', 'stop:platform']);
  });

  it('still stops platform when dependent shutdown throws', async () => {
    const events: string[] = [];
    const app = await buildApp({ modules: [probe('platform', events), probe('workflow', events, 'stop')] });
    await app.ready();
    await expect(app.close()).rejects.toBeInstanceOf(AggregateError);
    expect(events.slice(-2)).toEqual(['stop:workflow', 'stop:platform']);
    expect(events.filter((e) => e === 'stop:platform')).toHaveLength(1);
  });
});

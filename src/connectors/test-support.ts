import type { ConnectorContext, ConnectorEvent } from '../contracts/index.ts';
export function testContext(session: string | null = null, accountId = 1) {
  let atMs = 0;
  const sleeps: number[] = [];
  const saved: (string | null)[] = [];
  const logs: unknown[] = [];
  const ctx: ConnectorContext = {
    accountId,
    session,
    config: {},
    saveSession(value) {
      saved.push(value);
    },
    now: () => new Date(atMs),
    async sleep(ms) {
      sleeps.push(ms);
      atMs += ms;
    },
    log: (level, event, fields) => {
      logs.push({ level, event, fields });
    },
  };
  const events: ConnectorEvent[] = [];
  return {
    ctx,
    sleeps,
    saved,
    logs,
    events,
    sink: {
      async emit(event: ConnectorEvent) {
        events.push(structuredClone(event));
      },
    },
  };
}

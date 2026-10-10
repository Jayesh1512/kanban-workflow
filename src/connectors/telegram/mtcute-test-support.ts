import type { TelegramTransport } from '@mtcute/node';
import { IntermediatePacketCodec } from '@mtcute/node';
import { testContext } from '../test-support.ts';

export function offlineContext() {
  const state = testContext();
  state.ctx.config = { API_ID: '123', API_HASH: 'synthetic', APP_OWNER: 'Owner' };
  const waits: { ms: number; resolve(): void }[] = [];
  state.ctx.sleep = (ms) =>
    new Promise<void>((resolve) => {
      waits.push({ ms, resolve });
    });
  return { ...state, waits };
}
export const blockedTransport: TelegramTransport = {
  packetCodec: () => new IntermediatePacketCodec(),
  async connect() {
    throw new Error('Offline transport must never connect');
  },
};

import type { AppConfig, ConnectorFactory } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
import { createFixtureConnector } from './fixture/index.ts';
import { createTelegramFactory, MtcuteApi } from './telegram/index.ts';

export function buildConnectors(config: AppConfig): ConnectorFactory[] {
  return Object.entries(config.connectors).map(([channel, options]) => {
    if (channel === 'fixture') {
      if (!options.PATH) throw new AppError('invalid', 'FIXTURE_PATH is required');
      const { factory, control } = createFixtureConnector({ path: options.PATH });
      return {
        ...factory,
        create(ctx) {
          const connector = factory.create(ctx);
          return {
            ...connector,
            async start(sink) {
              await connector.start(sink);
              await control.advanceTo('end');
            },
          };
        },
      };
    }
    if (channel === 'telegram') return createTelegramFactory((ctx) => new MtcuteApi(ctx));
    throw new AppError('invalid', 'Unknown connector');
  });
}

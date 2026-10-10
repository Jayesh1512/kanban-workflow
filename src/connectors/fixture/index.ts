import { readFileSync } from 'node:fs';
import type { ConnectorFactory, FixtureControl, FixtureLine } from '../../contracts/index.ts';
import { AppError, FixtureLineSchema } from '../../contracts/index.ts';

export type { FixtureControl, FixtureLine } from '../../contracts/index.ts';

export function createFixtureConnector(source: { path: string } | { lines: FixtureLine[] }): {
  factory: ConnectorFactory;
  control: FixtureControl;
} {
  const lines =
    'lines' in source
      ? source.lines
      : readFileSync(source.path, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => FixtureLineSchema.parse(JSON.parse(line)));
  for (const line of lines) FixtureLineSchema.parse(line);
  const control: FixtureControl = {
    calls: [],
    async advanceTo(mark) {
      if (mark !== 'end' && !lines.some((line) => line.t === 'mark' && line.name === mark))
        throw new AppError('invalid', 'Unknown fixture mark');
    },
  };
  const factory: ConnectorFactory = {
    channel: 'fixture',
    label: 'Synthetic fixture',
    capabilities: { history: true, edits: true, deletions: true },
    pace: { minRequestIntervalMs: 0, pageSize: 100 },
    loginNotice: () => null,
    create() {
      return {
        async login() {
          throw new AppError('invalid', 'not built: login');
        },
        async start() {
          throw new AppError('invalid', 'not built: start');
        },
        async stop() {
          throw new AppError('invalid', 'not built: stop');
        },
        async logout() {
          throw new AppError('invalid', 'not built: logout');
        },
        async listChats() {
          throw new AppError('invalid', 'not built: listChats');
        },
        fetchHistory() {
          throw new AppError('invalid', 'not built: fetchHistory');
        },
      };
    },
  };
  return { factory, control };
}

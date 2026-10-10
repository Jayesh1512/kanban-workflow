import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { addTeammate } from './auth/index.ts';
import { loadConfig } from './config.ts';
import { AppError } from './contracts/index.ts';
import { openDb } from './store/index.ts';

const [command, username] = process.argv.slice(2);
if (command !== 'teammate:add') throw new AppError('invalid', `not built: ${command ?? 'cli'}`);
if (!username) throw new AppError('invalid', 'A username is required');
const config = loadConfig(process.env);
const db = openDb(join(config.dataDir, 'kanban.db'));
const terminal = createInterface({ input: process.stdin, output: process.stderr });
try {
  const displayName = await terminal.question('Display name: ');
  const password = randomBytes(24).toString('base64url');
  addTeammate(
    { db, actor: { kind: 'system' }, canReadText: true, now: () => new Date() },
    { username, displayName, password },
  );
  process.stdout.write(`Initial password (shown once): ${password}\n`);
} finally {
  terminal.close();
  db.close();
}

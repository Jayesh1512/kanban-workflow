import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Ctx, Db, Id, IsoTime } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
import { record } from '../log/index.ts';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function human(ctx: Ctx): void {
  if (ctx.actor.kind === 'system') return;
  requireTeammate(ctx);
}
export function requireTeammate(ctx: Ctx): Id {
  if (
    ctx.actor.kind !== 'teammate' ||
    !ctx.db.get('SELECT id FROM teammate WHERE id=? AND removed_at IS NULL', ctx.actor.id)
  )
    throw new AppError('forbidden', 'Active teammate required');
  return ctx.actor.id;
}
function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('invalid', 'Invalid auth input');
  return parsed.data;
}
export function addTeammate(ctx: Ctx, i: { username: string; displayName: string; password: string }): Id {
  human(ctx);
  i = validate(
    z.strictObject({
      username: z.string().trim().min(1).max(200),
      displayName: z.string().trim().min(1).max(200),
      password: z.string().min(1).max(4096),
    }),
    i,
  );
  return ctx.db.tx(() => {
    if (ctx.db.get('SELECT id FROM teammate WHERE username=?', i.username))
      throw new AppError('conflict', 'Username exists');
    const salt = randomBytes(16);
    const passwordHash = `scrypt$${salt.toString('base64')}$${scryptSync(i.password, salt, 64).toString('base64')}`;
    const id = ctx.db.run(
      'INSERT INTO teammate(username,display_name,password_hash,created_at) VALUES (?,?,?,?)',
      i.username,
      i.displayName,
      passwordHash,
      ctx.now().toISOString(),
    ).lastInsertRowid;
    record(ctx, {
      action: 'teammate.add',
      subjectKind: 'teammate',
      subjectId: id,
      after: { username: i.username, displayName: i.displayName },
    });
    return id;
  });
}
export function signIn(db: Db, username: string, password: string, now: Date): { token: string; expiresAt: IsoTime } {
  if (
    typeof username !== 'string' ||
    typeof password !== 'string' ||
    password.length > 4096 ||
    !Number.isFinite(now.getTime())
  )
    throw new AppError('unauthenticated', 'Invalid sign-in');
  const user = db.get<{ id: Id; password_hash: string }>(
    'SELECT id,password_hash FROM teammate WHERE username=? AND removed_at IS NULL',
    username,
  );
  const [method, salt, stored] = (user?.password_hash ?? '').split('$');
  const actual = scryptSync(password, Buffer.from(salt ?? 'synthetic-invalid-salt', 'base64'), 64);
  const expected = Buffer.from(stored ?? '', 'base64');
  if (!user || method !== 'scrypt' || expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new AppError('unauthenticated', 'Invalid sign-in');
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
  db.tx(() =>
    db.run(
      'INSERT INTO web_session(token_hash,teammate_id,created_at,expires_at) VALUES (?,?,?,?)',
      hash(token),
      user.id,
      now.toISOString(),
      expiresAt,
    ),
  );
  return { token, expiresAt };
}
export function teammateForSession(db: Db, token: string, now: Date): Id | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !Number.isFinite(now.getTime())) return null;
  return (
    db.get<{ id: Id }>(
      'SELECT t.id FROM web_session s JOIN teammate t ON t.id=s.teammate_id WHERE s.token_hash=? AND s.expires_at>? AND t.removed_at IS NULL',
      hash(token),
      now.toISOString(),
    )?.id ?? null
  );
}
export function createCredential(
  ctx: Ctx,
  i: { name: string; scopeMessages: boolean; scopeWrite?: boolean },
): { id: Id; token: string } {
  const owner = requireTeammate(ctx);
  i = validate(
    z.strictObject({
      name: z.string().trim().min(1).max(200),
      scopeMessages: z.boolean(),
      scopeWrite: z.boolean().optional(),
    }),
    i,
  );
  return ctx.db.tx(() => {
    if (ctx.db.get('SELECT id FROM credential WHERE name=?', i.name))
      throw new AppError('conflict', 'Credential name exists');
    const secret = randomBytes(32).toString('base64url');
    const id = ctx.db.run(
      'INSERT INTO credential(name,token_hash,scope_messages,scope_write,created_by,created_at) VALUES (?,?,?,?,?,?)',
      i.name,
      hash(secret),
      Number(i.scopeMessages),
      Number(i.scopeWrite ?? false),
      owner,
      ctx.now().toISOString(),
    ).lastInsertRowid;
    record(ctx, {
      action: 'credential.create',
      subjectKind: 'credential',
      subjectId: id,
      after: { name: i.name, scopeMessages: i.scopeMessages, scopeWrite: i.scopeWrite ?? false },
    });
    return { id, token: `kbn_${id}_${secret}` };
  });
}
export function credentialForToken(
  db: Db,
  token: string,
): { id: Id; scopeMessages: boolean; scopeWrite: boolean } | null {
  const match = /^kbn_([1-9]\d*)_([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
  const row = db.get<{ id: Id; scope_messages: number; scope_write: number }>(
    'SELECT c.id,c.scope_messages,c.scope_write FROM credential c JOIN teammate t ON t.id=c.created_by WHERE c.id=? AND c.token_hash=? AND c.revoked_at IS NULL AND t.removed_at IS NULL',
    Number(match[1]),
    hash(match[2] as string),
  );
  return row ? { id: row.id, scopeMessages: Boolean(row.scope_messages), scopeWrite: Boolean(row.scope_write) } : null;
}
function settingSchema(key: string): z.ZodType {
  switch (key) {
    case 'review_threshold':
      return z.number().finite().min(0).max(1);
    case 'require_agreement':
    case 'keep_deleted_text':
      return z.boolean();
    case 'role_categories':
      return z
        .array(z.string().trim().min(1).max(200))
        .max(100)
        .min(1)
        .refine((v) => new Set(v).size === v.length && v.includes('unknown'));
    default:
      throw new AppError('invalid', 'Unknown setting');
  }
}
export function getSetting<T>(db: Db, key: string): T {
  const schema = settingSchema(key);
  const row = db.get<{ value: string }>('SELECT value FROM setting WHERE key=?', key);
  const defaults: Record<string, unknown> = {
    review_threshold: 1,
    require_agreement: true,
    keep_deleted_text: true,
    role_categories: [
      'decision maker',
      'commercial or procurement',
      'technical',
      'finance',
      'operations',
      'legal',
      'other',
      'unknown',
    ],
  };
  try {
    return validate(schema, row ? (JSON.parse(row.value) as unknown) : defaults[key]) as T;
  } catch {
    throw new AppError('invalid', 'Invalid stored setting');
  }
}
export function setSetting(ctx: Ctx, key: string, value: unknown): void {
  requireTeammate(ctx);
  const parsed = validate(settingSchema(key), value);
  ctx.db.tx(() => {
    const before = getSetting(ctx.db, key);
    ctx.db.run(
      'INSERT INTO setting(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      JSON.stringify(parsed),
    );
    record(ctx, {
      action: 'setting.update',
      subjectKind: 'setting',
      subjectId: null,
      before: { key, value: before },
      after: { key, value: parsed },
    });
  });
}
export function seal(key: Uint8Array, plaintext: string): Uint8Array {
  if (key.length !== 32) throw new AppError('invalid', 'Invalid sealing key');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}
export function open(key: Uint8Array, sealed: Uint8Array): string {
  if (key.length !== 32 || sealed.length < 28) throw new AppError('invalid', 'Invalid sealed session');
  try {
    const bytes = Buffer.from(sealed);
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    throw new AppError('invalid', 'Invalid sealed session');
  }
}

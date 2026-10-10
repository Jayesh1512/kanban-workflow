import type { z } from 'zod';
import type { Ctx, SetBy, WriteOpts } from '../contracts/index.ts';
import { AppError, WriteOptsSchema } from '../contracts/index.ts';

export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const p = schema.safeParse(value);
  if (!p.success) throw new AppError('invalid', 'Invalid graph input');
  return p.data;
}
export function by(ctx: Ctx, o?: WriteOpts): SetBy {
  if (o) validate(WriteOptsSchema, o);
  const result = o?.setBy ?? (ctx.actor.kind === 'agent' ? 'agent' : 'human');
  if (ctx.actor.kind === 'agent' && result === 'human')
    throw new AppError('forbidden', 'Agent cannot set human values');
  return result;
}

export function human(ctx: Ctx): void {
  if (ctx.actor.kind === 'agent' || ctx.actor.kind === 'system') throw new AppError('forbidden', 'Human required');
}

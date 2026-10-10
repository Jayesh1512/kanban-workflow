import { z } from 'zod';
import type { CompanyCandidate, CompanyMatch, Ctx, Db, Id } from '../contracts/index.ts';
import { AppError, IdSchema } from '../contracts/index.ts';
import { validate } from './helpers.ts';

export function normalizeCompanyName(name: string): string {
  if (typeof name !== 'string') throw new AppError('invalid', 'Invalid company name');
  const words = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const legal = [
    'inc',
    'llc',
    'ltd',
    'limited',
    'corp',
    'corporation',
    'co',
    'company',
    'gmbh',
    'pvt',
    'private',
    'plc',
    'sa',
    'ag',
    'bv',
  ];
  while (words.length && legal.includes(words.at(-1) ?? '')) words.pop();
  return words.join(' ');
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  return new Set(Array.from({ length: Math.max(0, padded.length - 2) }, (_, i) => padded.slice(i, i + 3)));
}
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const aw = a.split(' '),
    bw = b.split(' ');
  const short = aw.length <= bw.length ? aw : bw,
    long = aw.length <= bw.length ? bw : aw;
  if (short.every((w) => long.includes(w)) && short.some((w) => w.length >= 3)) return 0.9;
  const initials = (words: string[]) => words.map((w) => w[0] ?? '').join('');
  if ((a.length >= 2 && a === initials(bw)) || (b.length >= 2 && b === initials(aw))) return 0.8;
  const at = trigrams(a),
    bt = trigrams(b);
  const shared = [...at].filter((t) => bt.has(t)).length;
  const score = shared / new Set([...at, ...bt]).size;
  return score >= 0.6 ? score : 0;
}
interface NamedCompany {
  id: Id;
  name: string;
  name_norm: string;
  aliases: { alias: string; alias_norm: string }[];
  notSame: string[];
}
function companies(db: Db): NamedCompany[] {
  return db
    .all<{ id: Id; name: string; name_norm: string }>('SELECT id,name,name_norm FROM company ORDER BY id')
    .map((c) => ({
      ...c,
      aliases: db.all('SELECT alias,alias_norm FROM company_alias WHERE company_id=? ORDER BY alias_norm', c.id),
      notSame: db
        .all<{ name_norm: string }>('SELECT name_norm FROM company_not_same WHERE company_id=?', c.id)
        .map((r) => r.name_norm),
    }));
}
function match(c: NamedCompany, name: string): CompanyMatch {
  if (c.name_norm === name) return { match: 'exact', companyId: c.id, score: 1 };
  if (c.aliases.some((a) => a.alias_norm === name)) return { match: 'alias', companyId: c.id, score: 1 };
  const score = c.notSame.includes(name)
    ? 0
    : c.aliases.reduce((best, a) => Math.max(best, similarity(name, a.alias_norm)), similarity(name, c.name_norm));
  return score ? { match: 'similar', companyId: c.id, score } : { match: 'none', companyId: null, score: 0 };
}
export function resolveCompany(ctx: Ctx, name: string): CompanyMatch {
  const norm = normalizeCompanyName(name);
  if (!norm) return { match: 'none', companyId: null, score: 0 };
  const matches = companies(ctx.db).map((c) => match(c, norm));
  return (
    matches.find((m) => m.match === 'exact') ??
    matches.find((m) => m.match === 'alias') ??
    matches
      .filter((m) => m.match === 'similar')
      .sort((a, b) => b.score - a.score || (a.companyId ?? 0) - (b.companyId ?? 0))[0] ?? {
      match: 'none',
      companyId: null,
      score: 0,
    }
  );
}

export function candidateCompanies(ctx: Ctx, i: { chatId: Id; text: string; cardIds: Id[] }): CompanyCandidate[] {
  validate(z.strictObject({ chatId: IdSchema, text: z.string(), cardIds: z.array(IdSchema) }), i);
  if (!ctx.db.get('SELECT id FROM chat WHERE id=?', i.chatId)) throw new AppError('not_found', 'Chat not found');
  const all = companies(ctx.db),
    result: CompanyCandidate[] = [];
  const add = (id: Id, why: CompanyCandidate['why']) => {
    const c = all.find((c) => c.id === id);
    if (c && result.length < 15 && !result.some((r) => r.id === id))
      result.push({ id, name: c.name, aliases: c.aliases.map((a) => a.alias), why });
  };
  for (const r of ctx.db.all<{ company_id: Id }>(
    'SELECT DISTINCT cc.company_id FROM chat_participant cp JOIN identity pi ON pi.id=cp.identity_id JOIN contact_company cc ON cc.contact_id=pi.contact_id WHERE cp.chat_id=? AND cc.removed=0 ORDER BY cc.company_id',
    i.chatId,
  ))
    add(r.company_id, 'participant');
  const named = ctx.db.get<{ named_company_id: Id | null }>(
    'SELECT named_company_id FROM chat WHERE id=?',
    i.chatId,
  )?.named_company_id;
  if (named != null) add(named, 'named');
  for (const id of i.cardIds) {
    const c = ctx.db.get<{ company_id: Id | null }>('SELECT company_id FROM card WHERE id=?', id);
    if (c?.company_id != null) add(c.company_id, 'card');
  }
  const words = i.text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean);
  const runs = new Set<string>();
  for (let n = 1; n <= 4; n++)
    for (let start = 0; start + n <= words.length; start++) {
      const norm = normalizeCompanyName(words.slice(start, start + n).join(' '));
      if (norm) runs.add(norm);
    }
  const scored = all
    .map((c) => ({ id: c.id, score: [...runs].reduce((best, run) => Math.max(best, match(c, run).score), 0) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.id - b.id);
  for (const c of scored) add(c.id, 'text');
  return result;
}

export function companyVersion(db: Db): number {
  return (
    db.get<{ version: number }>(
      "SELECT coalesce(max(id),0) AS version FROM action_log WHERE action IN ('company.create','company.update','company.alias','company.not_same')",
    )?.version ?? 0
  );
}

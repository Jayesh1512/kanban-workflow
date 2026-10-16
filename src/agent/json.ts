import { createHash } from 'node:crypto';

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

/** Validate the original token stream before JSON.parse can discard duplicate fields. */
export function strictJson(text: string): unknown {
  let at = 0;
  function space() {
    while (/\s/.test(text[at] ?? '') && at < text.length) at++;
  }
  function string(): string {
    const start = at++;
    while (at < text.length) {
      const ch = text[at++];
      if (ch === '\\') at++;
      else if (ch === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    throw new SyntaxError('Invalid JSON');
  }
  function value(depth: number): void {
    if (depth > 100) throw new SyntaxError('Invalid JSON');
    space();
    const ch = text[at];
    if (ch === '"') {
      string();
      return;
    }
    if (ch === '{') {
      at++;
      space();
      const keys = new Set<string>();
      if (text[at] === '}') {
        at++;
        return;
      }
      for (;;) {
        space();
        if (text[at] !== '"') throw new SyntaxError('Invalid JSON');
        const key = string();
        if (keys.has(key)) throw new SyntaxError('Duplicate JSON field');
        keys.add(key);
        space();
        if (text[at++] !== ':') throw new SyntaxError('Invalid JSON');
        value(depth + 1);
        space();
        const next = text[at++];
        if (next === '}') return;
        if (next !== ',') throw new SyntaxError('Invalid JSON');
      }
    }
    if (ch === '[') {
      at++;
      space();
      if (text[at] === ']') {
        at++;
        return;
      }
      for (;;) {
        value(depth + 1);
        space();
        const next = text[at++];
        if (next === ']') return;
        if (next !== ',') throw new SyntaxError('Invalid JSON');
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    if (!token) throw new SyntaxError('Invalid JSON');
    at += token[0].length;
  }
  value(0);
  space();
  if (at !== text.length) throw new SyntaxError('Invalid JSON');
  return JSON.parse(text) as unknown;
}

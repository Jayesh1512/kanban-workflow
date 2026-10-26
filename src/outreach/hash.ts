import { createHash } from 'node:crypto';
/** Canonical ordering survives JSONB key reordering and driver round trips. */
export function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

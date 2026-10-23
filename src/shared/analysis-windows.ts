import { createHash } from 'node:crypto';
import type { SqlExecutor } from './ports.js';

export const ANALYSIS_WINDOW_MESSAGES = 20;
export const ANALYSIS_WINDOW_CHARACTERS = 16000;
export const ANALYSIS_MESSAGE_CHARACTERS = 8000;
export interface AnalysisSourceRow { id: number; version: number; text: string }
/** Partition, never omit, the immutable source revisions selected by ingestion. */
export function partitionAnalysisSources<T extends AnalysisSourceRow>(rows: T[]): T[][] {
  const windows: T[][] = []; let current: T[] = [], characters = 0;
  for (const row of rows) {
    const length = row.text.slice(0, ANALYSIS_MESSAGE_CHARACTERS).length;
    if (current.length && (current.length >= ANALYSIS_WINDOW_MESSAGES || characters + length > ANALYSIS_WINDOW_CHARACTERS)) { windows.push(current); current = []; characters = 0; }
    current.push(row); characters += length;
  }
  if (current.length) windows.push(current);
  return windows;
}
/** Caller holds the chat row, so policy/mapping cannot change during enqueue. */
export async function enqueueAnalysisWindows(tx: SqlExecutor, input: { chatId: string; policyVersion: number; mappingVersion: number; rows: AnalysisSourceRow[]; createdAt?: string; retryAt?: string }): Promise<number> {
  let inserted = 0;
  for (const window of partitionAnalysisSources(input.rows)) {
    const key = createHash('sha256').update(JSON.stringify({ format: 'analysis-window.v1', chatId: input.chatId, policy: input.policyVersion, mapping: input.mappingVersion, messages: window.map(({ id, version }) => ({ id, version })) })).digest('hex');
    const job = (await tx.query<{ id: string }>(`INSERT INTO analysis_jobs(chat_id,policy_version,mapping_version,dedupe_key,created_at,retry_at) VALUES($1,$2,$3,$4,COALESCE($5::timestamptz,now()),$6::timestamptz) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`, [input.chatId, input.policyVersion, input.mappingVersion, key, input.createdAt ?? null, input.retryAt ?? null])).rows[0];
    if (!job) continue;
    for (const row of window) await tx.query('INSERT INTO analysis_job_messages(job_id,chat_id,message_id,message_version) VALUES($1,$2,$3,$4)', [job.id, input.chatId, row.id, row.version]);
    inserted++;
  }
  return inserted;
}

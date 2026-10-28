import type { SqlExecutor } from '../shared/ports.js';
import { companyFromGroupTitle } from '../shared/company-title.js';
import { crmFirstEnabled } from '../shared/crm-first.js';
import { enqueueAnalysisWindows, type AnalysisSourceRow } from '../shared/analysis-windows.js';

export const TITLE_COMPANY_SOURCE = 'structured_group_title:v1';
/** Rows always lock chat -> ticket before
 * directory/mapping writes, and no message evidence or lane change is fabricated. */
export async function resolveTitleCompany(tx: SqlExecutor, chatId: string): Promise<boolean> {
  const chat = (await tx.query('SELECT * FROM chats WHERE id=$1 FOR UPDATE', [chatId])).rows[0];
  if (!chat || chat['is_control'] || chat['inclusion'] !== 'included' || chat['company_id'] != null
    || !['unresolved','ambiguous'].includes(String(chat['mapping_status']))) return false;
  const name = companyFromGroupTitle(String(chat['kind']), String(chat['title']));
  if (!name || (await tx.query("SELECT 1 FROM mapping_history WHERE chat_id=$1 AND source<>'analysis' LIMIT 1", [chatId])).rowCount) return false;
  const ticket = (await tx.query('SELECT id FROM tickets WHERE chat_id=$1 FOR UPDATE', [chatId])).rows[0];
  if (!ticket && !await crmFirstEnabled(tx)) return false;
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('directory:analysis',0))");
  const matches = (await tx.query(`SELECT id FROM companies WHERE lower(canonical_name)=lower($1)
    OR EXISTS(SELECT 1 FROM unnest(aliases) alias WHERE lower(alias)=lower($1))`, [name])).rows;
  if (matches.length > 1) return false;
  const companyId = matches[0]?.['id'] ?? (await tx.query('INSERT INTO companies(canonical_name) VALUES($1) RETURNING id', [name])).rows[0]!['id'];
  const version = Number(chat['mapping_version']) + 1;
  await tx.query("UPDATE chats SET company_id=$2,mapping_status='confirmed',mapping_version=$3,updated_at=now() WHERE id=$1", [chatId,companyId,version]);
  await tx.query("INSERT INTO mapping_history(chat_id,company_id,mapping_status,version,reason,source) VALUES($1,$2,'confirmed',$3,$4,'analysis')", [chatId,companyId,version,`${TITLE_COMPANY_SOURCE} ${JSON.stringify({title:chat['title'],companyName:name})}`]);
  await tx.query("UPDATE tickets SET company_id=$2,kind='company',tracking_state='active',updated_at=now() WHERE chat_id=$1", [chatId,companyId]);
  await tx.query("UPDATE analysis_jobs SET status='cancelled',worker_id=NULL,lease_until=NULL,last_error='title_company_mapping_changed',updated_at=now() WHERE chat_id=$1 AND status NOT IN ('completed','cancelled')", [chatId]);
  if (ticket) await tx.query(`UPDATE proposals SET apply_state=CASE WHEN apply_state IN ('applying','reconciling') THEN 'reconciling' ELSE 'stale' END,last_error='title_company_mapping_changed',updated_at=now()
    WHERE ticket_id=$1 AND apply_state<>'applied'`, [ticket['id']]);
  const rows=(await tx.query<AnalysisSourceRow>('SELECT id,version,text FROM messages WHERE chat_id=$1 AND deleted_at IS NULL AND length(text)>0 ORDER BY sent_at DESC,id DESC LIMIT 100',[chatId])).rows;
  await enqueueAnalysisWindows(tx,{chatId,policyVersion:Number(chat['policy_version']),mappingVersion:version,rows});
  return true;
}

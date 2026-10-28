import { randomUUID } from 'node:crypto';
import { tl } from '@mtcute/node';
import type { ServiceStatus } from '../shared/domain.js';
import type { PgDatabase } from '../platform/database.js';
import type { TelegramStore } from './store.js';
import { automaticPolicy } from '../shared/automatic-policy.js';
import { queueIntake } from './intake.js';
export interface ConversationStart { at:string|null; messageId:number|null; uncertain:boolean; reason:string }
export interface ConversationReader { conversationStart(chatId:string,cutoff:string):Promise<ConversationStart> }
const scopedAccess=(error:unknown)=>tl.RpcError.is(error)&&/^(CHANNEL_PRIVATE|CHANNEL_INVALID|CHAT_FORBIDDEN|CHAT_ID_INVALID|PEER_ID_INVALID|USER_BANNED_IN_CHANNEL|CHANNEL_PUBLIC_GROUP_NA|CHAT_ADMIN_REQUIRED)$/.test(error.text);

/** One bounded metadata/history-boundary probe; no RPC runs inside a transaction. */
export class AutomaticIntake {
 constructor(private readonly db:PgDatabase,private readonly store:TelegramStore,private readonly telegram:ConversationReader){}
 async tick():Promise<void>{
  const policy=await automaticPolicy(this.db);if(!policy)return;
  // Classify proven older chats in one local query instead of spending one
  // rate-limited Telegram probe on each inactive historical conversation.
  await this.db.query(`UPDATE telegram_conversation_starts s SET state='older',checked_cutoff=$1,
    reason='existing_source_before_cutoff',claim_token=NULL,lease_until=NULL,next_check_at=now()+interval '1 day',updated_at=now()
    FROM chats c WHERE c.id=s.chat_id AND NOT c.is_control AND c.inclusion<>'excluded'
    AND (s.checked_cutoff IS DISTINCT FROM $1::timestamptz OR s.state IN ('pending','error'))
    AND (s.lease_until IS NULL OR s.lease_until<now()) AND (s.latest_message_at<$1::timestamptz
      OR EXISTS(SELECT 1 FROM messages m WHERE m.chat_id=s.chat_id AND m.sent_at<$1::timestamptz))`,[policy.cutoff]);
  const token=randomUUID();
  const row=await this.db.transaction(async tx=>{
   // This global throttle is durable across restarts and concurrent workers.
   await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('antseed:automatic-scan-dispatch',0))");
   if((await tx.query("SELECT 1 FROM app_settings WHERE key='telegram:automatic:last-scan' AND (value->>'at')::timestamptz>now()-interval '3 seconds'")).rowCount)return null;
   const item=(await tx.query(`SELECT s.* FROM telegram_conversation_starts s JOIN chats c ON c.id=s.chat_id
    WHERE NOT c.is_control AND c.inclusion<>'excluded' AND NOT EXISTS(SELECT 1 FROM telegram_account a WHERE a.self_user_id=c.id)
    AND (s.checked_cutoff IS DISTINCT FROM $1::timestamptz OR s.state IN ('pending','error','checking') OR (s.state='unknown' AND s.next_check_at<=now()))
    AND (s.lease_until IS NULL OR s.lease_until<now()) AND s.next_check_at<=now()
    ORDER BY (s.latest_message_at >= $1::timestamptz) DESC NULLS LAST,s.latest_message_at DESC NULLS LAST,s.chat_id
    FOR UPDATE OF s SKIP LOCKED LIMIT 1`,[policy.cutoff])).rows[0];
   if(!item)return null;
   await tx.query("UPDATE telegram_conversation_starts SET state='checking',claim_token=$2,lease_until=now()+interval '60 seconds',attempts=attempts+1,updated_at=now() WHERE chat_id=$1",[item['chat_id'],token]);
   await tx.query("INSERT INTO app_settings(key,value) VALUES('telegram:automatic:last-scan',jsonb_build_object('at',now())) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");return item;
  });
  if(!row)return;
  const chatId=String(row['chat_id']);
  try{
   // A known pre-cutoff message proves this is older without downloading history.
   const old=(await this.db.query('SELECT id,sent_at FROM messages WHERE chat_id=$1 AND sent_at<$2 ORDER BY sent_at,id LIMIT 1',[chatId,policy.cutoff])).rows[0];
   const latest=row['latest_message_at']?new Date(row['latest_message_at'] as string):null;
   const result:ConversationStart=old?{at:new Date(old['sent_at'] as string).toISOString(),messageId:Number(old['id']),uncertain:false,reason:'pre_cutoff_message'}
    :latest&&latest.getTime()<Date.parse(policy.cutoff)?{at:null,messageId:null,uncertain:false,reason:'last_message_before_cutoff'}
    :await this.telegram.conversationStart(chatId,policy.cutoff);
   await this.db.transaction(async tx=>{
    const chat=await this.store.lockedChat(tx,chatId);
    const current=await automaticPolicy(tx);if(!current||current.revision!==policy.revision)return;
    const claim=(await tx.query('SELECT 1 FROM telegram_conversation_starts WHERE chat_id=$1 AND claim_token=$2 AND lease_until>now() FOR UPDATE',[chatId,token])).rowCount;if(!claim)return;
    const qualifies=!result.uncertain&&result.at!==null&&Date.parse(result.at)>=Date.parse(policy.cutoff);
    const state=qualifies?'qualifies':result.uncertain||(!result.at&&result.reason!=='last_message_before_cutoff')?'unknown':'older';
    await tx.query(`UPDATE telegram_conversation_starts SET state=$3,first_message_at=$4,first_message_id=$5,reason=$6,checked_cutoff=$7,
     claim_token=NULL,lease_until=NULL,next_check_at=now()+interval '1 day',updated_at=now() WHERE chat_id=$1 AND claim_token=$2`,[chatId,token,state,result.at,result.messageId,result.reason,policy.cutoff]);
    if(!qualifies||chat.isControl||chat.inclusion==='excluded')return;
    // The cutoff only classifies a conversation. It never authorizes business
    // ingestion: every qualifying chat waits for a correlated Telegram reply.
    if(chat.inclusion==='undecided')await queueIntake(tx,chatId,true);
   });
  }catch(error){
   await this.db.query("UPDATE telegram_conversation_starts SET state='error',claim_token=NULL,lease_until=NULL,next_check_at=now()+interval '5 minutes',reason=$3,updated_at=now() WHERE chat_id=$1 AND claim_token=$2",[chatId,token,scopedAccess(error)?'history_access_unavailable':'history_probe_retry']);
   if(!scopedAccess(error))throw error; // native flood/auth/network/DB waits remain global
  }
 }
 async status():Promise<ServiceStatus>{
  const policy=await automaticPolicy(this.db);if(!policy)return {state:'ready',code:null,detail:'Automatic cutoff intake disabled; control-group approval policy applies',checkedAt:new Date().toISOString()};
  const r=(await this.db.query(`SELECT count(*) FILTER(WHERE s.state='qualifies' AND s.checked_cutoff=$1) AS qualified,
   count(*) FILTER(WHERE s.state='older' AND s.checked_cutoff=$1) AS older,
   count(*) FILTER(WHERE s.checked_cutoff IS DISTINCT FROM $1 OR s.state IN ('pending','checking','error')) AS pending,
   count(*) FILTER(WHERE s.state='unknown' AND s.checked_cutoff=$1) AS unknown,
   count(*) FILTER(WHERE s.state='qualifies' AND s.checked_cutoff=$1 AND c.inclusion='undecided') AS approval_pending
   FROM telegram_conversation_starts s JOIN chats c ON c.id=s.chat_id WHERE NOT c.is_control AND c.inclusion<>'excluded' AND NOT EXISTS(SELECT 1 FROM telegram_account a WHERE a.self_user_id=c.id)`,[policy.cutoff])).rows[0]!;
  return {state:'ready',code:null,detail:`First-conversation cutoff ${policy.cutoff}: ${r['qualified']} qualify, ${r['older']} older, ${r['pending']} pending, ${r['unknown']} unknown; ${r['approval_pending']} qualifying chats await Telegram control approval. No chat is admitted automatically.`,checkedAt:new Date().toISOString()};
 }
}

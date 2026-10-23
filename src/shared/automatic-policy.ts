import type { SqlExecutor } from './ports.js';
export const AUTOMATIC_POLICY_KEY = 'telegram:automatic-since';
export interface AutomaticPolicy { enabled:true; revision:string; cutoff:string; initialPlacement:boolean; groupApprovalFrom:string|null }
/** Internal SQL aliases/placeholders only. Conversation start, never discovery
 * time, separates the historical import from newly created groups. */
export function groupInitialApprovalSql(chat:string,scope:string,boundary:string):string {
 return `(${boundary}::timestamptz IS NOT NULL AND ${chat}.kind IN ('group','supergroup') AND ${scope}.first_message_at >= ${boundary}::timestamptz)`;
}
export async function automaticPolicy(db:SqlExecutor):Promise<AutomaticPolicy|null>{
 const value=(await db.query('SELECT value FROM app_settings WHERE key=$1',[AUTOMATIC_POLICY_KEY])).rows[0]?.['value'] as Partial<AutomaticPolicy>|undefined;
 if(value?.enabled!==true||typeof value.revision!=='string'||!value.revision||typeof value.cutoff!=='string'||!Number.isFinite(Date.parse(value.cutoff))||typeof value.initialPlacement!=='boolean')return null;
 if(value.groupApprovalFrom!=null&&(typeof value.groupApprovalFrom!=='string'||!Number.isFinite(Date.parse(value.groupApprovalFrom))))return null;
 return {enabled:true,revision:value.revision,cutoff:new Date(value.cutoff).toISOString(),initialPlacement:value.initialPlacement,
  groupApprovalFrom:value.groupApprovalFrom?new Date(value.groupApprovalFrom).toISOString():null};
}

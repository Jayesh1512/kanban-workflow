import type { SqlExecutor } from './ports.js';
export const AUTOMATIC_POLICY_KEY = 'telegram:automatic-since';
export interface AutomaticPolicy { enabled:true; revision:string; cutoff:string; initialPlacement:boolean }
export async function automaticPolicy(db:SqlExecutor):Promise<AutomaticPolicy|null>{
 const value=(await db.query('SELECT value FROM app_settings WHERE key=$1',[AUTOMATIC_POLICY_KEY])).rows[0]?.['value'] as Partial<AutomaticPolicy>|undefined;
 if(value?.enabled!==true||typeof value.revision!=='string'||!value.revision||typeof value.cutoff!=='string'||!Number.isFinite(Date.parse(value.cutoff))||typeof value.initialPlacement!=='boolean')return null;
 return {enabled:true,revision:value.revision,cutoff:new Date(value.cutoff).toISOString(),initialPlacement:value.initialPlacement};
}

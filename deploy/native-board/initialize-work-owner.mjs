// Run against the built image, without starting a second backend/Telegram worker:
// docker compose run --rm --no-deps -T --entrypoint node backend --input-type=module < deploy/native-board/initialize-work-owner.mjs
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const built = name => import(pathToFileURL(resolve('dist',name)).href);
const {loadRuntimeConfig}=await built('platform/config.js');
const {PgDatabase,migrate}=await built('platform/database.js');
const {initializeWorkOwner}=await built('board/ownership.js');
const {visibleWorkSql}=await built('board/work-visibility.js');
const config=await loadRuntimeConfig(),email=config.access?.adminEmail;
if(!email)throw Error('Configure the initial administrator before initializing generated-task ownership');
const db=new PgDatabase(config.databaseUrl);
try{
  await migrate(db);
  const result=await db.transaction(async tx=>{
    const owner=(await tx.query("SELECT id FROM workspace_members WHERE email=$1 AND enabled AND role='admin' FOR SHARE",[email])).rows[0];
    if(!owner)throw Error('The configured initial administrator must have an enabled workspace membership');
    const assigned=await initializeWorkOwner(tx,String(owner.id));
    const setting=(await tx.query("SELECT value FROM app_settings WHERE key='workspace:default-work-owner'")).rows[0];
    if(setting?.value?.memberId!==owner.id)throw Error('A different default Work owner is already configured; existing ownership was preserved');
    const totals=(await tx.query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE owner_id=$1)::int AS owned,
      count(*) FILTER(WHERE owner_id IS NULL)::int AS unassigned FROM tickets`,[owner.id])).rows[0];
    const visible=(await tx.query(`SELECT count(*)::int AS count FROM tickets t JOIN chats c ON c.id=t.chat_id
      WHERE t.owner_id=$1 AND ${visibleWorkSql}`,[owner.id])).rows[0].count;
    const audits=(await tx.query("SELECT count(*)::int AS count FROM workspace_audit WHERE action='work.assign' AND actor_id=$1",[owner.id])).rows[0].count;
    if(totals.unassigned!==0)throw Error('Generated-task ownership backfill is incomplete');
    return {owner:email,assigned,...totals,visible,auditedAssignments:audits};
  });
  console.log(JSON.stringify(result));
}finally{await db.close();}

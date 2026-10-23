import { expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
// @ts-expect-error Deployment CLI is native JavaScript, not an app module.
import { snapshot, SNAPSHOT_SETTINGS } from '../../deploy/supabase/migrate.mjs';
it('canonicalizes float and timezone presentation without accepting changed stored data',async()=>{
 const local=new PGlite(),remote=new PGlite();
 try{
  const sql="CREATE TABLE positions(id int PRIMARY KEY,position double precision,observed_at timestamptz);INSERT INTO positions VALUES(1,4116010325.333333,'2026-10-23T12:00:00Z'),(2,43690.666666666664,'2026-10-23T12:00:00Z');";
  await local.exec(sql);await remote.exec(sql);
  const read=(engine:PGlite)=>(async(sql:string)=>JSON.stringify(Object.values((await engine.query(sql)).rows[0]!)[0]));
  await local.exec(SNAPSHOT_SETTINGS);const source=await snapshot(read(local),'public');
  await remote.exec("SET timezone='Asia/Kolkata';SET extra_float_digits=0;");expect(await snapshot(read(remote),'public')).not.toEqual(source);
  await remote.exec(SNAPSHOT_SETTINGS);expect(await snapshot(read(remote),'public')).toEqual(source);
  await remote.exec('UPDATE positions SET position=position+0.0001 WHERE id=1');expect(await snapshot(read(remote),'public')).not.toEqual(source);
 }finally{await local.close();await remote.close();}
});

import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {PgDatabase,migrate} from '../../src/platform/database.js';
import {createMigrationGate} from '../../src/platform/migration-gate.js';
import type {Database,SqlExecutor} from '../../src/shared/ports.js';

const url=process.env['SYSTEM_TEST_DATABASE_URL'];
describe.skipIf(!url)('actual PostgreSQL concurrent migration readiness readers',()=>{
  let admin:PgDatabase,first:PgDatabase,second:PgDatabase,schema:string;
  beforeEach(async()=>{admin=new PgDatabase(url!);schema='system_gate_'+randomUUID().replaceAll('-','');await admin.query('CREATE SCHEMA '+schema);const u=new URL(url!);u.searchParams.set('options','-c search_path='+schema);first=new PgDatabase(u.toString());second=new PgDatabase(u.toString());await migrate(first);});
  afterEach(async()=>{await first?.close();await second?.close();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.close();});
  it('allows a second genuine ledger read while the first readiness reader retains its lock',async()=>{
    let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),hold=new Promise<void>(r=>{release=r;});
    const intercepted:Database={query:first.query.bind(first),close:first.close.bind(first),withSessionLock:first.withSessionLock.bind(first),transaction:work=>first.transaction(tx=>{
      const executor:SqlExecutor={query:async(sql,args)=>{const result=await tx.query(sql,args);if(sql.includes('pg_try_advisory_xact_lock')&&result.rows[0]?.ready){enter();await hold;}return result as never;}};return work(executor);
    })};
    const checkA=await createMigrationGate(intercepted),checkB=await createMigrationGate(second),pending=checkA();
    try{await entered;expect(await checkB()).toBe('ready');}finally{release();await pending;}
  });
  it('still rejects all readers while a real migration writer owns the exclusive lock',async()=>{
    const checkA=await createMigrationGate(first),checkB=await createMigrationGate(second);
    await admin.withSessionLock('antseed:migrations',async()=>{expect(await Promise.all([checkA(),checkB()])).toEqual(['pending','pending']);});
    expect(await Promise.all([checkA(),checkB()])).toEqual(['ready','ready']);
    await first.query("UPDATE schema_migrations SET checksum=repeat('0',64)");expect(await checkB()).toBe('drift');
  });
});

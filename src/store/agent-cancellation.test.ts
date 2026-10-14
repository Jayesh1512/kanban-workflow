import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Db } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
import { openDb } from './db.ts';

function freshDb(): Db {
  // Each memory allocation has no predecessor/file/other writer and starts with zero handles.
  console.log(
    'FIRST_EXACT',
    JSON.stringify({
      identity: randomUUID(),
      memory: true,
      handles: 0,
      olderWriters: 0,
      consumer: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    }),
  );
  return openDb(':memory:');
}
function invalid(message: string) {
  return (error: unknown) => error instanceof AppError && error.code === 'invalid' && error.message === message;
}
function caught(fn: () => unknown): unknown {
  try {
    fn();
    assert.fail('Expected a throw');
  } catch (error) {
    return error;
  }
}

test('C1 store copied OR scopes, intrinsic brand/abort, deduplication and exact old-handle lifetime', () => {
  const db = freshDb();
  const other = freshDb();
  try {
    const old = new AbortController();
    const unrelated = new AbortController();
    const independent = new AbortController();
    const chats = [3, 1, 3];
    const messages = [9, 9];
    let events = 0;
    old.signal.addEventListener('abort', () => events++);
    old.abort = () => assert.fail('Replaced instance abort must not run');
    const first = db.registerAgentCancellation({ chatIds: chats, messageIds: messages }, old);
    const second = db.registerAgentCancellation({ chatIds: [], messageIds: [10] }, old);
    db.registerAgentCancellation({ chatIds: [7], messageIds: [] }, unrelated);
    other.registerAgentCancellation({ chatIds: [1], messageIds: [9] }, independent);
    chats.fill(7);
    messages.fill(99);
    db.tx(() => {
      db.invalidateAgentWork({ chatIds: [], messageIds: [9] });
      first.release();
      second.release();
      db.invalidateAgentWork({ chatIds: [1], messageIds: [] });
      assert.equal(old.signal.aborted, false);
    });
    assert.equal(old.signal.aborted, true);
    assert.equal(events, 1);
    assert.equal(unrelated.signal.aborted, false);
    assert.equal(independent.signal.aborted, false);
    const successor = new AbortController();
    const successorHandle = db.registerAgentCancellation({ chatIds: [1], messageIds: [] }, successor);
    first.release();
    first.cancel();
    first.cancel();
    assert.equal(events, 1);
    assert.equal(successor.signal.aborted, false);
    successorHandle.release();
    db.invalidateAgentWork({ chatIds: [1], messageIds: [] });
    assert.equal(successor.signal.aborted, false);
    db.close();
    successorHandle.cancel();
    assert.equal(successor.signal.aborted, true);
    db.close();
    assert.throws(() => db.invalidateAgentWork({ chatIds: [1], messageIds: [] }), invalid('Database is closed'));
  } finally {
    db.close();
    other.close();
  }
});

test('C1 store chat-only copying/no tombstone and released-handle cancel joins the outer boundary', () => {
  const db = freshDb();
  try {
    db.invalidateAgentWork({ chatIds: [4], messageIds: [] });
    const controller = new AbortController();
    const chats = [4, Number.MAX_SAFE_INTEGER];
    const handle = db.registerAgentCancellation({ chatIds: chats, messageIds: [] }, controller);
    chats.fill(5);
    assert.equal(controller.signal.aborted, false);
    db.invalidateAgentWork({ chatIds: [5], messageIds: [] });
    assert.equal(controller.signal.aborted, false);
    db.invalidateAgentWork({ chatIds: [4], messageIds: [] });
    assert.equal(controller.signal.aborted, true);
    const old = new AbortController();
    const successor = new AbortController();
    const oldHandle = db.registerAgentCancellation({ chatIds: [4], messageIds: [] }, old);
    oldHandle.release();
    db.registerAgentCancellation({ chatIds: [4], messageIds: [] }, successor);
    db.tx(() => {
      oldHandle.cancel();
      oldHandle.release();
      assert.equal(old.signal.aborted, false);
    });
    assert.equal(old.signal.aborted, true);
    assert.equal(successor.signal.aborted, false);
    handle.cancel();
  } finally {
    db.close();
  }
});

test('C1 store invalid required scope/native controller and transaction registration cause zero delivery', () => {
  const db = freshDb();
  const live = new AbortController();
  try {
    for (const scope of [
      null,
      {},
      { chatIds: [1] },
      { chatIds: [], messageIds: [] },
      { chatIds: [0], messageIds: [] },
      { chatIds: [], messageIds: [1.5] },
      { chatIds: [Number.MAX_SAFE_INTEGER + 1], messageIds: [] },
      { chatIds: ['1'], messageIds: [] },
    ]) {
      assert.throws(
        () => Reflect.apply(db.registerAgentCancellation, db, [scope, live]),
        invalid('Invalid agent cancellation registration'),
      );
      assert.throws(
        () => Reflect.apply(db.invalidateAgentWork, db, [scope]),
        invalid('Invalid agent invalidation scope'),
      );
    }
    const aborted = new AbortController();
    aborted.abort();
    for (const controller of [null, {}, { signal: live.signal, abort() {} }, aborted]) {
      assert.throws(
        () => Reflect.apply(db.registerAgentCancellation, db, [{ chatIds: [1], messageIds: [] }, controller]),
        invalid('Invalid agent cancellation registration'),
      );
    }
    db.tx(() =>
      assert.throws(
        () => db.registerAgentCancellation({ chatIds: [1], messageIds: [] }, live),
        invalid('Agent cancellation registration requires an idle transaction boundary'),
      ),
    );
    assert.equal(live.signal.aborted, false);
  } finally {
    db.close();
  }
});

test('C1 store nested JOIN commit/rollback preserves exact null/undefined primary and captured cancellation', () => {
  const db = freshDb();
  try {
    db.tx(() => {
      db.run("INSERT INTO setting VALUES ('joined','1')");
      assert.equal(
        caught(() =>
          db.tx(() => {
            throw null;
          }),
        ),
        null,
      );
      db.run("INSERT INTO setting VALUES ('continued','1')");
    });
    assert.equal(db.all('SELECT * FROM setting').length, 2);
    for (const sentinel of [undefined, null, new Error('Synthetic primary')]) {
      const controller = new AbortController();
      db.registerAgentCancellation({ chatIds: [1], messageIds: [] }, controller);
      let threw = false;
      try {
        db.tx(() => {
          db.tx(() => {
            db.invalidateAgentWork({ chatIds: [1], messageIds: [] });
            db.run("INSERT INTO setting VALUES ('rolled-back','1')");
          });
          assert.equal(controller.signal.aborted, false);
          throw sentinel;
        });
      } catch (error) {
        threw = true;
        assert.equal(error, sentinel);
        assert.equal(controller.signal.aborted, true);
      }
      assert.equal(threw, true);
      assert.equal(db.get("SELECT * FROM setting WHERE key='rolled-back'"), undefined);
    }
    assert.throws(() => db.tx(async () => 1), /synchronous/);
    assert.throws(() => db.tx(() => Promise.resolve(1)), /synchronous/);
    db.tx(() => db.run("INSERT INTO setting VALUES ('healthy','1')"));
  } finally {
    db.close();
  }
});

test('C1 store native automatic rollback bars swallowed-error SQL and nested callbacks, then permits healthy reuse', () => {
  const db = freshDb();
  try {
    db.run('CREATE TABLE cancellation_unique (id INTEGER PRIMARY KEY) STRICT');
    let primary: unknown;
    let callbacks = 0;
    const thrown = caught(() =>
      db.tx(() => {
        db.run('INSERT INTO cancellation_unique VALUES (1)');
        primary = caught(() => db.tx(() => db.run('INSERT OR ROLLBACK INTO cancellation_unique VALUES (1)')));
        assert.ok(primary instanceof AppError);
        for (const work of [
          () => db.get('SELECT 1'),
          () => db.all('SELECT 1'),
          () => db.run('INSERT INTO cancellation_unique VALUES (2)'),
          () => db.tx(() => callbacks++),
          () => db.invalidateAgentWork({ chatIds: [1], messageIds: [] }),
        ]) {
          assert.equal(caught(work), primary);
        }
      }),
    );
    assert.equal(thrown, primary);
    assert.equal(callbacks, 0);
    assert.equal(db.all('SELECT * FROM cancellation_unique').length, 0);
    db.tx(() => db.run('INSERT INTO cancellation_unique VALUES (3)'));
    assert.deepEqual(
      db.all<{ id: number }>('SELECT * FROM cancellation_unique').map((row) => row.id),
      [3],
    );
  } finally {
    db.close();
  }
});

test('C1 store deferred FK COMMIT failure rolls back data/log while abort remains irreversible', () => {
  const db = freshDb();
  try {
    const controller = new AbortController();
    db.registerAgentCancellation({ chatIds: [1], messageIds: [] }, controller);
    const before = db.all('SELECT * FROM action_log');
    assert.throws(
      () =>
        db.tx(() => {
          db.run('PRAGMA defer_foreign_keys=ON');
          db.run("INSERT INTO stage(lane_id,name,position) VALUES (999,'invalid',0)");
          db.run(
            "INSERT INTO action_log(at,actor_kind,action,subject_kind,subject_id) VALUES ('2026-10-14','system','test','stage',999)",
          );
          db.invalidateAgentWork({ chatIds: [1], messageIds: [] });
        }),
      /FOREIGN KEY/,
    );
    assert.equal(controller.signal.aborted, true);
    assert.equal(db.all('SELECT * FROM stage').length, 0);
    assert.deepEqual(db.all('SELECT * FROM action_log'), before);
    db.tx(() => db.run("INSERT INTO setting VALUES ('reuse','1')"));
  } finally {
    db.close();
  }
});

test('C1 store whole-batch delivery bars reentrant work/close, permits pure captured handles', () => {
  const db = freshDb();
  const first = new AbortController();
  const second = new AbortController();
  const secondHandle = db.registerAgentCancellation({ chatIds: [2], messageIds: [] }, second);
  let callbacks = 0;
  first.signal.addEventListener('abort', () => {
    for (const work of [
      () => db.get('SELECT 1'),
      () => db.all('SELECT 1'),
      () => db.run('SELECT 1'),
      () => db.tx(() => callbacks++),
      () => db.invalidateAgentWork({ chatIds: [1], messageIds: [] }),
      () => db.close(),
    ]) {
      assert.throws(work, invalid('Database boundary is active'));
    }
    assert.throws(
      () => db.registerAgentCancellation({ chatIds: [3], messageIds: [] }, new AbortController()),
      invalid('Agent cancellation registration requires an idle transaction boundary'),
    );
    secondHandle.release();
    secondHandle.cancel();
  });
  db.registerAgentCancellation({ chatIds: [1], messageIds: [] }, first);
  db.invalidateAgentWork({ chatIds: [1], messageIds: [] });
  assert.equal(second.signal.aborted, true);
  assert.equal(callbacks, 0);
  assert.equal(db.get<{ n: number }>('SELECT 1 AS n')?.n, 1);
  db.close();
});

// §2.1 only: finite child links the committed body to a native subclass for controlled fault exposure.
// No source replacements, algorithm copy, public hooks or global/module-cache/prototype patches.
const nativeFaultChild = `
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync, constants } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { SourceTextModule, SyntheticModule } from 'node:vm';
const url = pathToFileURL(process.cwd() + '/src/store/db.ts');
const raw = readFileSync(url, 'utf8');
const committed = execFileSync('git', ['show', 'HEAD:src/store/db.ts'], { encoding: 'utf8' });
assert.equal(raw, committed);
const stripped = stripTypeScriptTypes(raw, { mode: 'strip', sourceUrl: url.href });
const hash = (text) => createHash('sha256').update(text).digest('hex');
console.log('SOURCE_IDENTITY', JSON.stringify({ head: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  rawSha256: hash(raw), committedSha256: hash(committed), strippedSha256: hash(stripped), url: url.href, realm: 'current' }));
let plan = {};
const natives = [];
const preClose = new Error('Injected pre-effect close');
const postClose = new Error('Injected post-effect close');
const initError = new Error('Injected pre-migration initialization');
class ExposedNative extends DatabaseSync {
  constructor(path) {
    console.log('FIRST_EXACT_NATIVE', JSON.stringify({ identity:randomUUID(), path, handles:0, olderWriters:0, consumer:hash(raw) }));
    super(path);
    this.plan = plan;
    this.allocatedPath = path;
    this.prepares = 0;
    this.rollbacks = 0;
    this.commits = 0;
    this.closeCalls = 0;
    natives.push(this);
    if (this.plan.unknown) {
      const descriptor = Object.getOwnPropertyDescriptor(this,'isTransaction');
      assert.equal(descriptor.configurable, true);
      Object.defineProperty(this,'isTransaction',{ configurable:true, get:()=> {
        if (this.plan.unknownActive) throw new Error('Injected unknown state observation');
        return descriptor.get.call(this);
      }});
    }
  }
  exec(sql) {
    if (this.plan.init && sql.startsWith('PRAGMA')) throw initError;
    if (sql === 'ROLLBACK') this.rollbacks++;
    if (sql === 'COMMIT') this.commits++;
    return super.exec(sql);
  }
  prepare(sql) { this.prepares++; return super.prepare(sql); }
  close() {
    this.closeCalls++;
    if (this.plan.close === 'pre') throw preClose;
    super.close();
    if (this.plan.close === 'post') throw postClose;
  }
}
// No new VM context: native AbortController/Error/Promise brands are exactly the caller's realm.
const production = new SourceTextModule(stripped, { identifier:url.href, initializeImportMeta(meta){meta.url=url.href;} });
await production.link(async (specifier) => {
  const exports = specifier === 'node:sqlite' ? { DatabaseSync:ExposedNative } :
    await import(specifier.startsWith('.') ? new URL(specifier,url).href : specifier);
  const names = Object.keys(exports);
  return new SyntheticModule(names,function(){for(const name of names)this.setExport(name,exports[name]);});
});
await production.evaluate();
const { openDb } = production.namespace;
const { AppError } = await import(new URL('../contracts/index.ts',url));
const faulted = (e) => e instanceof AppError && e.code==='invalid' && e.message==='Database is faulted; close and restart required';
function thrown(fn) { let did=false,value; try{fn();}catch(e){did=true;value=e;}assert.equal(did,true);return value; }
function newPath() { const path=join(process.env.C1_FAULT_ROOT,randomUUID()+'.db');assert.equal(existsSync(path),false);return path; }
function fresh(options={}) { plan=options; const db=openDb(newPath());return {db,native:natives.at(-1),options}; }
function observers(db,native) {
  const controllers=[new AbortController(),new AbortController()];
  const observed=[];
  const handles=controllers.map((controller,i)=>{
    controller.signal.addEventListener('abort',()=>{
      const open=native.isOpen;
      const active=open?native.isTransaction:false;
      observed.push({observer:i,open,active});
      assert.equal(active,false);
      // Fault delivery is after actual retirement; ordinary delivery can be idle/open.
      if (native.plan.denied) assert.equal(open,false);
    });
    return db.registerAgentCancellation({chatIds:[i+1],messageIds:[]},controller);
  });
  return {controllers,observed,handles};
}
function deny(native,which) {
  native.plan.denied=true;
  native.setAuthorizer((action,arg)=>action===constants.SQLITE_TRANSACTION && which.includes(arg)?constants.SQLITE_DENY:constants.SQLITE_OK);
}
function fenceAll(db,native) {
  const before=native.prepares;
  let callbacks=0,providerCalls=0;
  for(const fn of [()=>db.get('SELECT 1'),()=>db.all('SELECT 1'),()=>db.run('SELECT 1'),
    ()=>db.tx(()=>{callbacks++;providerCalls++;}),
    ()=>db.registerAgentCancellation({chatIds:[1],messageIds:[]},new AbortController()),
    ()=>db.invalidateAgentWork({chatIds:[1],messageIds:[]})]) assert.ok(faulted(thrown(fn)));
  assert.equal(callbacks,0);assert.equal(providerCalls,0);assert.equal(native.prepares,before);
}
const independent=fresh();
for(const primary of [undefined,null,new Error('Primary identity')]) {
  const {db,native}=fresh();
  const o=observers(db,native);
  deny(native,['ROLLBACK']);
  assert.equal(thrown(()=>db.tx(()=>{
    db.run("INSERT INTO setting VALUES ('data','1')");
    db.run("INSERT INTO action_log(at,actor_kind,action,subject_kind,subject_id) VALUES ('2026-10-14','system','test','setting',1)");
    db.invalidateAgentWork({chatIds:[1],messageIds:[]});
    assert.equal(native.isTransaction,true);
    throw primary;
  })),primary);
  assert.equal(native.isOpen,false);
  assert.equal(native.rollbacks,1);assert.equal(native.closeCalls,1);
  assert.equal(o.observed.length,2); // ALL captures, including the nonmatching registration.
  fenceAll(db,native);o.handles.forEach(h=>{h.release();h.cancel();});
  db.close();fenceAll(db,native);
  independent.db.tx(()=>independent.db.run('INSERT OR REPLACE INTO setting VALUES (?,?)','independent','1'));
  console.log('NATIVE_ROLLBACK_DENIED_RETIRED',JSON.stringify({primary:primary===undefined?'undefined':primary===null?'null':'Error',observed:o.observed}));
}
for(const close of ['pre','post']) {
  const options={close};
  const {db,native}=fresh(options);
  const o=observers(db,native);deny(native,['COMMIT','ROLLBACK']);
  const primary=thrown(()=>db.tx(()=>{db.run("INSERT INTO setting VALUES ('data','1')");db.invalidateAgentWork({chatIds:[1],messageIds:[]});}));
  assert.ok(primary instanceof Error);assert.notEqual(primary,preClose);assert.notEqual(primary,postClose);
  assert.equal(native.commits,5); // four real migration commits plus ONE denied outer COMMIT.
  assert.equal(native.rollbacks,1);assert.equal(native.closeCalls,1);
  fenceAll(db,native);
  if(close==='pre') {
    assert.equal(native.isOpen,true);assert.equal(native.isTransaction,true);
    assert.equal(o.observed.length,0);assert.ok(o.controllers.every(c=>!c.signal.aborted));
    o.handles.forEach(h=>{h.release();h.cancel();});
    assert.equal(o.observed.length,0);
    assert.ok(faulted(thrown(()=>db.close())));
    assert.equal(native.closeCalls,2);
    assert.equal(o.observed.length,0);
    native.setAuthorizer(null);options.close=undefined;
    db.close();
    assert.equal(native.isOpen,false);assert.equal(o.observed.length,2);
    console.log('INJECTED_PRE_CLOSE_TERMINAL_THEN_BOUNDED_CLEANUP',JSON.stringify(o.observed));
  } else {
    assert.equal(native.isOpen,false);assert.equal(o.observed.length,2);
    console.log('INJECTED_POST_CLOSE_RETIRED',JSON.stringify(o.observed));
  }
  fenceAll(db,native);db.close();
}
for(const close of ['pre','post']) {
  const options={close};const {db,native}=fresh(options);const o=observers(db,native);
  assert.equal(thrown(()=>db.close()),close==='pre'?preClose:postClose);
  assert.equal(o.observed.length,2);
  assert.ok(o.observed.every(state=>state.open && !state.active)); // normal verified-idle abort BEFORE close.
  fenceAll(db,native);options.close=undefined;db.close();fenceAll(db,native);
  console.log('INJECTED_HEALTHY_IDLE_CLOSE_PERMANENT_FAULT',close);
}
{
  plan={init:true};const before=natives.length;
  assert.equal(thrown(()=>openDb(newPath())),initError);
  assert.equal(natives.length,before+1);assert.equal(natives.at(-1).isOpen,false);assert.equal(natives.at(-1).closeCalls,1);
  console.log('INJECTED_PRE_MIGRATION_INIT_PRIMARY_AND_RETIREMENT');
}
{
  const {db,native}=fresh();const o=observers(db,native);
  const before=native.rollbacks;
  const primary=thrown(()=>db.tx(()=>{
    db.run('CREATE TABLE automatic (id INTEGER PRIMARY KEY) STRICT');
    db.run('INSERT INTO automatic VALUES (1)');
    const mapped=thrown(()=>db.run('INSERT OR ROLLBACK INTO automatic VALUES (1)'));
    assert.ok(mapped instanceof AppError);assert.equal(mapped.code,'conflict');
    assert.equal(native.isTransaction,false);
    assert.equal(thrown(()=>db.tx(()=>assert.fail('Joined callback entered'))),mapped);
    assert.equal(thrown(()=>db.run("INSERT INTO setting VALUES ('escaped','1')")),mapped);
    throw mapped;
  }));
  assert.ok(primary instanceof AppError);assert.equal(native.rollbacks,before);
  assert.equal(db.get("SELECT * FROM setting WHERE key='escaped'"),undefined);
  assert.equal(thrown(()=>db.tx(()=>Promise.resolve(1))).message,'Db.tx requires a synchronous callback');
  db.invalidateAgentWork({chatIds:[1,2],messageIds:[]});assert.equal(o.observed.length,2);db.close();
  console.log('NATIVE_AUTOMATIC_ROLLBACK_REALM_ERROR_PROMISE_PRESERVED',JSON.stringify(o.observed));
}
{
  const {db,native}=fresh();const o=observers(db,native);
  const before=native.prepares;let callbacks=0;
  native.setAuthorizer((action,arg)=>action===constants.SQLITE_TRANSACTION && arg==='BEGIN'?constants.SQLITE_DENY:constants.SQLITE_OK);
  const primary=thrown(()=>db.tx(()=>callbacks++));
  assert.ok(primary instanceof Error);assert.equal(callbacks,0);assert.equal(native.prepares,before);
  assert.equal(native.isOpen,true);assert.equal(native.isTransaction,false);assert.equal(o.observed.length,0);
  native.setAuthorizer(null);db.tx(()=>db.run("INSERT INTO setting VALUES ('healthy-begin','1')"));db.close();
  assert.equal(o.observed.length,2);
  console.log('NATIVE_BEGIN_DENIED_PRIMARY_NO_CALLBACK_HEALTHY_REUSE');
}
{
  const {db,native}=fresh();const o=observers(db,native);
  const before=native.rollbacks;
  const primary=thrown(()=>db.tx(()=>{
    db.run('PRAGMA defer_foreign_keys=ON');
    db.run("INSERT INTO stage(lane_id,name,position) VALUES (999,'invalid',0)");
    db.invalidateAgentWork({chatIds:[1,2],messageIds:[]});
  }));
  assert.ok(primary instanceof Error);assert.equal(native.isTransaction,false);assert.equal(native.rollbacks,before+1);
  assert.equal(o.observed.length,2);assert.ok(o.observed.every(state=>state.open&&!state.active));
  assert.equal(db.all('SELECT * FROM stage').length,0);db.tx(()=>db.run("INSERT INTO setting VALUES ('healthy-fk','1')"));db.close();
  console.log('NATIVE_DEFERRED_FK_COMMIT_ROLLBACK_IDLE_BEFORE_EVERY_OBSERVER',JSON.stringify(o.observed));
}
for(const method of ['get','all','run','tx','register','invalidate']) {
  const {db,native}=fresh();const o=observers(db,native);let callbacks=0;
  native.exec('BEGIN IMMEDIATE');
  assert.equal(native.isTransaction,true);const before=native.prepares;
  const operations={get:()=>db.get('SELECT 1'),all:()=>db.all('SELECT 1'),run:()=>db.run('SELECT 1'),
    tx:()=>db.tx(()=>callbacks++),register:()=>db.registerAgentCancellation({chatIds:[1],messageIds:[]},new AbortController()),
    invalidate:()=>db.invalidateAgentWork({chatIds:[1],messageIds:[]})};
  assert.ok(faulted(thrown(operations[method])));assert.equal(callbacks,0);assert.equal(native.prepares,before);
  assert.equal(native.isOpen,false);assert.equal(o.observed.length,2);assert.ok(o.observed.every(state=>!state.open));
  fenceAll(db,native);db.close();
  console.log('NATIVE_UNEXPECTED_ACTIVE_ENTRY_ALL_METHOD_FENCE',method);
}
{
  const {db,native}=fresh();const o=observers(db,native);
  native.setAuthorizer((action,arg)=>action===constants.SQLITE_TRANSACTION&&arg==='COMMIT'?constants.SQLITE_DENY:constants.SQLITE_OK);
  assert.ok(thrown(()=>db.tx(()=>{
    db.run("INSERT INTO setting VALUES ('data','1')");db.invalidateAgentWork({chatIds:[1],messageIds:[]});
  })) instanceof Error);
  assert.equal(native.isOpen,true);assert.equal(native.isTransaction,false);assert.equal(o.observed.length,1);
  assert.equal(db.get("SELECT * FROM setting WHERE key='data'"),undefined);
  native.setAuthorizer(null);db.tx(()=>db.run("INSERT INTO setting VALUES ('healthy-commit','1')"));db.close();
  assert.equal(o.observed.length,2);console.log('NATIVE_COMMIT_DENIED_ROLLBACK_HEALTHY_REUSE',JSON.stringify(o.observed));
}
independent.db.close();
assert.ok(natives.every(native=>native.isOpen===false));
let unknownLinkageFailure;
try {
{
  const options={unknown:true,unknownActive:false,close:'pre'};
  const {db,native}=fresh(options);const o=observers(db,native);
  options.unknownActive=true;
  assert.ok(faulted(thrown(()=>db.get('SELECT 1'))));
  assert.equal(o.observed.length,0);assert.ok(o.controllers.every(c=>!c.signal.aborted));
  fenceAll(db,native);
  options.unknownActive=false;options.close=undefined;db.close();
  assert.equal(o.observed.length,2);fenceAll(db,native);
  console.log('INJECTED_UNKNOWN_STATE_TERMINAL_AND_CLEANUP');
}
} catch(error) {
  unknownLinkageFailure=error;
  console.log('UNKNOWN_STATE_LINKAGE_BLOCKED',JSON.stringify({nativeAccessorConfigurable:false,
    reason:'DatabaseSync instance native state accessor cannot be redefined by the admitted local subclass'}));
} finally {
  // The unsupported constructor assertion can leave its just-allocated native handle open.
  // Explicitly retire that handle before reporting failure, never reopen while it survives.
  for(const native of natives) if(native.isOpen) {
    native.plan.close=undefined;native.close();
  }
}
assert.ok(natives.every(native=>native.isOpen===false));
console.log('RETIREMENT_FILES',JSON.stringify(natives.map(native=>native.allocatedPath)));
console.log('NATIVE_CHILD_COMPLETE_ALL_HANDLES_RETIRED',natives.length);
if(unknownLinkageFailure) throw unknownLinkageFailure;
`;

test('C1 §2.1 committed-production native fault linkage, mechanism ONLY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-c1-native-'));
  try {
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module'], {
      input: nativeFaultChild,
      encoding: 'utf8',
      env: { ...process.env, C1_FAULT_ROOT: dir },
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    process.stdout.write(child.stdout);
    process.stderr.write(child.stderr);
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.match(child.stdout, /NATIVE_CHILD_COMPLETE_ALL_HANDLES_RETIRED/);
    const line = child.stdout.split('\n').find((line) => line.startsWith('RETIREMENT_FILES '));
    assert.ok(line);
    const paths: unknown = JSON.parse(line.slice('RETIREMENT_FILES '.length));
    assert.ok(Array.isArray(paths));
    for (const path of paths) {
      assert.equal(typeof path, 'string');
      assert.ok(path.startsWith(`${dir}/`) && existsSync(path));
      // BEFORE reopen: finite predecessor has exited and certified ALL native handles retired.
      console.log(
        'FIRST_EXACT_REOPEN',
        JSON.stringify({
          path,
          predecessorExit: child.status,
          handles: 0,
          sameCommittedConsumer: true,
          allOlderWritersFenced: true,
        }),
      );
      const db = openDb(path);
      try {
        assert.equal(db.get("SELECT * FROM setting WHERE key IN ('data','escaped')"), undefined);
        assert.equal(db.get<{ n: number }>("SELECT count(*) AS n FROM action_log WHERE action='test'")?.n, 0);
        assert.equal(db.all('SELECT * FROM schema_migration').length, 4);
      } finally {
        db.close();
      }
    }
    assert.equal(child.status, 0); // Unknown-state linkage remains a required assertion, never skipped/waived.
  } finally {
    rmSync(dir, { recursive: true });
  }
});

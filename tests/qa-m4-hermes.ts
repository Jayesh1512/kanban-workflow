/** Explicit, single paid installed-Hermes client attempt. Never part of npm test.
 * Run only with QA_HERMES_ONESHOT=1 and the two explicit QA project variables.
 * Temporary profile alone is changed; only sanitized tool/SQL evidence is saved.
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rm, mkdtemp, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { canonicalFixture } from './qa-m4-support.js';
if (process.env['QA_HERMES_ONESHOT'] !== '1') throw new Error('Explicit QA_HERMES_ONESHOT=1 required; this invokes installed Hermes once');
const exec = promisify(execFile), name = `antseed-qa-m4-${Date.now()}`;
const dir = await mkdtemp(join(tmpdir(), 'antseed-qa-m4-hermes-'));
const defaultPath = execFileSync('hermes', ['config','path'], { encoding: 'utf8' }).trim();
const original = await readFile(defaultPath), defaultEnvPath = join(dirname(defaultPath), '.env');
const originalEnv = await readFile(defaultEnvPath).catch(() => null);
let profileCreated = false, f: Awaited<ReturnType<typeof canonicalFixture>> | undefined;
try {
  f = await canonicalFixture();
  execFileSync('hermes', ['profile','create',name,'--clone','--no-alias'], { stdio: ['ignore','pipe','pipe'] }); profileCreated = true;
  const configPath = execFileSync('hermes', ['-p',name,'config','path'], { encoding: 'utf8' }).trim();
  const profileDir = dirname(configPath);
  // Edit only the freshly created clone. Clear all inherited unrelated inputs.
  const python = '/Users/jys/.hermes/hermes-agent/venv/bin/python';
  execFileSync(python, ['-c', 'import sys,yaml; p=sys.argv[1]; c=yaml.safe_load(open(p)) or {}; c["mcp_servers"]={"antseed":{"url":sys.argv[2],"enabled":True,"timeout":20}}; c["memory"]={"memory_enabled":False}; c["plugins"]={"enabled":[],"disabled":[]}; c["hooks"]={}; open(p,"w").write(yaml.safe_dump(c,sort_keys=False))', configPath, `${f.url}/mcp`], { stdio: ['ignore','pipe','pipe'] });
  for (const p of ['skills','memories','SOUL.md','MEMORY.md','USER.md']) await rm(join(profileDir,p), { recursive: true, force: true });
  const discovery = await exec('hermes', ['-p',name,'mcp','test','antseed'], { timeout: 30000, maxBuffer: 1024*1024 });
  if (!/29/.test(discovery.stdout)) throw new Error('Installed Hermes did not discover expected tool count');
  const before = await f.h.remote();
  const args = { idempotencyKey:'qa-installed-hermes-single-proposal', ticketId:f.h.ticket.id, expectedStageVersion:0, targetLane:'Work in progress', evidenceIds:[f.h.evidenceId], reason:'Synthetic QA company reports engineering review underway; pending operator review required', nextAction:null };
  const prompt = `You are executing a single bounded integration check on an isolated synthetic company. Use only the antseed MCP server. Invoke propose_lane_change EXACTLY ONCE with these exact JSON arguments: ${JSON.stringify(args)}. Work in progress is the canonical lane. If you need tool_describe to load that tool, do so. Do not invoke replay_analysis, approval, send, login, imports, policy/mapping changes, terminal, other servers or tools. Do not treat the proposal as applied. After the call, report the returned proposal ID and pending decision. Stop; no additional tool calls are needed. All source IDs have been validated by the test harness.`;
  const query = join(dir,'query.txt'); await writeFile(query,prompt,{mode:0o600});
  // Exactly one model run; no automatic retries of the CLI by this QA harness.
  const guard = await open(join(tmpdir(),'antseed-qa-m4-hermes-single-model-attempt.lock'),'wx'); await guard.close();
  let cliExit = 0, stdout = '';
  try { stdout = (await exec('hermes', ['-p',name,'chat','--query-file',query,'--oneshot','--max-turns','5','--run-budget','60','--format','stream-json','--ignore-rules','--reasoning','low','-t','antseed'], { timeout: 75000, maxBuffer: 5*1024*1024, cwd:dir })).stdout; }
  catch (error) { const e = error as {code?:number;stdout?:string}; cliExit = typeof e.code === 'number' ? e.code : 1; stdout = e.stdout ?? ''; }
  const events = stdout.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });
  const tools: string[] = [];
  // Retain no model prompt/config/log text, only recognized tool-name metadata.
  for (const e of events) { const text = JSON.stringify(e); for (const match of text.matchAll(/mcp__antseed__[a-z_]+/g)) if (!tools.includes(match[0])) tools.push(match[0]); }
  const proposals = (await f.h.db.query('SELECT id,origin,decision,apply_state,target_lane FROM proposals')).rows;
  const local = await f.h.local(), after = await f.h.remote();
  const result = { baseline:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), installedHermes:execFileSync('hermes',['--version'],{encoding:'utf8'}).trim(), cliExit, discoveredToolCount:29, tools, proposals, local:{lane:local.lane,stageVersion:local.stageVersion}, remoteUnchanged:before?.bucketId===after?.bucketId, mutations:(await f.h.db.query('SELECT count(*)::int n FROM mutations')).rows[0]!.n, defaultConfigUnchanged:original.equals(await readFile(defaultPath)), defaultEnvUnchanged:originalEnv===null ? true : originalEnv.equals(await readFile(defaultEnvPath)) };
  await writeFile(join(dir,'sanitized-result.json'),JSON.stringify(result,null,2),{mode:0o600});
  console.log(JSON.stringify({artifact:join(dir,'sanitized-result.json'),...result}));
  if (cliExit!==0 || proposals.length!==1 || proposals[0]!.origin!=='hermes' || proposals[0]!.decision!=='pending' || proposals[0]!.target_lane!=='Work in progress' || local.stageVersion!==0 || !result.remoteUnchanged || result.mutations!==0 || !tools.includes('mcp__antseed__propose_lane_change') || !result.defaultConfigUnchanged || !result.defaultEnvUnchanged) throw new Error('Installed-Hermes pending-only acceptance assertion failed');
} finally {
  if (profileCreated) execFileSync('hermes',['profile','delete',name,'--yes'],{stdio:['ignore','pipe','pipe']});
  await f?.close(); await rm(join(dir,'query.txt'),{force:true});
}

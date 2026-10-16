// One fresh canonical Compose up. Never reuse/remove a project or any volume.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const root=process.cwd(),project=`antseed-qa-m5-20261017-${randomBytes(3).toString('hex')}`,ports={backend:19080,vikunja:19081,postgres:19433};
for(const port of Object.values(ports))await new Promise((resolve,reject)=>{const server=createServer();server.once('error',()=>reject(new Error(`QA port ${port} already occupied`)));server.listen(port,'127.0.0.1',()=>server.close(resolve));});
const docker=(args,options={})=>execFileSync('docker',args,{encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:32*1024*1024,...options});
assert.equal(docker(['ps','-aq','--filter',`label=com.docker.compose.project=${project}`]).trim(),'');
assert.equal(docker(['volume','ls','-q','--filter',`label=com.docker.compose.project=${project}`]).trim(),'');
const directory=await mkdtemp(join(tmpdir(),'antseed-qa-m5-')),ai=join(directory,'synthetic.env'),override=join(directory,'ports.yaml');
await writeFile(ai,`OPENAI_API_KEY=QA-M5-OPENAI-${randomBytes(16).toString('hex')}\nAI_GATEWAY_API_KEY=QA-M5-GATEWAY-${randomBytes(16).toString('hex')}\nJEV_API_KEY=\n`,{mode:0o600});
await writeFile(override,`services:\n  postgres:\n    ports: ["127.0.0.1:${ports.postgres}:5432"]\n`,{mode:0o600});
const compose_args=['docker','compose','--project-name',project,'--project-directory',root,'-f','compose.yaml','-f',override];
const environment_overrides={AI_ENV_PATH:ai,BACKEND_PORT:String(ports.backend),VIKUNJA_PORT:String(ports.vikunja),TELEGRAM_API_ID:'',TELEGRAM_API_HASH:''};
const m1='antseed-qa-m1-06374d3-20261017a';
const m1Ids=docker(['ps','-aq','--filter',`label=com.docker.compose.project=${m1}`]).trim().split('\n').filter(Boolean);
const m1Before=m1Ids.map(id=>{const c=JSON.parse(docker(['inspect',id]))[0];return{id:c.Id,image:c.Image,startedAt:c.State.StartedAt,status:c.State.Status};});
const manifest={project,root,directory,ports,compose_args,environment_overrides,source_commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),accepted_product:'5d2603d',m1Before};
const path=join(directory,'manifest.json');await writeFile(path,JSON.stringify(manifest,null,2),{mode:0o600});await writeFile('/tmp/antseed-qa-m5-manifest-path',path+'\n',{mode:0o600});
console.log(`Fresh QA project ${project}; loopback ${ports.backend}/${ports.vikunja}/${ports.postgres}; canonical up --build -d`);
try{docker([...compose_args.slice(1),'up','--build','-d'],{env:{...process.env,...environment_overrides},timeout:300000});}
catch{throw new Error(`Canonical Compose up failed for ${project}; inspect scoped Docker logs privately, not credential contents`);}
const container=docker([...compose_args.slice(1),'ps','-q','backend'],{env:{...process.env,...environment_overrides}}).trim();
const inspect=JSON.parse(docker(['inspect',container]))[0];assert.deepEqual(inspect.Config.Cmd,['node','dist/main.js']);
manifest.backend_image=inspect.Image;manifest.backend_container=container;await writeFile(path,JSON.stringify(manifest,null,2),{mode:0o600});
console.log(JSON.stringify({result:'PASS canonical fresh Compose up',project,ports,source:manifest.source_commit,image:manifest.backend_image,manifest:path}));

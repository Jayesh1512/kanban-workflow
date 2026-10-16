import { execFileSync } from 'node:child_process';
import { parse } from 'dotenv';
import { describe, expect, it, vi } from 'vitest';
import { loadRuntimeConfig } from '../src/platform/config.js';
import { VikunjaAdapter } from '../src/vikunja/adapter.js';
import { company, isolatedDatabase, seed, sourceInput } from './qa-m31-support.js';

const project=process.env['QA_M31_PROJECT'];
describe.skipIf(!project)('independent M1 follow-up, actual pinned Vikunja no-op 304',()=> {
  it('reads back two native304s, updates labels and preserves Completed plus unrelated fields',async()=> {
    const fixture=await isolatedDatabase(project!);
    const bundle=parse(execFileSync('docker',['compose','-p',project!,'-f','compose.yaml','exec','-T','backend','cat','/run/antseed/runtime.env'],{encoding:'utf8',stdio:['pipe','pipe','pipe']}));
    const config=await loadRuntimeConfig({...bundle,AI_ENV_PATH:'/qa-no-provider-env',VIKUNJA_URL:'http://127.0.0.1:18081'});
    const adapter=new VikunjaAdapter(config.vikunja,fixture.db), native=globalThis.fetch.bind(globalThis);
    const seen: Array<{path:string;status:number}>=[];
    const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=> { const res=await native(input,init); if(init?.method==='PATCH') seen.push({path:new URL(String(input)).pathname,status:res.status}); return res; });
    let token:string|undefined,taskId:string|undefined,labelId:unknown;
    async function api(path:string,method='GET',body?:unknown):Promise<Record<string,any>> {
      const res=await native(`${config.vikunja.baseUrl}/api/v2${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      expect(res.ok,`${method} ${path} status ${res.status}`).toBe(true); return res.status===204?{}:await res.json();
    }
    try {
      const login=await native(`${config.vikunja.baseUrl}/api/v2/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:config.vikunja.username,password:config.vikunja.password})});
      expect(login.status).toBe(200); token=(await login.json() as {token:string}).token;
      const src=sourceInput('rel-035'); await seed(fixture.db,src); const c=await company(fixture.db,src.chat.id);
      const t=(await fixture.db.query('INSERT INTO tickets(chat_id,company_id) VALUES($1,$2) RETURNING id',[src.chat.id,c])).rows[0]!;
      const board=await adapter.ensureBoard(),task=await adapter.ensureTask({ticketId:String(t.id),title:'QA304 synthetic company',description:'Independent no-op repro',workstream:'Buyer'}); taskId=task.id;
      labelId=(await api('/labels','POST',{title:`QA304-unrelated-${t.id}`})).id;
      await api(`/tasks/${task.id}/labels`,'POST',{label_id:labelId});
      const initial=await api(`/tasks/${task.id}`);
      await api(`/tasks/${task.id}`,'PUT',{...initial,priority:4,due_date:'2026-10-23T04:30:00Z',percent_done:.75});
      await adapter.moveTask({taskId:task.id,projectId:board.projectId,viewId:board.viewId,targetBucketId:board.buckets.Completed});
      const before=await api(`/tasks/${task.id}`);
      for (let i=0;i<2;i++) expect((await adapter.updateTaskDetails({taskId:task.id,title:task.title,description:task.description,workstream:'Integration'})).bucketId).toBe(board.buckets.Completed);
      expect(seen.filter((r)=>r.path===`/api/v2/tasks/${task.id}`).map((r)=>r.status)).toEqual([304,304]);
      const after=await api(`/tasks/${task.id}`);
      for (const k of ['title','description','done','priority','due_date','percent_done']) expect(after[k],k).toEqual(before[k]);
      expect(after.done).toBe(true); expect((after.labels as Array<{title:string}>).map((x)=>x.title).sort()).toEqual(['Integration',`QA304-unrelated-${t.id}`].sort());
      await adapter.moveTask({taskId:task.id,projectId:board.projectId,viewId:board.viewId,targetBucketId:board.buckets.Archived}); expect((await adapter.getTask(task.id))?.bucketId).toBe(board.buckets.Archived);
      expect((await adapter.updateTaskDetails({taskId:task.id,title:task.title,description:task.description,workstream:'Provider'})).bucketId).toBe(board.buckets.Archived);
    } finally {
      spy.mockRestore();
      if(token&&taskId) await api(`/tasks/${taskId}`,'DELETE');
      if(token&&labelId) await api(`/labels/${labelId}`,'DELETE');
      await fixture.close();
    }
  });
});

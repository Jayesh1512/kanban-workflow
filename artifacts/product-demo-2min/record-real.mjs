import{createServer}from'node:http';import{execFile}from'node:child_process';import{readFileSync}from'node:fs';import{randomUUID}from'node:crypto';
const key='/login-'+randomUUID();const server=createServer((req,res)=>{
 if(req.url===key&&req.headers.origin==='http://localhost:19381'){
 const code=`import{loadRuntimeConfig}from'./dist/platform/config.js';const c=await loadRuntimeConfig();const r=await fetch('http://host.docker.internal:19381/api/v2/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:c.vikunja.username,password:c.vikunja.password}),signal:AbortSignal.timeout(45000)});if(!r.ok)process.exit(1);const{token}=await r.json();process.stdout.write(JSON.stringify({token}));`;
 execFile('docker',['exec','antseed-personal-account2-backend-1','node','--input-type=module','-e',code],{timeout:50000,maxBuffer:65536},(err,stdout)=>{if(err){res.writeHead(503,{'Access-Control-Allow-Origin':'http://localhost:19381'}).end('{}');return;}res.writeHead(200,{'content-type':'application/json','cache-control':'no-store','Access-Control-Allow-Origin':'http://localhost:19381'}).end(stdout)});return;}
 if(req.url==='/'||req.url==='/crm'){res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'}).end(readFileSync(new URL('../outreach-dashboard/index.html',import.meta.url)));return;}
 res.writeHead(404).end();});
server.listen(19395,'127.0.0.1',()=>console.log(JSON.stringify({crmUrl:'http://127.0.0.1:19395/crm',loginUrl:'http://127.0.0.1:19395'+key})));process.on('SIGTERM',()=>server.close());

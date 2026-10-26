import {chromium} from '/Users/jys/.t3/projects/video-creater/node_modules/playwright/index.mjs';
import fs from'node:fs/promises';import path from'node:path';
const root=path.resolve('artifacts/product-demo-2min');const evidence=path.join(root,'evidence');
const redact = () => { const clean=()=>{if(!document.body)return;const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){if(n.parentElement?.closest('script,style,input,textarea'))continue;const t=n.textContent;const v=t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email hidden]').replace(/\+?\d[\d ()-]{9,}\d/g,'[phone hidden]');if(t!==v)n.textContent=v;}};new MutationObserver(clean).observe(document.documentElement,{childList:true,subtree:true});clean();};
const browser=await chromium.launch({headless:true,executablePath:'/Users/jys/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',args:['--no-sandbox']});
const auth=await browser.newContext({viewport:{width:1920,height:1080}});const temp=await auth.newPage();
try{
 await temp.goto('http://localhost:19281/login',{waitUntil:'domcontentloaded'});
 const token=await temp.evaluate(async()=>{const r=await fetch('http://127.0.0.1:19396/local-live-login');if(!r.ok)throw Error('Native login unavailable');return(await r.json()).token;});
 await temp.evaluate(t=>localStorage.setItem('token',t),token);const state=await auth.storageState();await auth.close();
 const ctx=await browser.newContext({storageState:state,viewport:{width:1920,height:1080},recordVideo:{dir:path.join(evidence,'real-raw'),size:{width:1920,height:1080}}});await ctx.addInitScript(redact);const page=await ctx.newPage();
 const net=[];page.on('response',r=>{if(r.url().includes('/api/'))net.push({path:new URL(r.url()).pathname,status:r.status()})});setTimeout(()=>{page.screenshot({path:path.join(evidence,'real-work-wait.png')}).catch(()=>{});fs.writeFile(path.join(evidence,'real-work-network.json'),JSON.stringify(net,null,2)).catch(()=>{});},35000).unref();const started=Date.now();await page.goto('http://localhost:19281/projects/2/8',{waitUntil:'domcontentloaded',timeout:45000});await page.getByText('To be started',{exact:false}).first().waitFor({timeout:30000});await page.waitForTimeout(2000);
 const cuts={boardReady:(Date.now()-started)/1000};await page.screenshot({path:path.join(evidence,'real-live-board.png')});console.log(JSON.stringify({boardReady:true,title:await page.title()}));await page.waitForTimeout(12000);
 // Inspect a real business card, without editing or moving anything.
 await page.goto('http://localhost:19281/tasks/2',{waitUntil:'networkidle'});await page.waitForTimeout(1500);cuts.cardReady=(Date.now()-started)/1000;await page.screenshot({path:path.join(evidence,'real-live-card.png')});console.log(JSON.stringify({cardOpen:true,title:await page.title()}));await page.waitForTimeout(10000);await page.mouse.wheel(0,640);await page.waitForTimeout(1500);await page.screenshot({path:path.join(evidence,'real-live-card-lower.png')});await page.waitForTimeout(12000);
 cuts.end=(Date.now()-started)/1000;const video=page.video();await page.close();await ctx.close();cuts.path=await video.path();await fs.writeFile(path.join(evidence,'real-live-work-capture.json'),JSON.stringify(cuts,null,2));console.log(JSON.stringify({workRecorded:true,seconds:cuts.end}));

}finally{await browser.close()}

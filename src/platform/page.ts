export const onboardingPage = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AntSeed connections</title><style>
body{font:16px/1.6 system-ui,sans-serif;margin:3rem auto;padding:0 1.5rem;max-width:58rem;color:#172d28;background:#f7f8f5}h1{font-size:2rem}article{background:white;border:1px solid #cdd7d1;border-radius:8px;padding:1.5rem;margin:1rem 0}h2{margin:0;font-size:1.2rem}button,a{color:#145844}button{font:inherit;padding:.45rem 1rem;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#455d54}.state{font-weight:600}dt{font-weight:600}dd{margin:0 0 1rem}a:focus-visible,button:focus-visible{outline:3px solid #b46924}
</style><main><h1>AntSeed connections</h1>
<p>PostgreSQL and the Vikunja board initialize automatically. This page shows actual connection and setup state.</p>
<button id="refresh">Refresh status</button><p id="notice" role="status">Loading…</p><section id="components" aria-label="Connections"></section>
<article><h2>Telegram onboarding</h2><p id="telegram">Loading login state…</p><p>M1 provides deployment and board setup. Telegram login, chat discovery, history and control-group actions arrive with M2. No Telegram messages are being read or sent.</p></article>
<article><h2>Provider configuration</h2><p>AI configuration loads from a read-only runtime file; environment values take precedence. Configured keys do not prove provider access. Jev uses Vercel AI Gateway and may need paid Gateway credits.</p><dl id="configuration"></dl><small>Credentials and session contents are never shown here.</small></article>
<article><h2>Operational work</h2><pre id="work"></pre></article></main>
<script>
const el=id=>document.getElementById(id);
async function refresh(){try{const response=await fetch('/api/status');if(!response.ok)throw new Error('Status request failed');const s=await response.json();el('components').replaceChildren();for(const [name,v]of Object.entries(s.components)){const card=document.createElement('article'),h=document.createElement('h2'),p=document.createElement('p');h.textContent=name+' · '+v.state;p.textContent=v.detail||'Ready';card.append(h,p);el('components').append(card);}el('telegram').textContent=s.telegramLogin.detail||s.telegramLogin.state;el('configuration').replaceChildren();for(const [k,v]of Object.entries(s.configuration)){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=k;dd.textContent=v?'Present':'Missing';el('configuration').append(dt,dd);}el('work').textContent=JSON.stringify({accountBound:s.accountBound,imports:s.imports,replayPending:s.replayPending,analysisPending:s.analysisPending,proposalsPending:s.proposalsPending},null,2);el('notice').textContent='Updated '+new Date().toLocaleTimeString();}catch(e){el('notice').textContent='Could not load status. Check that the backend is running.';}}
el('refresh').addEventListener('click',refresh);refresh();
</script></html>`;

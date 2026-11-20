import type { FastifyInstance } from 'fastify';
import type { Database } from '../shared/ports.js';
import { approvedChatSourceSql } from '../shared/source-approval.js';
import { internalContactSql } from '../shared/team.js';
import { brandFontLink, nativeTokens, topbarMarkup, topbarScript, topbarStyles } from './page.js';

/** Chats that count as "talking to" a company: admitted, business, mapped to a company. Alias: c. */
const talkingSql = `c.company_id IS NOT NULL AND c.inclusion='included' AND NOT c.is_control AND ${approvedChatSourceSql('c')}`;

const teamSql = internalContactSql('p');

/** Read-only company/contact directory. Any signed-in member may read it (the global auth hook gates `/api/*`). */
export function registerDirectory(app: FastifyInstance, db: Database, ready: () => Promise<void>) {
  app.get('/directory', async (_request, reply) => reply.type('text/html; charset=utf-8').send(directoryPage));
  app.get('/antseed-team', async (_request, reply) => reply.type('text/html; charset=utf-8').send(teamPage));
  app.get('/api/board/directory/team', async () => {
    await ready();
    // Activity is limited to approved company conversations; team members are never read from other chats.
    const items = (await db.query(`WITH scope AS (SELECT c.id AS chat_id,c.company_id,co.canonical_name FROM chats c JOIN companies co ON co.id=c.company_id WHERE ${talkingSql})
      SELECT p.id,p.names,p.usernames,p.emails,p.phones,
        (SELECT coalesce(array_agg(DISTINCT r.role ORDER BY r.role),'{}') FROM contact_company_roles r WHERE r.contact_id=p.id) AS roles,
        (SELECT max(m.sent_at) FROM messages m JOIN contact_telegram_ids t ON t.telegram_user_id=m.sender_id
          WHERE t.contact_id=p.id AND m.deleted_at IS NULL AND m.chat_id IN (SELECT chat_id FROM scope)) AS last_active
      FROM contacts p WHERE ${teamSql} ORDER BY last_active DESC NULLS LAST,p.names[1],p.id`)).rows;
    return { items };
  });
  app.get('/api/board/directory', async () => {
    await ready();
    // `companies` and `contacts` are the primary source: every company row is listed, whether or not we have a chat with it.
    // Conversations are secondary detail (approved company chats only).
    // Reached out = the company shows up in the CRM (an outreach relationship, by company or by exact name, or a ticket) or has a
    // decision waiting in the Approvals tab (stage proposal or lane proposal). Planned = tier A/B and not reached yet (see below).
    const companies = (await db.query(`WITH reach AS (
        SELECT r.company_id,'CRM · '||coalesce(sd.label,'no stage yet') AS via FROM outreach_relationships r
          LEFT JOIN outreach_stage_definitions sd ON sd.id=r.accepted_stage WHERE r.retained AND r.company_id IS NOT NULL
        UNION ALL SELECT co.id,'CRM · '||coalesce(sd.label,'no stage yet') FROM outreach_relationships r
          JOIN companies co ON lower(co.canonical_name)=lower(r.display_name) LEFT JOIN outreach_stage_definitions sd ON sd.id=r.accepted_stage
          WHERE r.retained AND r.kind='contact_prospect'
        UNION ALL SELECT t.company_id,'CRM ticket · '||t.lane FROM tickets t WHERE t.company_id IS NOT NULL
        UNION ALL SELECT r.company_id,'Approvals · stage proposal' FROM outreach_sales_proposals p
          JOIN outreach_relationships r ON r.id=p.relationship_id WHERE p.state='pending' AND r.retained AND r.company_id IS NOT NULL
        UNION ALL SELECT t.company_id,'Approvals · lane proposal' FROM proposals p JOIN tickets t ON t.id=p.ticket_id
          WHERE p.decision='pending' AND p.apply_state<>'stale' AND t.company_id IS NOT NULL)
      SELECT co.id,co.canonical_name AS name,co.domains,co.source,co.funding,co.location,co.employees,co.category,
        co.outreach_tier AS "outreachTier",co.outreach_score AS "outreachScore",co.status,co.summary,
        coalesce((SELECT array_agg(DISTINCT x.via ORDER BY x.via) FROM reach x WHERE x.company_id=co.id),'{}') AS "reachedVia",
        coalesce((SELECT jsonb_agg(jsonb_build_object('title',c.title,'lastMessageAt',lm.at) ORDER BY lm.at DESC NULLS LAST)
          FROM chats c LEFT JOIN LATERAL (SELECT max(m.sent_at) AS at FROM messages m WHERE m.chat_id=c.id AND m.deleted_at IS NULL) lm ON true
          WHERE c.company_id=co.id AND ${talkingSql}),'[]'::jsonb) AS conversations
      FROM companies co ORDER BY co.outreach_score DESC NULLS LAST,lower(co.canonical_name),co.id LIMIT 1000`)).rows;
    // A person belongs to a company by contacts.company_id (primary), a recorded role there, or evidence in one of its approved chats.
    // Our own team is listed on /antseed-team instead. Last contacted = their latest message in the company's approved chats.
    const people = (await db.query(`WITH scope AS (SELECT c.id AS chat_id,c.company_id FROM chats c WHERE ${talkingSql}),
      link AS (SELECT company_id,id AS contact_id FROM contacts WHERE company_id IS NOT NULL
        UNION SELECT company_id,contact_id FROM contact_company_roles
        UNION SELECT s.company_id,ce.contact_id FROM scope s JOIN evidence e ON e.chat_id=s.chat_id JOIN contact_evidence ce ON ce.evidence_id=e.id)
      SELECT l.company_id,p.id,p.names,p.usernames,p.emails,p.phones,p.title,p.linkedin,p.x_account AS "xAccount",p.telegram,p.discord,
        (SELECT coalesce(array_agg(DISTINCT r.role ORDER BY r.role),'{}') FROM contact_company_roles r WHERE r.contact_id=p.id AND r.company_id=l.company_id) AS roles,
        (SELECT max(m.sent_at) FROM messages m JOIN contact_telegram_ids t ON t.telegram_user_id=m.sender_id
          WHERE t.contact_id=p.id AND m.deleted_at IS NULL AND m.chat_id IN (SELECT chat_id FROM scope WHERE company_id=l.company_id)) AS last_contacted
      FROM link l JOIN contacts p ON p.id=l.contact_id
      WHERE NOT ${teamSql}
      ORDER BY last_contacted DESC NULLS LAST,p.names[1],p.id`)).rows;
    const byCompany = new Map<string, Record<string, unknown>[]>();
    for (const { company_id, ...person } of people) {
      const list = byCompany.get(String(company_id)) ?? [];
      list.push(person);
      byCompany.set(String(company_id), list);
    }
    // Will reach out = not reached yet, and the sheet rates it tier A (target now) or B (target after enrichment).
    const planned = (tier: unknown) => /^[AB]\b/.test(String(tier ?? ''));
    return {
      items: companies.map((co) => ({
        ...co,
        outreach: co.reachedVia.length ? 'reached' : planned(co.outreachTier) ? 'planned' : 'none',
        people: byCompany.get(String(co.id)) ?? [],
      })),
    };
  });
}

const pageHead = (title: string) => String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · AntSeed Workbench</title>${brandFontLink}<style>
${nativeTokens}${topbarStyles}
*{box-sizing:border-box}body{margin:0;color:var(--ink);background:var(--paper);font:14px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1900px;margin:auto;padding:20px 24px 40px}h1{font-size:26px;line-height:1.2;letter-spacing:-.025em;margin:0 0 8px}p{max-width:75ch;margin:8px 0}a{color:var(--accent);text-underline-offset:3px}.muted{color:var(--soft);font-size:12px}[hidden]{display:none!important}
main button,input{font:inherit;color:var(--ink);background:var(--paper);border:1px solid var(--line);border-radius:7px;min-height:42px;padding:9px 12px}input{width:100%}label{display:grid;gap:5px;font-size:12px;font-weight:600;max-width:420px;margin:16px 0}
.notice{border:1px solid var(--dangerline);color:var(--danger);background:var(--dangerbg);border-radius:8px;padding:12px 14px;margin:16px 0}.notice:empty{display:none}
table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid var(--line)}thead th{position:sticky;top:0;background:var(--wash);font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--soft);z-index:1}td>span,td>a{display:block}
.outer>tbody>tr>td:first-child{width:22%;min-width:200px}.outer>tbody>tr>td:last-child{padding:0}.name{font-weight:700;font-size:15px;margin:0}.convo{margin:6px 0 0;padding:0;list-style:none}.convo li{font-size:12px;color:var(--soft)}
.outer>tbody>tr.reached>td:first-child{box-shadow:inset 4px 0 #1a7f4b;background:rgba(26,127,75,.09)}.outer>tbody>tr.planned>td:first-child{box-shadow:inset 4px 0 #b7791f;background:rgba(183,121,31,.1)}.badge{display:inline-block;font-size:11px;font-weight:700;border-radius:99px;padding:1px 8px;margin:4px 4px 0 0}.badge.reached{background:#1a7f4b;color:#fff}.badge.planned{background:#b7791f;color:#fff}.legend{display:flex;gap:14px;font-size:12px;margin:8px 0}.legend .badge{margin:0}.people th{position:static;background:none;padding:8px 12px;border-bottom:1px solid var(--line);font-size:11px}.people td{padding:8px 12px;border-bottom:1px solid var(--line)}.people tr:last-child td{border-bottom:0}.people td[rowspan]{border-right:1px solid var(--line);width:14%}
@media(max-width:900px){.outer{display:block;overflow-x:auto}}
</style></head><body>
${topbarMarkup}`;

/** Script helpers shared by both pages. */
const commonScript = String.raw`${topbarScript}
const el=id=>document.getElementById(id);let items=[];
function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function day(v){const d=v?new Date(v):null;return d&&!Number.isNaN(d.valueOf())?d.toLocaleDateString(undefined,{dateStyle:'medium'}):'—';}
function link(href,text){try{const u=new URL(href);if(!['https:','http:','mailto:','tel:'].includes(u.protocol)||u.username||u.password)return node('span',text);const a=node('a',text);a.href=u.href;if(u.protocol.startsWith('http')){a.target='_blank';a.rel='noopener noreferrer';}return a;}catch{return node('span',text);}}
const cell=(...kids)=>{const td=node('td');td.append(...(kids.length?kids:[node('span','—','muted')]));return td;};
const personName=p=>p.names.join(', ')||(p.usernames[0]?'@'+p.usernames[0]:'Unnamed contact');
const contactCells=p=>[cell(...p.emails.map(e=>link('mailto:'+e,e))),cell(...p.usernames.map(u=>link('https://t.me/'+encodeURIComponent(u),'@'+u))),cell(...p.phones.map(x=>link('tel:'+x.replace(/[^\d+]/g,''),x)))];
async function start(url,haystack,label){try{const s=await fetch('/api/session',{cache:'no-store'});if(s.status===401){location.assign('/login');return;}mountTopbar((await s.json()).member);
 const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw Error((await r.json().catch(()=>null))?.error?.message||'Could not load this page.');
 items=(await r.json()).items;window.render=()=>{const q=el('search').value.trim().toLowerCase(),shown=items.filter(x=>!q||haystack(x).includes(q));
  el('count').textContent='· '+shown.length+(q?' of '+items.length:'')+' '+label;paint(shown,q);};el('search').oninput=window.render;window.render();}catch(e){el('notice').textContent=e.message;el('rows').replaceChildren();}}
const emptyRow=(cols,text)=>{const r=node('tr'),td=node('td',text,'muted');td.colSpan=cols;r.append(td);return r;};`;

export const directoryPage = pageHead('CRM Directory') + String.raw`
<main><div class="heading" id="content" tabindex="-1"><div><h1>Directory <span class="muted" id="count"></span></h1><p class="muted">Every company in our database with its people. Read only; read directly from the <code>companies</code> and <code>contacts</code> tables, which hold sheet-imported prospects as well as companies from approved conversations. Our own team is on the <a href="/antseed-team">AntSeed team</a> page.</p></div></div>
<div id="notice" class="notice" role="alert"></div>
<div class="legend"><span><span class="badge reached">Reached out</span> in the CRM or waiting in Approvals</span><span><span class="badge planned">Will reach out</span> tier A or B, not yet contacted</span></div>
<label>Search<input id="search" type="search" placeholder="Company, person, email, source, funding or website" autocomplete="off"></label>
<table class="outer"><thead><tr><th scope="col">Company</th><th scope="col">People</th></tr></thead><tbody id="rows"><tr><td colspan="2" class="muted">Loading…</td></tr></tbody></table></main>
<script>${commonScript}
const site=d=>link(/^https?:\/\//i.test(d)?d:'https://'+d,d.replace(/^https?:\/\//i,'').replace(/\/$/,''));
const ext=(href,label)=>href?link(href,label):null;
const linksOf=p=>[ext(p.linkedin,'LinkedIn'),ext(p.xAccount,'X'),...p.usernames.map(u=>link('https://t.me/'+encodeURIComponent(u),'@'+u)),p.telegram&&!p.usernames.length?ext(p.telegram,'Telegram'):null,ext(p.discord,'Discord')].filter(Boolean);
const designation=p=>[...new Set([p.title,...p.roles].filter(Boolean))];
function peopleTable(co){const t=node('table','','people'),head=node('tr');for(const h of ['Website','Contact','Designation','Email','Links','Phone','Last contacted'])head.append(node('th',h));
 const thead=node('thead');thead.append(head);const body=node('tbody');t.append(thead,body);
 const websites=cell(...co.domains.map(site));websites.rowSpan=Math.max(co.people.length,1);
 if(!co.people.length){const r=node('tr');r.append(websites);const td=node('td','No contacts recorded yet','muted');td.colSpan=6;r.append(td);body.append(r);return t;}
 co.people.forEach((p,i)=>{const r=node('tr');if(!i)r.append(websites);
  r.append(cell(node('span',personName(p))),cell(...designation(p).map(x=>node('span',x))),cell(...p.emails.map(e=>link('mailto:'+e,e))),cell(...linksOf(p).map(x=>{const w=node('span');w.append(x);return w;})),cell(...p.phones.map(x=>link('tel:'+x.replace(/[^\d+]/g,''),x))),cell(node('span',day(p.last_contacted))));body.append(r);});return t;}
function row(co){const r=node('tr'),name=node('td'),convo=node('ul',undefined,'convo');name.append(node('p',co.name,'name'));
 if(co.outreach!=='none'){r.className=co.outreach;name.append(node('span',co.outreach==='reached'?'Reached out':'Will reach out','badge '+co.outreach));}
 for(const v of co.reachedVia)name.append(node('div',v,'muted'));
 const facts=[co.source,co.outreachTier,co.funding&&'Funding '+co.funding,co.location,co.employees&&co.employees+' people'].filter(Boolean);
 for(const f of facts)name.append(node('div',f,'muted'));
 for(const c of co.conversations)convo.append(node('li',c.title+' · last message '+day(c.lastMessageAt)));name.append(convo);
 const people=node('td');people.append(peopleTable(co));r.append(name,people);return r;}
const paint=(shown,q)=>el('rows').replaceChildren(...(shown.length?shown.map(row):[emptyRow(2,q?'No match.':'No companies yet.')]));
start('/api/board/directory',co=>[co.name,co.source,co.outreachTier,co.outreach==='reached'?'reached out':co.outreach==='planned'?'will reach out':'',co.funding,co.location,...co.domains,...co.people.flatMap(p=>[...p.names,...p.usernames.map(u=>'@'+u),...p.emails,...p.phones,...p.roles,p.title])].filter(Boolean).join(' ').toLowerCase(),'companies');
</script></body></html>`;

export const teamPage = pageHead('AntSeed Team') + String.raw`
<main><div class="heading" id="content" tabindex="-1"><div><h1>AntSeed Team <span class="muted" id="count"></span></h1><p class="muted">Our own people. They are kept out of the <a href="/directory">CRM Directory</a> and CRM contacts.</p></div></div>
<div id="notice" class="notice" role="alert"></div>
<label>Search<input id="search" type="search" placeholder="Name, email or @handle" autocomplete="off"></label>
<table><thead><tr><th scope="col">Teammate</th><th scope="col">Designation</th><th scope="col">Email</th><th scope="col">Telegram</th><th scope="col">Phone</th><th scope="col">Last active</th></tr></thead><tbody id="rows"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody></table></main>
<script>${commonScript}
// Teammates are listed by first name only; search still matches their full names and handles.
const firstName=p=>(String(p.names?.[0]||'').trim().split(/[\s|,]+/)[0])||personName(p);
function row(p){const r=node('tr'),name=node('td');name.append(node('span',firstName(p)));r.append(name,cell(...p.roles.map(x=>node('span',x))),...contactCells(p),cell(node('span',day(p.last_active))));return r;}
const paint=(shown,q)=>el('rows').replaceChildren(...(shown.length?shown.map(row):[emptyRow(6,q?'No match.':'No teammates found yet.')]));
start('/api/board/directory/team',p=>[...p.names,...p.usernames.map(u=>'@'+u),...p.emails,...p.phones,...p.roles].join(' ').toLowerCase(),'people');
</script></body></html>`;

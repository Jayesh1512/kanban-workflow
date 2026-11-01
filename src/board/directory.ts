import type { FastifyInstance } from 'fastify';
import type { Database } from '../shared/ports.js';
import { approvedChatSourceSql } from '../shared/source-approval.js';
import { nativeTokens, topbarMarkup, topbarScript, topbarStyles } from './page.js';

/** Chats that count as "talking to" a company: admitted, business, mapped to a company. Alias: c. */
const talkingSql = `c.company_id IS NOT NULL AND c.inclusion='included' AND NOT c.is_control AND ${approvedChatSourceSql('c')}`;

/** Our own team, not a contact at a company. Alias: p (contacts). An explicit 'external' mark always wins; stored data is never edited.
 * `app_settings` key `directory:team` ({"telegramUserIds":[...]}) pins people by Telegram ID, because the extractor rewrites a contact's affiliation. */
const teamSql = `(p.affiliation='internal' OR (p.affiliation<>'external' AND (
  array_to_string(p.names||p.usernames,' ') ~* 'ant\\s?seed'
  OR EXISTS(SELECT 1 FROM contact_telegram_ids t WHERE t.contact_id=p.id AND (
    t.telegram_user_id IN (SELECT self_user_id FROM telegram_account)
    OR t.telegram_user_id IN (SELECT jsonb_array_elements_text(value->'telegramUserIds')::bigint FROM app_settings WHERE key='directory:team')
    OR t.telegram_user_id IN (SELECT telegram_user_id FROM workspace_members WHERE telegram_user_id IS NOT NULL))))))`;

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
          WHERE t.contact_id=p.id AND m.deleted_at IS NULL AND m.chat_id IN (SELECT chat_id FROM scope)) AS last_active,
        (SELECT coalesce(array_agg(DISTINCT s.canonical_name ORDER BY s.canonical_name),'{}') FROM scope s WHERE
          EXISTS(SELECT 1 FROM messages m JOIN contact_telegram_ids t ON t.telegram_user_id=m.sender_id WHERE t.contact_id=p.id AND m.chat_id=s.chat_id AND m.deleted_at IS NULL)
          OR EXISTS(SELECT 1 FROM contact_evidence ce JOIN evidence e ON e.id=ce.evidence_id WHERE ce.contact_id=p.id AND e.chat_id=s.chat_id AND e.invalidated_at IS NULL)) AS companies
      FROM contacts p WHERE ${teamSql} ORDER BY last_active DESC NULLS LAST,p.names[1],p.id`)).rows;
    return { items };
  });
  app.get('/api/board/directory', async () => {
    await ready();
    const companies = (await db.query(`SELECT co.id,co.canonical_name AS name,co.domains,
        jsonb_agg(jsonb_build_object('title',c.title,'lastMessageAt',lm.at) ORDER BY lm.at DESC NULLS LAST) AS conversations
      FROM companies co JOIN chats c ON c.company_id=co.id AND ${talkingSql}
      LEFT JOIN LATERAL (SELECT max(m.sent_at) AS at FROM messages m WHERE m.chat_id=c.id AND m.deleted_at IS NULL) lm ON true
      GROUP BY co.id ORDER BY lower(co.canonical_name),co.id LIMIT 1000`)).rows;
    // A person belongs to a company by a recorded role there or by evidence in one of its chats; our own team is listed on /antseed-team instead.
    // Last contacted = their latest message in those chats, else the latest evidence that mentions them.
    const people = (await db.query(`WITH scope AS (SELECT c.id AS chat_id,c.company_id FROM chats c WHERE ${talkingSql}),
      link AS (SELECT company_id,contact_id FROM contact_company_roles
        UNION SELECT s.company_id,ce.contact_id FROM scope s JOIN evidence e ON e.chat_id=s.chat_id JOIN contact_evidence ce ON ce.evidence_id=e.id)
      SELECT l.company_id,p.id,p.names,p.usernames,p.emails,p.phones,
        (SELECT coalesce(array_agg(DISTINCT r.role ORDER BY r.role),'{}') FROM contact_company_roles r WHERE r.contact_id=p.id AND r.company_id=l.company_id) AS roles,
        greatest(
          (SELECT max(m.sent_at) FROM messages m JOIN contact_telegram_ids t ON t.telegram_user_id=m.sender_id
            WHERE t.contact_id=p.id AND m.deleted_at IS NULL AND m.chat_id IN (SELECT chat_id FROM scope WHERE company_id=l.company_id)),
          (SELECT max(e.observed_at) FROM contact_evidence ce JOIN evidence e ON e.id=ce.evidence_id
            WHERE ce.contact_id=p.id AND e.invalidated_at IS NULL AND e.chat_id IN (SELECT chat_id FROM scope WHERE company_id=l.company_id))
        ) AS last_contacted
      FROM link l JOIN contacts p ON p.id=l.contact_id
      WHERE NOT ${teamSql} AND l.company_id IN (SELECT company_id FROM scope)
      ORDER BY last_contacted DESC NULLS LAST,p.id`)).rows;
    const byCompany = new Map<string, Record<string, unknown>[]>();
    for (const { company_id, ...person } of people) {
      const list = byCompany.get(String(company_id)) ?? [];
      list.push(person);
      byCompany.set(String(company_id), list);
    }
    return { items: companies.map((co) => ({ ...co, people: byCompany.get(String(co.id)) ?? [] })) };
  });
}

const pageHead = (title: string) => String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · AntSeed</title><style>
${nativeTokens}${topbarStyles}
*{box-sizing:border-box}body{margin:0;color:var(--ink);background:var(--paper);font:14px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1900px;margin:auto;padding:20px 24px 40px}h1{font-size:26px;line-height:1.2;letter-spacing:-.025em;margin:0 0 8px}p{max-width:75ch;margin:8px 0}a{color:var(--accent);text-underline-offset:3px}.muted{color:var(--soft);font-size:12px}[hidden]{display:none!important}
.topbar button,input{font:inherit;color:var(--ink);background:var(--paper);border:1px solid var(--line);border-radius:7px;min-height:42px;padding:9px 12px}input{width:100%}label{display:grid;gap:5px;font-size:12px;font-weight:600;max-width:420px;margin:16px 0}
.notice{border:1px solid var(--dangerline);color:var(--danger);background:var(--dangerbg);border-radius:8px;padding:12px 14px;margin:16px 0}.notice:empty{display:none}
table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid var(--line)}thead th{position:sticky;top:0;background:var(--wash);font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--soft);z-index:1}td>span,td>a{display:block}
.outer>tbody>tr>td:first-child{width:22%;min-width:200px}.outer>tbody>tr>td:last-child{padding:0}.name{font-weight:700;font-size:15px;margin:0}.convo{margin:6px 0 0;padding:0;list-style:none}.convo li{font-size:12px;color:var(--soft)}
.people th{position:static;background:none;padding:8px 12px;border-bottom:1px solid var(--line);font-size:11px}.people td{padding:8px 12px;border-bottom:1px solid var(--line)}.people tr:last-child td{border-bottom:0}.people td[rowspan]{border-right:1px solid var(--line);width:14%}
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

export const directoryPage = pageHead('Directory') + String.raw`
<main><div class="heading" id="content" tabindex="-1"><div><h1>Directory <span class="muted" id="count"></span></h1><p class="muted">Every company we are talking to, with the people we are in contact with. Read only; built from approved Telegram conversations. Our own team is on the <a href="/antseed-team">AntSeed team</a> page.</p></div></div>
<div id="notice" class="notice" role="alert"></div>
<label>Search<input id="search" type="search" placeholder="Company, person, email, @handle or website" autocomplete="off"></label>
<table class="outer"><thead><tr><th scope="col">Company</th><th scope="col">People we are in contact with</th></tr></thead><tbody id="rows"><tr><td colspan="2" class="muted">Loading…</td></tr></tbody></table></main>
<script>${commonScript}
const site=d=>link(/^https?:\/\//i.test(d)?d:'https://'+d,d.replace(/^https?:\/\//i,'').replace(/\/$/,''));
function peopleTable(co){const t=node('table','','people'),head=node('tr');for(const h of ['Website','Contact','Designation','Email','Telegram','Phone','Last contacted'])head.append(node('th',h));
 const thead=node('thead');thead.append(head);const body=node('tbody');t.append(thead,body);
 const websites=cell(...co.domains.map(site));websites.rowSpan=Math.max(co.people.length,1);
 if(!co.people.length){const r=node('tr');r.append(websites);const td=node('td','No contacts recorded yet','muted');td.colSpan=6;r.append(td);body.append(r);return t;}
 co.people.forEach((p,i)=>{const r=node('tr');if(!i)r.append(websites);
  r.append(cell(node('span',personName(p))),cell(...p.roles.map(x=>node('span',x))),...contactCells(p),cell(node('span',day(p.last_contacted))));body.append(r);});return t;}
function row(co){const r=node('tr'),name=node('td'),convo=node('ul',undefined,'convo');name.append(node('p',co.name,'name'));
 for(const c of co.conversations)convo.append(node('li',c.title+' · last message '+day(c.lastMessageAt)));name.append(convo);
 const people=node('td');people.append(peopleTable(co));r.append(name,people);return r;}
const paint=(shown,q)=>el('rows').replaceChildren(...(shown.length?shown.map(row):[emptyRow(2,q?'No match.':'No companies yet.')]));
start('/api/board/directory',co=>[co.name,...co.domains,...co.people.flatMap(p=>[...p.names,...p.usernames.map(u=>'@'+u),...p.emails,...p.phones,...p.roles])].join(' ').toLowerCase(),'companies');
</script></body></html>`;

export const teamPage = pageHead('AntSeed team') + String.raw`
<main><div class="heading" id="content" tabindex="-1"><div><h1>AntSeed team <span class="muted" id="count"></span></h1><p class="muted">Our own people, kept out of the company <a href="/directory">Directory</a>. Read only. Last active and companies come from approved Telegram conversations only.</p></div></div>
<div id="notice" class="notice" role="alert"></div>
<label>Search<input id="search" type="search" placeholder="Name, email, @handle or company" autocomplete="off"></label>
<table><thead><tr><th scope="col">Teammate</th><th scope="col">Designation</th><th scope="col">Email</th><th scope="col">Telegram</th><th scope="col">Phone</th><th scope="col">Last active</th><th scope="col">Working with</th></tr></thead><tbody id="rows"><tr><td colspan="7" class="muted">Loading…</td></tr></tbody></table></main>
<script>${commonScript}
function row(p){const r=node('tr'),name=node('td');name.append(node('span',personName(p)));r.append(name,cell(...p.roles.map(x=>node('span',x))),...contactCells(p),cell(node('span',day(p.last_active))),cell(...p.companies.map(c=>node('span',c))));return r;}
const paint=(shown,q)=>el('rows').replaceChildren(...(shown.length?shown.map(row):[emptyRow(7,q?'No match.':'No teammates found yet.')]));
start('/api/board/directory/team',p=>[...p.names,...p.usernames.map(u=>'@'+u),...p.emails,...p.phones,...p.roles,...p.companies].join(' ').toLowerCase(),'people');
</script></body></html>`;

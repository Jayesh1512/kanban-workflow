import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database, SqlExecutor } from '../shared/ports.js';
import { DomainError } from '../shared/api.js';
import { audit, type AccessControl, type Member, type Role } from './service.js';
import { brandFontLink, nativeTokens, topbarMarkup, topbarScript, topbarStyles } from '../board/page.js';

export type McpSurface = 'crm' | 'tasks' | 'admin';
export interface McpKey { id: string; surface: McpSurface; level: 'propose' | 'full' | 'read'; memberId: string }
export type Mailer = (message: { to: string; subject: string; text: string; html: string }) => Promise<'sent' | 'not_configured' | 'failed'>;

const keyPattern = /^ask_[A-Za-z0-9_-]{43}$/;
export const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;
const keyColumns = `k.id,k.member_id,k.surface,k.level,k.label,k.key_prefix,k.created_at,k.last_used_at,k.revoked_at,
  coalesce(nullif(m.display_name,''),split_part(m.email,'@',1)) AS member_name`;
const levels = { crm: ['propose', 'full'], tasks: ['full', 'read'], admin: ['full'] } as const;
const escape = (value: string) => value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** Paths that accept MCP keys, and the one surface each accepts. */
export const mcpSurfaceFor = (path: string): McpSurface | null => path === '/mcp' ? 'admin' : path === '/mcp/crm' ? 'crm' : path === '/mcp/tasks' ? 'tasks' : null;

/** One indexed lookup per request; last use is written at most once a minute. */
export async function authenticateMcpKey(db: Database, token: string, surface: McpSurface): Promise<{ member: Member; key: McpKey }> {
  if (!keyPattern.test(token)) throw new DomainError('unauthenticated', 'Invalid MCP key');
  const row = (await db.query(`SELECT k.id,k.surface,k.level,k.member_id,k.last_used_at,m.email,m.display_name,m.role,m.version,m.enabled
    FROM mcp_keys k JOIN workspace_members m ON m.id=k.member_id WHERE k.key_hash=$1 AND k.revoked_at IS NULL`, [hashSecret(token)])).rows[0];
  if (!row?.enabled) throw new DomainError('unauthenticated', 'This MCP key is revoked or its member is disabled');
  if (row.surface !== surface) throw new DomainError('forbidden', `This key belongs to the ${row.surface} connection`);
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at as string).getTime() > 60_000)
    await db.query("UPDATE mcp_keys SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<now()-interval '1 minute')", [row.id]);
  return { member: { id: String(row.member_id), email: String(row.email), display_name: String(row.display_name), role: row.role as Role, version: Number(row.version), enabled: true },
    key: { id: String(row.id), surface: row.surface as McpSurface, level: row.level as McpKey['level'], memberId: String(row.member_id) } };
}

/** Resend HTTP API; without a key the request stays visible in Approvals. Never logs addresses' secrets or tokens. */
export function resendMailer(apiKey: string | null | undefined, from: string, fetcher: typeof fetch = fetch): Mailer {
  return async message => {
    if (!apiKey) return 'not_configured';
    try {
      const response = await fetcher('https://api.resend.com/emails', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text, html: message.html }) });
      await response.body?.cancel();
      return response.ok ? 'sent' : 'failed';
    } catch { return 'failed'; }
  };
}

async function admin(tx: SqlExecutor, actor: Member) {
  const row = (await tx.query('SELECT role,enabled FROM workspace_members WHERE id=$1 FOR SHARE', [actor.id])).rows[0];
  if (!row?.enabled || row.role !== 'admin') throw new DomainError('forbidden', 'Administrator access is required');
}
async function insertKey(tx: SqlExecutor, actor: Member, memberId: string, surface: McpSurface, level: string, label: string) {
  const active = Number((await tx.query('SELECT count(*) AS n FROM mcp_keys WHERE member_id=$1 AND revoked_at IS NULL', [memberId])).rows[0]!.n);
  if (active >= 10) throw new DomainError('conflict', 'This member already has 10 active MCP keys. Revoke one first.');
  const key = secret('ask_');
  const row = (await tx.query(`INSERT INTO mcp_keys(member_id,surface,level,label,key_prefix,key_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)
    RETURNING id,member_id,surface,level,label,key_prefix,created_at,last_used_at,revoked_at`, [memberId, surface, level, label, key.slice(0, 12), hashSecret(key), actor.id])).rows[0]!;
  await audit(tx, actor, 'mcp_key.create', String(row.id), null, { memberId, surface, level, label, prefix: row.key_prefix });
  return { key, item: row };
}

/** Key management, elevated-access requests and the emailed admin approval page. */
export function registerMcpAccess(app: FastifyInstance, access: AccessControl, mailer: Mailer) {
  const db = access.db, base = access.config.appUrl;
  const endpoints = { crm: `${base}/mcp/crm`, tasks: `${base}/mcp/tasks`, admin: `${base}/mcp` };
  const idParams = z.object({ id: z.uuid() });

  app.get('/api/mcp-keys', async request => {
    const actor = access.user(request), all = actor.role === 'admin' && (request.query as Record<string, unknown>)['all'] === '1';
    const items = (await db.query(`SELECT ${keyColumns} FROM mcp_keys k JOIN workspace_members m ON m.id=k.member_id
      WHERE ($1 OR k.member_id=$2) AND k.revoked_at IS NULL ORDER BY k.created_at DESC LIMIT 200`, [all, actor.id])).rows;
    const adminGrant = actor.role !== 'admin' && !!(await db.query(`SELECT 1 FROM mcp_access_requests WHERE member_id=$1 AND requested_surface='admin'
      AND status='approved' AND issued_key_id IS NULL`, [actor.id])).rowCount;
    return { items, endpoints, emailConfigured: !!access.config.resendApiKey, canCreateAdminKey: actor.role === 'admin' || adminGrant };
  });

  app.post('/api/mcp-keys', async request => {
    const actor = access.user(request);
    const input = z.strictObject({ surface: z.enum(['crm', 'tasks', 'admin']), level: z.enum(['propose', 'full', 'read']).optional(), memberId: z.uuid().optional(), label: z.string().trim().max(100).default('') }).parse(request.body);
    return db.transaction(async tx => {
      if (actor.role === 'admin') {
        await admin(tx, actor);
        const level = input.level ?? levels[input.surface][0];
        if (!(levels[input.surface] as readonly string[]).includes(level)) throw new DomainError('validation', `A ${input.surface} key cannot have level ${level}`);
        const memberId = input.memberId ?? actor.id;
        if (!(await tx.query('SELECT 1 FROM workspace_members WHERE id=$1 AND enabled', [memberId])).rowCount) throw new DomainError('validation', 'Choose an active workspace member');
        return insertKey(tx, actor, memberId, input.surface, level, input.label);
      }
      // Members only ever create their own keys; elevated levels come from an approved request.
      if (input.memberId && input.memberId !== actor.id) throw new DomainError('forbidden', 'You can only create keys for yourself');
      const member = (await tx.query('SELECT enabled FROM workspace_members WHERE id=$1 FOR SHARE', [actor.id])).rows[0];
      if (!member?.enabled) throw new DomainError('forbidden', 'Your access is disabled');
      if (input.surface === 'crm') {
        if (input.level && input.level !== 'propose') throw new DomainError('forbidden', 'New CRM keys start at propose level. Request full access for approval.');
        return insertKey(tx, actor, actor.id, 'crm', 'propose', input.label);
      }
      if (input.surface === 'admin') {
        const grant = (await tx.query(`SELECT id FROM mcp_access_requests WHERE member_id=$1 AND requested_surface='admin' AND status='approved'
          AND issued_key_id IS NULL ORDER BY decided_at LIMIT 1 FOR UPDATE`, [actor.id])).rows[0];
        if (!grant) throw new DomainError('forbidden', 'Admin MCP access needs an approved request');
        const created = await insertKey(tx, actor, actor.id, 'admin', 'full', input.label);
        await tx.query('UPDATE mcp_access_requests SET issued_key_id=$2 WHERE id=$1', [grant.id, created.item.id]);
        return created;
      }
      throw new DomainError('forbidden', 'Only an administrator can create Tasks keys');
    });
  });

  app.patch('/api/mcp-keys/:id', async request => {
    const actor = access.user(request), id = idParams.parse(request.params).id;
    const input = z.strictObject({ level: z.enum(['propose', 'full']) }).parse(request.body);
    return db.transaction(async tx => {
      await admin(tx, actor);
      const before = (await tx.query("SELECT * FROM mcp_keys WHERE id=$1 AND revoked_at IS NULL AND surface='crm' FOR UPDATE", [id])).rows[0];
      if (!before) throw new DomainError('not_found', 'Active CRM key not found');
      const row = (await tx.query('UPDATE mcp_keys SET level=$2 WHERE id=$1 RETURNING id,member_id,surface,level,label,key_prefix,created_at,last_used_at,revoked_at', [id, input.level])).rows[0]!;
      await audit(tx, actor, 'mcp_key.level', id, { level: before.level }, { level: row.level });
      return row;
    });
  });

  app.delete('/api/mcp-keys/:id', async request => {
    const actor = access.user(request), id = idParams.parse(request.params).id;
    return db.transaction(async tx => {
      const before = (await tx.query('SELECT * FROM mcp_keys WHERE id=$1 AND revoked_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!before) throw new DomainError('not_found', 'Active MCP key not found');
      if (before.member_id !== actor.id) await admin(tx, actor);
      await tx.query('UPDATE mcp_keys SET revoked_at=now() WHERE id=$1', [id]);
      await audit(tx, actor, 'mcp_key.revoke', id, { surface: before.surface, level: before.level, prefix: before.key_prefix }, null);
      return { revoked: true };
    });
  });

  const requestColumns = `r.id,r.member_id,r.key_id,r.requested_surface,r.requested_level,r.reason,r.status,r.decided_at,r.email_state,r.expires_at,r.created_at,
    r.expires_at<now() AS expired,m.email AS member_email,m.role AS member_role,coalesce(nullif(m.display_name,''),split_part(m.email,'@',1)) AS member_name,k.key_prefix`;
  const requestFrom = 'mcp_access_requests r JOIN workspace_members m ON m.id=r.member_id LEFT JOIN mcp_keys k ON k.id=r.key_id';

  app.get('/api/mcp-requests', async request => {
    const actor = access.user(request), status = z.enum(['pending', 'approved', 'denied']).optional().parse((request.query as Record<string, unknown>)['status']);
    return { items: (await db.query(`SELECT ${requestColumns} FROM ${requestFrom} WHERE ($1 OR r.member_id=$2) AND ($3::text IS NULL OR r.status=$3)
      ORDER BY r.created_at DESC LIMIT 100`, [actor.role === 'admin', actor.id, status ?? null])).rows, emailConfigured: !!access.config.resendApiKey };
  });

  app.get('/api/mcp-requests/:id', async request => {
    const actor = access.user(request), id = idParams.parse(request.params).id;
    if (actor.role !== 'admin') throw new DomainError('forbidden', 'Administrator access is required');
    const row = (await db.query(`SELECT ${requestColumns} FROM ${requestFrom} WHERE r.id=$1`, [id])).rows[0];
    if (!row) throw new DomainError('not_found', 'Access request not found');
    return row;
  });

  app.post('/api/mcp-requests', async request => {
    const actor = access.user(request);
    if (actor.role === 'admin') throw new DomainError('conflict', 'Administrators can create or upgrade keys directly');
    const input = z.strictObject({ surface: z.enum(['crm', 'admin']), keyId: z.uuid().optional(), reason: z.string().trim().min(1).max(2000) }).parse(request.body);
    const token = secret('');
    const created = await db.transaction(async tx => {
      const member = (await tx.query('SELECT enabled FROM workspace_members WHERE id=$1 FOR SHARE', [actor.id])).rows[0];
      if (!member?.enabled) throw new DomainError('forbidden', 'Your access is disabled');
      if (input.surface === 'crm') {
        if (!input.keyId) throw new DomainError('validation', 'Choose the CRM key to upgrade');
        const key = (await tx.query("SELECT level FROM mcp_keys WHERE id=$1 AND member_id=$2 AND surface='crm' AND revoked_at IS NULL", [input.keyId, actor.id])).rows[0];
        if (!key) throw new DomainError('not_found', 'Your active CRM key was not found');
        if (key.level === 'full') throw new DomainError('conflict', 'This key already has full access');
      }
      // An unanswered expired request does not block a fresh one.
      await tx.query("UPDATE mcp_access_requests SET status='denied',decided_at=now() WHERE member_id=$1 AND requested_surface=$2 AND status='pending' AND expires_at<now()", [actor.id, input.surface]);
      if ((await tx.query("SELECT 1 FROM mcp_access_requests WHERE member_id=$1 AND requested_surface=$2 AND status='pending'", [actor.id, input.surface])).rowCount)
        throw new DomainError('conflict', 'You already have a pending request for this access');
      const row = (await tx.query(`INSERT INTO mcp_access_requests(member_id,key_id,requested_surface,reason,token_hash) VALUES($1,$2,$3,$4,$5) RETURNING id,expires_at`,
        [actor.id, input.surface === 'crm' ? input.keyId : null, input.surface, input.reason, hashSecret(token)])).rows[0]!;
      await audit(tx, actor, 'mcp_request.create', String(row.id), null, { surface: input.surface, keyId: input.keyId ?? null, reason: input.reason });
      return row;
    });
    const link = (action: string) => `${base}/mcp-approval?id=${created.id}&token=${token}&action=${action}`;
    const what = input.surface === 'crm' ? 'full CRM MCP access (direct edits and stage moves)' : 'Admin MCP access (every workspace tool)';
    const who = `${actor.display_name || actor.email} (${actor.email}, ${actor.role})`;
    const expires = new Date(created.expires_at as string).toUTCString();
    const email = access.config.adminEmail ? await mailer({ to: access.config.adminEmail, subject: `AntSeed MCP access request from ${actor.display_name || actor.email}`,
      text: `${who} requests ${what}.\n\nReason: ${input.reason}\n\nApprove: ${link('approve')}\nDeny: ${link('deny')}\n\nThe links expire ${expires} and need an admin sign-in.`,
      html: `<p>${escape(who)} requests <strong>${escape(what)}</strong>.</p><p>Reason: ${escape(input.reason)}</p><p><a href="${escape(link('approve'))}">Review and approve</a> · <a href="${escape(link('deny'))}">Deny</a></p><p>The links expire ${escape(expires)} and need an admin sign-in.</p>` }) : 'not_configured';
    await db.query('UPDATE mcp_access_requests SET email_state=$2 WHERE id=$1', [created.id, email]);
    return { id: created.id, status: 'pending', email };
  });

  app.post('/api/mcp-requests/:id/decision', async request => {
    const actor = access.user(request), id = idParams.parse(request.params).id;
    const input = z.strictObject({ action: z.enum(['approve', 'deny']), token: z.string().min(20).max(200).optional() }).parse(request.body);
    return db.transaction(async tx => {
      await admin(tx, actor);
      const row = (await tx.query('SELECT * FROM mcp_access_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row) throw new DomainError('not_found', 'Access request not found');
      if (input.token !== undefined && (row.token_used_at || row.token_hash !== hashSecret(input.token))) throw new DomainError('forbidden', 'This approval link is invalid or was already used');
      if (row.status !== 'pending') throw new DomainError('conflict', `This request was already ${row.status}`);
      if (new Date(row.expires_at as string).getTime() < Date.now()) throw new DomainError('conflict', 'This request expired. Ask the member to request access again.');
      if (input.action === 'approve' && row.requested_surface === 'crm') {
        const key = (await tx.query("UPDATE mcp_keys SET level='full' WHERE id=$1 AND member_id=$2 AND surface='crm' AND revoked_at IS NULL RETURNING id", [row.key_id, row.member_id])).rows[0];
        if (!key) throw new DomainError('conflict', 'The CRM key in this request was revoked');
      }
      const status = input.action === 'approve' ? 'approved' : 'denied';
      await tx.query(`UPDATE mcp_access_requests SET status=$2,decided_by=$3,decided_at=now(),token_used_at=CASE WHEN $4 THEN now() ELSE token_used_at END WHERE id=$1`,
        [id, status, actor.id, input.token !== undefined]);
      await audit(tx, actor, `mcp_request.${input.action}`, id, { status: 'pending' }, { status, surface: row.requested_surface, memberId: row.member_id, keyId: row.key_id });
      return { id, status, surface: row.requested_surface };
    });
  });

  app.get('/mcp-approval', async (_request, reply) => reply.type('text/html; charset=utf-8').send(approvalPage));
}

/** Emailed link target: an admin confirms with a same-origin POST; the token is single use. */
export const approvalPage = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP access request · AntSeed</title>${brandFontLink}<style>${nativeTokens}${topbarStyles}
*{box-sizing:border-box}body{margin:0;font:14px/1.55 var(--font-ui);color:var(--ink);background:var(--paper)}body>main>:not(.topbar):not(.skip){max-width:760px}h1#content{margin-top:28px}main{max-width:760px;margin:auto;padding:20px 24px 40px}h1{font-size:26px;letter-spacing:-.025em;margin:20px 0 8px}
article{border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:14px 0}dt{font-weight:600;color:var(--soft);font-size:12px}dd{margin:0 0 10px}button{font:inherit;font-weight:600;border:1px solid var(--line);border-radius:7px;min-height:42px;padding:9px 14px;cursor:pointer;background:var(--paper);color:var(--ink)}
.primary{background:var(--primary);border-color:var(--primary);color:var(--on-primary)}.danger{color:var(--danger);border-color:var(--dangerline)}.actions{display:flex;gap:8px;flex-wrap:wrap}#status{color:var(--soft)}#status[data-error=true]{color:var(--danger);font-weight:600}[hidden]{display:none!important}
</style></head><body><main>${topbarMarkup}<h1 id="content">MCP access request</h1><p id="status" role="status">Loading request…</p><article id="request" hidden><dl id="details"></dl><div class="actions"><button id="approve" class="primary" type="button">Approve access</button><button id="deny" class="danger" type="button">Deny</button></div></article></main>
<script>${topbarScript}
const q=new URLSearchParams(location.search),el=id=>document.getElementById(id),status=(m,e=false)=>{el('status').textContent=m;el('status').dataset.error=String(e);};
async function api(path,init){const r=await fetch(path,{cache:'no-store',...init});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error?.message||'Request failed');return b;}
async function decide(action){el('approve').disabled=el('deny').disabled=true;try{const r=await api('/api/mcp-requests/'+encodeURIComponent(q.get('id'))+'/decision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,token:q.get('token')})});status(r.status==='approved'?(r.surface==='crm'?'Approved. The CRM key now has full access.':'Approved. The member can now create their Admin MCP key from Connections.'):'Denied. Nothing was granted.');el('request').hidden=true;}catch(e){status(e.message,true);el('approve').disabled=el('deny').disabled=false;}}
(async()=>{try{const s=await api('/api/session');mountTopbar(s.member);const r=await api('/api/mcp-requests/'+encodeURIComponent(q.get('id')));const rows=[['Member',r.member_name+' · '+r.member_email+' · '+r.member_role],['Requested',r.requested_surface==='crm'?'Full CRM access for key '+(r.key_prefix||'')+'…':'Admin MCP connection'],['Reason',r.reason],['Requested at',new Date(r.created_at).toLocaleString()],['Expires',new Date(r.expires_at).toLocaleString()],['Status',r.expired&&r.status==='pending'?'expired':r.status]];
 el('details').replaceChildren(...rows.flatMap(([k,v])=>{const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=k;dd.textContent=v;return [dt,dd];}));el('request').hidden=false;
 if(r.status!=='pending'||r.expired){status('This request is '+(r.expired&&r.status==='pending'?'expired':r.status)+'. Nothing to decide.');el('approve').hidden=el('deny').hidden=true;}else status(q.get('action')==='deny'?'Confirm denial below.':'Review the request, then approve or deny.');
 el('approve').onclick=()=>decide('approve');el('deny').onclick=()=>decide('deny');}catch(e){status(e.message,true);}})();
</script></body></html>`;

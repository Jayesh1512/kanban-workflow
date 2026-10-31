import { initializeWorkOwner } from '../board/ownership.js';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database, RuntimeConfig, SqlExecutor } from '../shared/ports.js';
import { DomainError } from '../shared/api.js';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';

export const roles = ['admin','crm_manager','member','viewer'] as const;
export type Role = typeof roles[number];
export interface Member { id: string; email: string; display_name: string; role: Role; version: number; enabled: boolean }
export const canMoveCrm = (member: Member) => member.role === 'admin' || member.role === 'crm_manager';
export const canOwnTasks = (member: Member) => member.role !== 'viewer';
const identitySchema = z.object({ id: z.uuid(), email: z.email(), email_confirmed_at: z.string().nullable().optional() });
const sessionSchema = z.object({ access_token: z.string().min(1).max(20000), refresh_token: z.string().min(1).max(2000), expires_in: z.number().int().positive().max(86400) });
const memberColumns = 'id,email,display_name,role,enabled,version,telegram_user_id::text';
const cookieName = 'antseed_access', refreshName = 'antseed_refresh';
const cookies = (req: FastifyRequest) => Object.fromEntries((req.headers.cookie ?? '').split(';').map(s => s.trim().split(/=(.*)/s).slice(0,2)).filter(p => p.length === 2));

export async function audit(tx: SqlExecutor, actor: Member, action: string, resource: string, before: unknown, after: unknown) {
  await tx.query('INSERT INTO workspace_audit(actor_id,action,resource_id,before_value,after_value) VALUES($1,$2,$3,$4,$5)',
    [actor.id,action,resource,JSON.stringify(before),JSON.stringify(after)]);
}

/** Authentication comes from Supabase; roles and invitations come only from our DB. */
export class AccessControl {
  private readonly principals = new WeakMap<FastifyRequest, Member>();
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | null;
  constructor(readonly db: Database, readonly config: NonNullable<RuntimeConfig['access']>, private readonly fetcher: typeof fetch = fetch) {
    this.jwks = config.supabaseUrl ? createRemoteJWKSet(new URL(`${config.supabaseUrl.replace(/\/$/,'')}/auth/v1/.well-known/jwks.json`),{cacheMaxAge:600000,timeoutDuration:12000}) : null;
  }
  configured() { return !!(this.config.supabaseUrl && this.config.publishableKey); }
  user(request: FastifyRequest): Member {
    const member = this.principals.get(request);
    if (!member) throw new DomainError('unauthenticated','Sign in to continue');
    return member;
  }
  async auth(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!this.configured()) throw new DomainError('not_configured','Supabase sign-in is not configured yet');
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.supabaseUrl!.replace(/\/$/,'')}/auth/v1${path}`, {
        ...init, redirect:'error', headers: { apikey:this.config.publishableKey!, ...(init.body===undefined?{}:{'Content-Type':'application/json'}), ...init.headers }, signal:AbortSignal.timeout(12000),
      });
    } catch { throw new DomainError('upstream_unavailable','Sign-in service is unavailable. Try again shortly.',true); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) throw new DomainError('upstream_unavailable','Too many sign-in attempts. Wait a moment and try again.',true);
      if (response.status >= 500) throw new DomainError('upstream_unavailable','Sign-in service is unavailable. Try again shortly.',true);
      throw new DomainError('unauthenticated','Unable to sign in. Check your email and password, and confirm your email.');
    }
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new DomainError('upstream_unavailable','Sign-in service returned an invalid response',true); }
  }
  private setSession(reply: FastifyReply, raw: unknown) {
    const session = sessionSchema.parse(raw), secure = new URL(this.config.appUrl).protocol === 'https:' ? '; Secure' : '';
    reply.header('Set-Cookie', [
      `${cookieName}=${session.access_token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${session.expires_in}${secure}`,
      `${refreshName}=${session.refresh_token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`,
    ]);
    return session.access_token;
  }
  private clearSession(reply: FastifyReply) {
    const secure = new URL(this.config.appUrl).protocol === 'https:' ? '; Secure' : '';
    reply.header('Set-Cookie',[`${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,`${refreshName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`]);
  }
  async identify(token: string): Promise<Member> {
    const parsed = identitySchema.safeParse(await this.auth('/user',{headers:{Authorization:`Bearer ${token}`}}));
    if (!parsed.success || !parsed.data.email_confirmed_at) throw new DomainError('unauthenticated','Confirm your email before signing in');
    const identity = parsed.data, email = identity.email.toLowerCase();
    if (email === this.config.adminEmail && !(await this.db.query('SELECT 1 FROM workspace_members LIMIT 1')).rowCount) {
      const settings = await this.auth('/settings') as { mailer_autoconfirm?: boolean };
      if (settings.mailer_autoconfirm !== false) throw new DomainError('not_configured','Enable email confirmation in Supabase before setting up the administrator');
    }
    return this.db.transaction(async tx => {
      // Serialize bootstrap with role administration; no first-user-wins rule.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('workspace:members',0))");
      if (email === this.config.adminEmail) {
        await tx.query(`INSERT INTO workspace_members(email,role) SELECT $1,'admin'
          WHERE NOT EXISTS(SELECT 1 FROM workspace_members) ON CONFLICT(email) DO NOTHING`,[email]);
      }
      const row = (await tx.query(`SELECT ${memberColumns},auth_user_id FROM workspace_members WHERE email=$1 FOR UPDATE`,[email])).rows[0];
      if (!row?.enabled || (row.auth_user_id && row.auth_user_id !== identity.id)) throw new DomainError('forbidden','You do not have access to this workspace. Ask an administrator for an invitation.');
      if (!row.auth_user_id && (await tx.query('SELECT 1 FROM workspace_members WHERE auth_user_id=$1 AND id<>$2',[identity.id,row.id])).rowCount)
        throw new DomainError('forbidden','This account is already linked to another workspace membership');
      if (!row.auth_user_id) await tx.query('UPDATE workspace_members SET auth_user_id=$2,updated_at=now() WHERE id=$1',[row.id,identity.id]);
      if (email===this.config.adminEmail) await initializeWorkOwner(tx,String(row.id));
      return { id:String(row.id),email:String(row.email),display_name:String(row.display_name),role:row.role as Role,version:Number(row.version),enabled:true };
    });
  }
  private async authenticateToken(token: string): Promise<Member> {
    // Supabase recommends public-key validation for asymmetric JWTs. Normal
    // board requests don't consume the Auth /user endpoint's shared IP quota.
    if (token.split('.').length !== 3) return this.identify(token);
    let algorithm: string | undefined;
    try { algorithm=decodeProtectedHeader(token).alg; } catch { throw new DomainError('unauthenticated','Invalid session. Sign in again.'); }
    if (algorithm==='HS256') return this.identify(token); // Older Supabase projects.
    if (!this.jwks || !['ES256','RS256'].includes(algorithm??'')) throw new DomainError('unauthenticated','Invalid session. Sign in again.');
    let payload;
    try {
      payload=(await jwtVerify(token,this.jwks,{issuer:`${this.config.supabaseUrl!.replace(/\/$/,'')}/auth/v1`,audience:'authenticated',algorithms:['ES256','RS256']})).payload;
    } catch(error) {
      if (error instanceof TypeError || (error instanceof Error && error.name==='JWKSTimeout')) throw new DomainError('upstream_unavailable','Sign-in verification is unavailable. Try again shortly.',true);
      throw new DomainError('unauthenticated','Session expired or invalid. Sign in again.');
    }
    const identity=z.object({sub:z.uuid(),email:z.email()}).safeParse(payload);
    if (!identity.success) throw new DomainError('unauthenticated','Invalid session. Sign in again.');
    const row=(await this.db.query(`SELECT ${memberColumns} FROM workspace_members WHERE auth_user_id=$1 AND email=$2 AND enabled`,[identity.data.sub,identity.data.email.toLowerCase()])).rows[0];
    // First binding uses the Auth server's confirmed email, never JWT metadata.
    if (!row) return this.identify(token);
    return {id:String(row.id),email:String(row.email),display_name:String(row.display_name),role:row.role as Role,version:Number(row.version),enabled:true};
  }
  private sameOrigin(request: FastifyRequest) {
    const origin = request.headers.origin;
    // Confirmation links return from Supabase as cross-site document navigations.
    // The public sign-in page is safe to open; fetches and writes stay protected.
    if (!origin && ['GET','HEAD'].includes(request.method) && request.url.split('?')[0] === '/login'
      && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document') return;
    if ((origin && origin !== new URL(this.config.appUrl).origin) || request.headers['sec-fetch-site'] === 'cross-site')
      throw new DomainError('forbidden','Cross-origin requests are not allowed');
    if (!['GET','HEAD','OPTIONS'].includes(request.method) && !request.headers.authorization && request.headers.cookie && !origin && request.headers['sec-fetch-site'] !== 'same-origin')
      throw new DomainError('forbidden','Cookie-authenticated changes require a same-origin request');
  }
  async register(app: FastifyInstance) {
    app.addHook('preHandler', async (request,reply) => {
      const path = request.url.split('?')[0]!;
      reply.header('Cache-Control','no-store');
      this.sameOrigin(request);
      if (path.startsWith('/health/') || path === '/login' || path === '/auth/config' || path === '/auth/login' || path === '/auth/signup' || path === '/auth/logout') return;
      let token = request.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1] ?? cookies(request)[cookieName];
      const refresh = cookies(request)[refreshName];
      if (!token && refresh) token = this.setSession(reply,await this.auth('/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:refresh})}));
      if (!token) {
        if (request.method === 'GET' && !path.startsWith('/api/') && path !== '/mcp') return reply.redirect('/login');
        throw new DomainError('unauthenticated','Sign in to continue');
      }
      let member: Member;
      try { member = await this.authenticateToken(token); }
      catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'unauthenticated' || !refresh || request.headers.authorization) throw error;
        token = this.setSession(reply,await this.auth('/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:refresh})}));
        member = await this.identify(token);
      }
      this.principals.set(request,member);
      if (path === '/mcp' || path === '/connections' || path === '/api/status' || path.startsWith('/api/telegram/') || path.startsWith('/api/chats')) {
        if (member.role !== 'admin') throw new DomainError('forbidden','Administrator access is required');
      }
      if (path.startsWith('/api/workspace/')) {
        if (member.role !== 'admin') throw new DomainError('forbidden','Administrator access is required');
      }
      if (path === '/approvals' || path.startsWith('/api/board/approvals/') || path.startsWith('/api/outreach/proposals') || path.startsWith('/api/proposals')) {
        if (!canMoveCrm(member)) throw new DomainError('forbidden','CRM management permission is required');
      }
      if (['GET','HEAD'].includes(request.method) && /^\/api\/outreach\/relationships\/[^/]+$/.test(path)) {
        const id=z.uuid().parse(path.split('/').at(-1));
        if (!(await this.db.query('SELECT 1 FROM outreach_relationships WHERE id=$1 AND retained AND accepted_stage IS NOT NULL',[id])).rowCount)
          throw new DomainError('not_found','CRM relationship not found');
      }
      // Existing APIs remain protected even when a client bypasses our controls.
      if (!['GET','HEAD'].includes(request.method) && path.startsWith('/api/') && !path.startsWith('/api/board/') && !path.startsWith('/api/workspace/')) {
        if (!canMoveCrm(member)) throw new DomainError('forbidden','CRM management permission is required');
        if (path === '/api/outreach/mode' && member.role !== 'admin') throw new DomainError('forbidden','Administrator access is required');
      }
    });
    app.get('/auth/config',async () => ({configured:this.configured(),method:'password'}));
    app.post('/auth/login',async (request,reply) => {
      const input = z.strictObject({email:z.email().max(320),password:z.string().min(1).max(1024)}).parse(request.body);
      const session = sessionSchema.parse(await this.auth('/token?grant_type=password',{method:'POST',body:JSON.stringify(input)}));
      const member = await this.identify(session.access_token);
      this.setSession(reply,session);
      return {member};
    });
    app.post('/auth/signup',async request => {
      const input=z.strictObject({email:z.email().max(320),password:z.string().min(12).max(1024)}).parse(request.body),email=input.email.toLowerCase();
      const allowed=email===this.config.adminEmail || !!(await this.db.query('SELECT 1 FROM workspace_members WHERE email=$1 AND enabled',[email])).rowCount;
      // Do not disclose invitations through the public signup response.
      if (allowed) await this.auth(`/signup?redirect_to=${encodeURIComponent(new URL('/login',this.config.appUrl).href)}`,{method:'POST',body:JSON.stringify(input)});
      return {message:'If this address has workspace access, check your email to confirm your account. Then sign in.'};
    });
    app.post('/auth/logout',async (request,reply) => {
      const token=cookies(request)[cookieName];
      try { if(token) await this.auth('/logout',{method:'POST',headers:{Authorization:`Bearer ${token}`}}); }
      finally { this.clearSession(reply); }
      return {signedOut:true};
    });
    app.get('/api/session',async request => ({member:this.user(request),crmApproval:this.config.crmApproval}));
    app.get('/api/workspace/members',async () => ({items:(await this.db.query(`SELECT ${memberColumns} FROM workspace_members ORDER BY created_at,id`)).rows}));
    app.post('/api/workspace/members',async request => {
      const actor=this.user(request),input=z.strictObject({email:z.email().max(320).transform(e=>e.toLowerCase()),displayName:z.string().trim().max(200).default(''),role:z.enum(roles).default('member'),telegramUserId:z.string().regex(/^[1-9]\d{0,17}$/).nullable().default(null)}).parse(request.body);
      return this.db.transaction(async tx => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('workspace:members',0))");
        if(input.telegramUserId && (await tx.query('SELECT 1 FROM workspace_members WHERE telegram_user_id=$1',[input.telegramUserId])).rowCount)
          throw new DomainError('conflict','This Telegram identity is already linked to another member');
        const row=(await tx.query(`INSERT INTO workspace_members(email,display_name,role,telegram_user_id) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING RETURNING ${memberColumns}`,[input.email,input.displayName,input.role,input.telegramUserId])).rows[0];
        if(!row)throw new DomainError('conflict','This email already has a workspace invitation');
        await audit(tx,actor,'member.invite',String(row.id),null,row);return row;
      });
    });
    app.patch('/api/workspace/members/:id',async request => {
      const actor=this.user(request),id=z.object({id:z.uuid()}).parse(request.params).id;
      const input=z.strictObject({role:z.enum(roles),enabled:z.boolean(),expectedVersion:z.number().int().nonnegative(),telegramUserId:z.string().regex(/^[1-9]\d{0,17}$/).nullable().optional()}).parse(request.body);
      return this.db.transaction(async tx=>{
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('workspace:members',0))");
        const before=(await tx.query('SELECT * FROM workspace_members WHERE id=$1 FOR UPDATE',[id])).rows[0];
        if(!before)throw new DomainError('not_found','Member not found');
        if(Number(before.version)!==input.expectedVersion)throw new DomainError('conflict','Membership changed. Refresh and try again.');
        if(input.telegramUserId && (await tx.query('SELECT 1 FROM workspace_members WHERE telegram_user_id=$1 AND id<>$2',[input.telegramUserId,id])).rowCount)
          throw new DomainError('conflict','This Telegram identity is already linked to another member');
        if(before.role==='admin' && before.enabled && (input.role!=='admin'||!input.enabled) && Number((await tx.query("SELECT count(*) AS n FROM workspace_members WHERE role='admin' AND enabled")).rows[0]!.n)<=1)
          throw new DomainError('conflict','Keep at least one active administrator');
        const row=(await tx.query(`UPDATE workspace_members SET role=$2,enabled=$3,telegram_user_id=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING ${memberColumns}`,[id,input.role,input.enabled,input.telegramUserId===undefined?before.telegram_user_id:input.telegramUserId])).rows[0]!;
        await audit(tx,actor,'member.update',id,before,row);return row;
      });
    });
  }
}

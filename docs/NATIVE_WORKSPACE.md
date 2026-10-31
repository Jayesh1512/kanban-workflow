# Native workspace and access control

The built-in workspace replaces the running Vikunja board. PostgreSQL remains
the source of truth for CRM relationships, evidence, decisions and Work records.
Personal tasks are stored in `personal_tasks`. Generated Work stays in `tickets`,
with `owner_id` identifying its assignee; membership and immutable
actor history are stored in `workspace_members` and `workspace_audit`.

## Product behavior

- `/dashboard` is a shared CRM overview with team task totals. Cards open a
  detail panel; authorized humans can move CRM and Work records there.
- `/outreach` is the evidence and CRM board. Only admins and CRM managers can
  move a relationship. Human stage moves save atomically, record their actor,
  invalidate older suggestions and send no Telegram message.
- `/approvals` is private to admins and CRM managers. Unplaced CRM tickets never
  appear in the shared dashboard or accepted pipeline, and their normal detail
  URLs return 404 for everyone. Reviewers can inspect and place them here.
- AI suggestions remain pending and go to Telegram. Reviewers may approve or
  reject the same proposal in Approvals or reply to its exact Telegram control
  message using an enabled, linked identity. A web correction creates a separate
  pending proposal. Human movements send no Telegram message.
- Approvals also supports existing Work lane proposals; approval queues the
  native worker rather than claiming the lane already changed. Chat intake is
  metadata-only, admin-only in the tab and Telegram, and creates no Work ticket. All web decisions record
  the actor and reason; repeated or late Telegram decisions cannot apply twice.
- `/work` contains personal tasks, team tasks, and existing CRM Work records.
  Every card opens a detail panel with its stored business context and history.
  Admins and CRM managers can move shared Work tickets directly; other people
  read them. Personal tasks remain editable only by their owner. Task edits require the current version and the
  authenticated owner. Admin status does not grant ownership of another
  person's personal task.
- `/team` lets an admin grant access, choose roles, disable members, and link
  Telegram user IDs. Adding access does not send an invitation email.
- `/connections` and Telegram/account setup are admin-only.

Roles are `admin`, `crm_manager`, `member` and `viewer`. A viewer cannot create
or edit tasks. Ordinary members can maintain their own tasks but cannot change
CRM. All shared workspace pages require an enabled, invited account.

## Authentication

Supabase Auth provides email/password login. Magic links were considered, but
they cannot satisfy an unlimited-send requirement: Supabase's default email
provider limits sends and imposes user cooldowns. Password login does not send
an email on every sign-in. Signup confirmation still uses the project's email
provider; configure custom SMTP when inviting a broader team.

Copy `deploy/native-board/access.env.example` to the ignored
`.local/supabase/access.env`, fill it privately and set mode `0600`. It requires:

- `SUPABASE_URL`: the HTTPS Supabase project origin.
- `SUPABASE_PUBLISHABLE_KEY`: a publishable key or legacy anon key, never a
  service-role key.
- `WORKSPACE_ADMIN_EMAIL`: the exact initial administrator email.
- `APP_URL`: the browser's origin, including the external port. Use HTTPS for
  an externally hosted workspace.
- `CRM_APPROVAL=direct`: human movements are direct; AI suggestions still use
  Telegram approval.

Keep email confirmation enabled in Supabase. On first verified login, the
configured email is the only account eligible to bootstrap an empty workspace.
Telegram identities are linked explicitly in Access; an ingestion account is
not assumed to belong to the administrator. Other users must be added through
Access and then create/confirm their invited account. Subsequent
role changes come from the database, never from editable Auth user metadata.
Add `APP_URL/login` to Supabase Auth's allowed redirect URLs so signup
confirmation returns to the workspace. If the project's default redirect is
still used, confirmation can complete there and the user can return to the
workspace's sign-in page manually.

Sessions use HttpOnly, SameSite=Lax cookies and Secure cookies on an HTTPS
`APP_URL`. Cookie-authenticated writes require a same-origin request. Signed
Supabase ES256/RS256 tokens are checked against the project's public JWKS, with
issuer, audience and expiry checks; ordinary board requests do not spend the
Auth `/user` request quota. Initial account binding verifies the confirmed
identity with Supabase. Legacy HS256 projects use server verification.

All application tables have row-level security enabled without browser/Data API
policies. The trusted server database role owns the tables; the HTTP API enforces
roles and ownership. Direct anonymous Data API access is not an alternative to
the workspace API. Role revocation is checked on every request.

The legacy HTTP and MCP surfaces also require authentication. MCP and connection
administration require an admin identity. Existing unauthenticated Hermes clients
must supply a valid admin Supabase bearer token; there is no anonymous operator
exception and no human-movement MCP tool.

## Native API contract

All responses are uncached. Errors use the existing envelope
`{error:{code,message,retryable,requestId}}`; missing identity returns 401 and
missing permission returns 403. Ownership misses return 404. Optimistic version
or source revision conflicts return 409.

- `GET /auth/config`: sign-in availability and `method: password`.
- `POST /auth/login {email,password}`: verified session cookies and member.
- `POST /auth/signup {email,password}`: invited-account setup, minimum twelve
  password characters; the caller must confirm its email before signing in.
- `POST /auth/logout {}`: revoke the Auth session and clear cookies.
- `GET /api/session`: member and the human CRM approval mode.
- `GET /api/workspace/members`: admin-only membership list.
- `POST /api/workspace/members {email,displayName,role,telegramUserId?}`:
  admin-only access grant, without email delivery.
- `PATCH /api/workspace/members/:id
  {role,enabled,expectedVersion,telegramUserId?}`: admin-only role/access update.
  The final active administrator cannot be removed.
- `GET /api/board/tasks?scope=mine|team&limit=100&cursor=UUID`: one paginated
  feed of personal and source-eligible generated Work, filtered by actual owner
  for `mine`. Each row has `kind: personal|work`; Work opens its existing context
  panel and retains its original ID, source evidence and movement permissions.
- `GET /api/board/tasks/:id`: full personal task, owner name and the latest 100
  audit entries. Reading a teammate's task does not grant editing permission.
- `GET /api/board/crm/:id/detail`: accepted CRM relationship, company, source
  contributions, contacts, facts, evidence, actions, linked Work and activity.
  Unplaced CRM records remain private to Approvals. Pending proposal information
  is included only for admins and CRM managers; other readers see decided history.
- `GET /api/board/work?limit=50&cursor=UUID`: only active Work from approved,
  included sources. Legacy Work is shared without requiring new CRM placement.
- `GET /api/board/work/:id/detail`: active, approved Work context, company,
  contacts, blockers, dates, current evidence, facts, messages and activity.
  Suspended, excluded or no longer approved sources are rejected. Legacy Work
  remains inspectable without inventing an accepted CRM parent.
- `GET /api/board/work/:id/facts?limit=50&cursor=UUID`: more sourced facts.
- `GET /api/board/work/:id/messages?limit=50&cursor=MESSAGE_ID`: older stored,
  undeleted messages, newest IDs first. The next cursor is exclusive.
- `POST /api/board/work/:id/move
  {targetLane,expectedStageVersion,reason,idempotencyKey}`: admin/CRM-manager
  movement commits the lane, stage version, actor audit and stale-suggestion
  invalidation together. It sends no Telegram message and does not move a legacy
  remote board. Repeating the same key returns the saved result; changed input
  or stale versions return 409. Source admission, current mapping, parent CRM
  enrollment and role are checked again in the transaction.

Detail panels start with 50 facts and 50 messages, with controls to retrieve more.
Evidence is bounded at 200 excerpts and activity/proposal history at the latest
100 entries; the panel labels those limits. Raw credentials and unrelated system
records are outside these business-detail responses.

- `POST /api/board/tasks
  {title,description,lane,dueDate,idempotencyKey}`: create a task belonging to the
  caller. The creation key is a UUID; ownership cannot be supplied.
- `PATCH /api/board/tasks/:id
  {title,description,lane,dueDate,expectedVersion}`: owner-only update.
- `DELETE /api/board/tasks/:id {expectedVersion}`: owner-only deletion, audited.
- `POST /api/board/crm/:id/move
  {expectedEvidenceRevision,targetStage,idempotencyKey,reason}`: authorized human
  movement of an already accepted card with current source checks, actor audit,
  and no Telegram outbox.
- `GET /api/board/summary`: team task counts and approved CRM pipeline totals.
- `GET /api/board/approvals/placements|proposals|work|intake?limit=50&cursor=UUID`:
  private, paginated pending queues. Intake additionally requires admin.
- `GET /api/board/approvals/relationships/:id`: reviewer-only source detail.
- `POST /api/board/approvals/relationships/:id/place` uses the same body as a human
  CRM move and requires an unplaced card.
- `POST /api/board/approvals/proposals/:id/decision
  {action,reason,idempotencyKey,correctedStage?}`: CRM approval, rejection, or
  correction; source versions and manifest are checked before applying.
- `POST /api/board/approvals/work/:id/decision
  {action,reason,idempotencyKey}`: approve or reject an existing Work proposal.
- `POST /api/board/approvals/intake/:id/decision
  {action,reason,idempotencyKey}`: admin admission/rejection of the current pending
  intake request. The reason is limited to 500 characters.

The existing `/api/outreach/*` evidence/assessment/proposal APIs remain. Existing
Work records are available at `/api/tickets`. Source evidence and approvals are
preserved; personal task edits do not manufacture conversation evidence.

## Deployment and preservation

Append `compose.native.yaml` **after** the existing Supabase deployment overrides.
It uses a generic initialization image, copies the private Auth configuration
into the existing read-only runtime volume, removes the backend's Vikunja startup
dependency, and places the Vikunja service behind `legacy-vikunja`.

Before cutover:

```sh
node deploy/native-board/preflight.mjs --backup .local/native-board-backup-UNIQUE
```

Preflight verifies Auth configuration and the absence of unresolved remote board
requests, then makes a consistent PostgreSQL custom dump of both schemas using
the pinned PostgreSQL 17 client. Credentials are passed privately, not placed in
command arguments or printed. Restore-test the dump in an isolated database and
apply the additive native-workspace migration there before upgrading the live
backend. Do not run two backend workers against the same Telegram session.

Build a new backend image, run the native initializer against the original runtime
volume, then recreate only the current backend using all its retained overrides.
After readiness and authentication checks pass, stop the old Vikunja container.
Do not remove its volume or database schema as part of cutover.

The historical `vikunja` schema, numeric task IDs, source decisions and remote
journals are retained for audit and recovery. Unlinked legacy cards are not
silently recreated as current CRM relationships. This migration does not drop
the 44 upstream tables or discard old task history.

Once native writes have occurred, the old board is a historical replica. Do not
restart an older application binary or restore a pre-cutover dump over newer
business activity. Any return to a legacy board requires reconciling the current
accepted state and retaining the complete migration ledger.

## Verification

`tests/board/workspace.test.ts` exercises the real HTTP Auth boundary against
synthetic local responses, an isolated PostgreSQL engine, permissions, ownership,
stale writes, human versus AI movement, Telegram identities and public-key JWTs.
It does not send real email or contact Telegram/AI providers. Hosted Auth settings
and backup restoration are checked separately before live rollout.

Generated-task ownership is configured in `workspace:default-work-owner`. The
initial administrator initializes it once; cutover assigns only unowned Work
and audits each assignment. Existing assignments are preserved. The database
default covers every generated-ticket insertion path. Ownership never enrolls
an excluded source or approves an unplaced CRM relationship.

For an existing workspace, back up the database, build the updated image, stop
the backend, then initialize ownership before recreating it:

```sh
docker compose stop backend
docker compose run --rm --no-deps -T --entrypoint node backend --input-type=module < deploy/native-board/initialize-work-owner.mjs
docker compose up -d --no-deps backend
```

The command applies checksum-validated migrations, uses the configured initial
administrator, audits only newly assigned rows, and prints assignment/visibility
counts. It is safe to repeat and requires no fresh browser login. Existing
assignments are never overwritten. The owner-default function captures the
migration schema's search path, including for inserts outside the app pool.

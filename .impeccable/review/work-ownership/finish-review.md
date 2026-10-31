disposition: fix

Scope: Work ownership/routing and its tiny My tasks binding only. Role: Impeccable finish reviewer, run inline (no subagents, no browser, no DB/login/email/AI/Telegram, no source edits).
Read: migration `202610300001_work_task_ownership.sql`, `src/board/{ownership,work-visibility,routes,ticket-details,detail-panel,page}.ts`, `src/access/service.ts`, `src/platform/database.ts` (search_path), the ownership test in `tests/board/workspace.test.ts`, `docs/NATIVE_WORKSPACE.md`, both captures.
Unread: full `tests/board` suite (not re-run), `browser-checks.json` taken as reported.
Not applicable: comp/QUALITY BAR/direction contract. This is an incumbent Operate extension with no redesign. Fidelity/ceiling rows are reduced to "incumbent preserved".

## recapture check (check 0)
Passed. `desktop-my-tasks.png` (1280, Ravi Admin, 4/3/2/2/0/0 lane counts, 10 Work + 1 personal) and `mobile-my-tasks.png` (390) are valid: not blank, document top visible, content matches the filename. `browser-checks.json` agrees.

## persistence
Pass. Incumbent tokens, `.task`/`.badge`/`.meta` classes and the existing detail panel are reused. No new controls. Viewer path unchanged. DESIGN.md extension is Root's job.

## fidelity (data ownership and routing)
- Migration additive, nullable FK, preserves IDs/history/evidence: match.
- Backfill only `owner_id IS NULL`, never overwrites other owners, idempotent (second call returns 0), audit row per assigned ticket: match. Audit `resource_id` is uuid and is fed uuids; the immutable trigger is untouched.
- Feed union filters owner and applies the UUID cursor before `LIMIT`; cursor is last returned id (`rows[limit-1]`); ordering is consistent across both sources: match.
- `visibleWorkSql` is shared with `/api/board/work`, so approved-source/current-parent eligibility and excluded/suspended hiding are identical. `/api/board/work` was already readable by every authenticated role, so team scope adds no new exposure: match.
- Card routing: `kind==='work'` → `work` detail endpoint, otherwise `personal`. Newly created personal rows have no `kind` and fall to personal. Correct.
- Write authority: `PATCH/DELETE /api/board/tasks/:id` still query `personal_tasks AND owner_id` only; the panel's Work lane move still uses `canManage()`. Ownership grants no CRM write power: match.
- Pending-CRM privacy: `/api/board/approvals/*` gating and the unplaced-relationship guard are untouched: match.

## ceiling
Incumbent preserved. Nothing was asked for beyond the Work badge, "You" and Owner field.

## material_fixes
1. **Cutover init has no committed, repeatable path, and the live session never reaches the helper.** `initializeWorkOwner` runs only inside `identify()`. Ravi's existing ES256/RS256 JWT takes the `authenticateToken` fast path (`row` found, early return), so it never calls `identify`. The repo has no script, startup hook, or preflight step that sets `workspace:default-work-owner` (grep of deploy/, docs, README finds only the doc sentence). If the "explicit initialize" step is done by hand or skipped, Ravi's My tasks stays at 0 Work until a fresh login, which is the reported bug. Fix: call `initializeWorkOwner` (idempotent) once at startup/`ready` for the enabled member whose email equals the configured admin, or commit a one-shot cutover script. Either way make the post-deploy check explicit: `count(*) FROM tickets WHERE owner_id IS NULL` is 0, and the `work.assign` audit count equals the backfilled count (27 active + 2 suspended expected, if all were unowned).
2. **Default function is not schema-safe for production (`antseed` schema, search_path set per connection in `src/platform/database.ts:49`).** `workspace_default_work_owner()` references unqualified `workspace_members`/`app_settings` and no `SET search_path`. The default expression runs with the inserting session's search_path. Any non-app session that inserts into `antseed.tickets` without `antseed` first on its path (SQL editor, ad-hoc psql, MCP SQL tool) gets "relation does not exist" and the INSERT fails. All six in-repo insert paths go through the app pool, so the app is safe. Fix: add `SET search_path FROM CURRENT` to the function (one clause; the migration runner already sets the antseed path), or schema-qualify the two tables. The migration is not yet applied to production, so this costs nothing now.

Non-blocking notes (not fixes):
- `ADD COLUMN … DEFAULT <stable fn>` evaluates the function once at ALTER time for existing rows. If the setting row ever exists before this migration (for example a restore test that carries `app_settings` across), existing tickets are silently owned with no `work.assign` audit. The planned order (migrate, then initialize) is correct; keep it and state it in the runbook.
- `/api/board/summary` "Active tasks/Overdue" use a weaker predicate than the feed (no `creation_proposal_id`/relationship-eligibility clause), so the Overview number can exceed what My tasks lists when proposal-created tickets are ineligible. Pre-existing and out of scope; mention if the numbers are compared during verification.
- The My tasks notice says "or move it to another swimlane". For plain members the Work cards are read-only (the panel says so). Copy only; skip unless wording is touched.

## keep
Owner as pure data (no write authority), the shared `visibleWorkSql` predicate, owner and cursor filtering before `LIMIT`, `kind`-driven detail routing, and the unchanged personal-owner-only edits and viewer read-only behavior.

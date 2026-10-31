disposition: ship

Scope: B1/B2 re-verdict only. Read-only, inline (no subagents, browser, DB, deploy or source edits).
Read: `deploy/native-board/initialize-work-owner.mjs`, `db/migrations/202610300001_work_task_ownership.sql`, `src/board/ownership.ts`, `src/platform/{config,database}.ts` (config loading, `onConnect` search_path, `migrate`), `docs/NATIVE_WORKSPACE.md` cutover section, `Dockerfile`, `compose.native.yaml`, `.local/native-board/ownership-{tests,schema-verification}.log`.
Not re-run: the test suite and the PG17 check. I took the logs as reported; the 37-pass tail and the `default_works_outside_app_schema = t` result are both present in them.

## B1 — cutover initialization: RESOLVED
- The committed script is `deploy/native-board/initialize-work-owner.mjs`. It imports only the built `dist` config, database, ownership and visibility modules. It starts no backend or Telegram worker, and `--no-deps` plus the stopped backend avoids a second worker.
- The sequence is correct: `migrate` (checksum-validated, so DDL runs before the setting exists and the `ADD COLUMN` default evaluates to NULL), then one transaction.
  - It selects the enabled admin member whose email matches `WORKSPACE_ADMIN_EMAIL`.
  - `initializeWorkOwner` writes the setting with `ON CONFLICT DO NOTHING` and `FOR UPDATE`. It backfills only `owner_id IS NULL` and audits each id.
  - It aborts and rolls back if a different default owner is already configured.
  - It aborts if any NULL owner remains. It prints assigned, total, owned, unassigned, visible and audited counts.
- The command needs no fresh login. The existing JWT path never has to call `identify`, because the setting and rows are already written before the new backend boots. That removes the original cause of the empty My tasks.
- Docs give the concrete order: stop backend, run the script, `up -d --no-deps backend`. They tell the operator to back up and build first. The build gives the `/app/dist` and `db/migrations` the script imports, and the script resolves `dist` against the container's `/app` WORKDIR.
- Config note: `ACCESS_ENV_PATH` is set in the backend service, so `adminEmail` resolves under `docker compose run`. If it were missing, the script fails loudly before any write.
- Residual (non-blocking): the script body's SQL is not covered by the suite. The suite tests `initializeWorkOwner` directly, including the second call returning 0. Any typo would fail inside the transaction and roll back, before the new backend boots. Treat the first root run as the verification and check the printed line.
  - Expected first run: `unassigned: 0`, `assigned` = number of previously unowned tickets (29 expected), `owned` = `total`, `auditedAssignments` = `assigned`, `visible` = 27 (the 2 suspended are hidden).
  - On a repeat run `assigned` is 0 and `auditedAssignments` stays at the earlier count.

## B2 — function search_path: RESOLVED
- The migration has `SET search_path FROM CURRENT`, and the function is unapplied to production. `migrate` runs on a pool whose `onConnect` sets `"antseed", public`, so the captured path is the app schema.
- The PG17 log shows an invoker with `search_path = public` inserting into `antseed.tickets`. The default resolved, with `default_works_outside_app_schema = t`.
- The board test covers the invoker path and the Ravi owner, per your report. The 37-pass tail is in `ownership-tests.log`.

## ship / fix scope
Ship, with no further code fixes. Operational gate: back up, build, stop backend, run the script, read the counts above, then start the backend. The earlier non-blocking notes stand unchanged (overview count weaker than the feed, "move it" notice copy for plain members). Neither blocks this release.

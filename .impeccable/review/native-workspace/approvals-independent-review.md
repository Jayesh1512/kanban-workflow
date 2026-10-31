# Approvals — independent Impeccable finish review

Reviewer: fresh review sub-agent (not the author). Read-only: no code edits, no decisions submitted, no migrations/deploys/email/AI/Telegram. Synthetic server only (`http://localhost:19490`, incognito agent-owned preview tab, synthetic `manager@`/`ravi@`/`viewer@` sessions). No real Supabase sign-in.

Scope reviewed: current source of `src/board/page.ts`, `src/board/approvals.ts`, `src/board/routes.ts`, `src/access/service.ts`, `src/outreach/{service,repository,page}.ts`, `src/workflow/proposals.ts`, `src/telegram/{store,intake}.ts`, `src/board/native-workflow.ts`, `tests/board/*`; Operate mode against incumbent PRODUCT/DESIGN. Existing evidence PNGs `desktop-approvals-placement.png`, `desktop-approvals-suggestion.png` read.

## Verdict: FIX (two small items), then ship

Backend privacy, permissions, idempotency and Telegram/web correlation are sound. Two small UI/copy defects must be fixed before ship. Neither needs a redesign or a re-review of the backend.

## Blockers (fix before ship)

### B1. Mobile queue tabs are unreadable: labels and counts overlap or clip
- `src/board/page.ts:47` (`@media(max-width:700px)` → `.seg button{flex:1;min-width:0}`) combined with `:37` (`.seg.scroll button{white-space:nowrap}`).
- Evidence at 375×800, manager session (screenshot `/Users/jys/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mvtxqnxu-680f3dc9.png`): "Initial placement" text runs into "CRM changes", and the pending counts for the first two tabs are cut off ("C|RM", "(" fragments). Measured: button width 116px, scrollWidth 139px and 120px.
- Admin has a fourth tab ("Chat intake"). Measured 88px per button, with 3 of 4 clipped (scrollWidth 139, 120, 104).
- Why it is a blocker: the counts are the main signal of "what is waiting" on this new surface. On a phone they are unreadable, and the `.scroll` class's intended horizontal scroll never engages because `min-width:0` plus `flex:1` shrinks the buttons.
- Fix: inside the 700px query, `.seg.scroll button{flex:0 0 auto;min-width:max-content}`. Then `.seg.scroll` scrolls horizontally, or the buttons wrap onto two rows.
- Recheck: 375px as manager (3 tabs) and as admin (4 tabs), counts visible, no page-level horizontal overflow. The document width was 375 with no page overflow, so the damage is confined to the strip.

### B2. Contradictory copy inside the Approvals source context
- `src/outreach/repository.ts:221` builds `limits`. The native `get()` override (`src/outreach/service.ts`) nulls `publication` but leaves `limits` alone. `loadContext` (`src/board/page.ts:224`) prints these lines verbatim.
- Evidence, live, expanded Basalt Compute placement card: directly under "Saves immediately and moves this card onto the CRM board. No Telegram message is sent." the context says "Data changes and card movements require approval via the matching Telegram control message."
- This is the exact Telegram-vs-tab confusion the feature exists to remove. It states the opposite of the page's own label for the placement action and the direct manager-move action.
- Fix: in native mode, replace that limit with something like "Data changes and AI suggestions are decided in Approvals or by replying in Telegram; managers move accepted cards directly." Or drop the line from the native context (`this.nativeBoard` in `get`). Test it by asserting the native `get().limits` has no "matching Telegram control message".

## Non-blocking issues (fix soon, not ship-stoppers)

1. **Placement card can hide its pending AI suggestion past 50 proposals.** `src/board/page.ts:179,185,225-230,250`. Proposals load as `limit=50` ordered by random UUID `p.id` (`src/board/approvals.ts:38-41`). A placement card only shows the suggestion if that proposal is in the loaded page. Otherwise it shows "Needs a stage" plus "Place on CRM board", and placing then marks the pending suggestion stale (`src/outreach/service.ts:76`), which breaks "AI suggestions remain pending until decided". Mitigated only by a "Load more suggestions" button at the bottom of the tab. Safer fix: auto-page proposals to exhaustion on the Placement tab, or make the placements endpoint return the pending stage proposal per relationship. The mirror case: stage proposals for unplaced relationships beyond the first 100 placements appear under "CRM changes" with "Current stage: No stage". Realistic only with a large backlog. Not exercised here.
2. **Full re-render drops focus, open cards and typed reasons.** `renderQueue()` replaces all children (`:245`). It runs after Refresh, Load more, tab switches, and the 409/404 recovery path (`:203` → `loadStore(...,true)`). Confirmations are also lost. After "Suggest a different stage" (`:211`), `loadStore('proposals',true)` rebuilds the queue and destroys the focused "Replacement suggestion created…" paragraph, so focus falls to `<body>`. After 409/404 recovery, focus is also lost (the notice is `role=alert`, which helps). Suggest keeping a focus target (the queue heading or the first card summary) after re-render, and not rebuilding unchanged cards.
3. **Silent drop of a refresh.** `loadStore` returns immediately if a load is already in flight (`:189`). A post-409 refresh issued during "Load more" is discarded, so the stale card stays. Also Refresh gives no in-progress feedback: the skeleton only appears after the request ends (`q.loaded=false` is set but `renderQueue` is called only in `finally`). Disable Refresh and render skeletons first.
4. **`aria-live="polite"` on the whole `#queue`** (`:77`). Every tab switch or reload replaces the entire subtree, so screen readers may announce the full queue. Prefer a small dedicated status region for the "done"/error messages and no live region on the list.
5. **`/api/board/approvals/proposals` over-fetches** (`src/board/approvals.ts:38`): `SELECT p.*` returns `context` (whole snapshot), `command_hash`, `idempotency_key`, `manifest`. Reviewer-only so not a leak, but 50 rows with real evidence snapshots could be large (3 synthetic rows ≈ 8 KB). Use an explicit column list. The UI uses about 12 fields.
6. **Reviewer-only count visible to everyone via the API:** `/api/board/summary` and `/api/outreach/status` return `pendingApprovals`/`pending_proposals` to viewers (UI hides it, API does not; synthetic viewer got 200). Counts only, no card content, and `awaitingPlacement` correctly excludes unplaced (0 for viewer). Acceptable; note it if "do not display" is meant strictly.
7. **Work tickets for unplaced relationships are visible through `/api/tickets`** (dashboard "CRM Work (read-only)" scope). Synthetic viewer saw tickets with "Synthetic summary for Basalt Compute / Northfield Models / Pinewood Research", all of which were in the manager's placement queue at some point. These are Work records, a separate object from CRM cards, so this follows the established scope and the earlier r1/r2 approvals. Root should confirm this is intended: "do not display the tickets to anyone" could be read to include them.
8. **Reviewers get no pending indicator outside `/approvals`.** The topbar link shows no count. The dashboard KPI "Pending approvals" is plain text, not a link. Low-cost improvement: link the KPI to `/approvals`.
9. **A member opening `/approvals` directly gets raw JSON 403** (`src/access/service.ts`, the `path === '/approvals'` gate fires before the page). The client-side redirect in `start()` never runs. Fine as a guard, but a redirect to `/dashboard` for non-managers would be friendlier.
10. **Non-admin Telegram intake replies are consumed silently** (`src/telegram/intake.ts:33` returns inside the transaction, then `handle` returns `true`). Safe; the user gets no feedback. Same for non-linked managers on proposals (`handleControlReply`, `module.ts`). Acceptable.

## Verified OK

- **Privacy / permissions, live as viewer:** `/api/board/approvals/placements`, `/proposals` and `/api/outreach/proposals` return 403; `/approvals` returns 403; `/api/outreach/relationships` has only accepted cards.
- **Guessed URLs, by code and test:** `GET /api/outreach/relationships/:id` is gated by `accepted_stage IS NOT NULL` (`access/service.ts:149`). A malformed or encoded id fails closed at `z.uuid()`. The private detail route is reviewer-only. The test at `tests/board/workspace.test.ts:76` covers all four roles plus pagination.
- **Contracts:** placement/proposal/work/intake endpoints and the `page.ts` calls match (fields `action/reason/idempotencyKey`, `correctedStage`, `targetStage/expectedEvidenceRevision/reason`). Cursor paging (`id > $cursor ORDER BY id LIMIT n+1`, `nextCursor = rows[limit-1].id`) is correct for all four feeds.
- **Roles:** `canMoveCrm` gate on all `/api/board/approvals/*`; admin-only gate on intake. Each decision re-checks live `workspace_members` role and `enabled` inside the transaction (`FOR SHARE`). A downgraded or disabled manager cannot decide with a stale session.
- **Normal move vs initial place:** `/api/board/crm/:id/move` requires an accepted card; the private place endpoint requires unplaced (409 `CRM placement changed`); the test confirms the bypass attempt returns 409.
- **Web and Telegram share rows and locks:** `applyDecision` takes the same advisory + relationship + proposal-row locks. A late Telegram reply after a web decision leaves one decision row; a stale `old` decision with a different command hash returns 409. Telegram needs a linked, enabled admin or CRM manager in native mode.
- **Corrections** create a separate pending replacement and apply nothing (`applyDecision` correct branch; UI copy says so; the UI offers correct only for stage kinds, and the backend rejects it for data/Work).
- **Native Work:** web approval returns queued, and `NativeProposalWorkflow.applyNext` applies later under the ticket lock with a stale check. UI wording matches ("Queued; the board applies the lane change shortly.").
- **UI labels:** every pending item reads "Pending approval · not applied" with the origin ("AI suggestion" / "Requested by a person"). The placement action says "Saves immediately … No Telegram message is sent." Resolved cards show a focused status paragraph (`resolved()`, `tabIndex=-1` + `.focus()`).
- **Idempotency in the UI:** `decideBlock` reuses one key per action across retries and regenerates it after a 409/404; `decideBlockPlace` regenerates the key whenever the stage or reason changes.
- **Task placement / previous fixes:** the one-shot `openId` clearing from r2 is intact (`page.ts:138`). Personal task ownership code paths are unchanged. The shared nav shows "Approvals" only for admin and CRM manager, and "Access" and "Connections" only for admin.
- **Desktop (1280):** the screenshots and live view are clean; incumbent Operate styles are reused; no stray redesign.
- **Layout:** no page-level horizontal overflow at 375px (document width 375). Touch targets 42px for controls; the placement card, selects and buttons are well sized.
- **Lazy private context:** `loadContext` fires once per card on first open, shows loading, and has an error path with Retry. It calls the reviewer-only endpoint.

## Verification limits

- No decision was submitted (shared synthetic server, no mutation allowed), so keyboard/focus after approve/reject/place/correct was verified by code only; the `correct` and 409 focus loss in item 2 is from reading `resolved()`, `renderQueue()` and `loadStore()`, not a browser reproduction.
- The synthetic data changed while I was reviewing (queue counts differed from the author's PNGs), so I did not compare counts to the existing screenshots.
- Not tested: dark mode on `/approvals` (same tokens as the incumbent), screen reader behavior, large-backlog pagination (items 1 and 5 from code), real Supabase, real Telegram, and the full regression run (the root's; I did not run it).
- Mobile nav scroll clipping of "Connections", the CRM KPI gradient and the lack of drag/drop are the existing residuals; they were not re-evaluated.
- No material source change was observed during the review that would require rechecking the backend findings. After B1/B2 are fixed, recheck only B1 at 375px (manager + admin) and the B2 string in the expanded placement card.

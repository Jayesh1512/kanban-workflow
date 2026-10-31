---
version: 1
slug: "src-board-page-ts"
primary_target: "src/board/page.ts"
related_targets: ["src/outreach/page.ts"]
---

# Native workspace boards

Mode: Operate. Extend the existing AntSeed board system; preserve the established five CRM stages, six Work lanes, compact system typography, green interaction accent, neutral columns, inline disclosures, and mobile horizontal scrolling.

## Direction contract
THESIS: One shared view of CRM and team work, with personal ownership visible and editing permissions enforced by the server.
OWN-WORLD: Inherit DESIGN.md and the production outreach board. Flat green/neutral surfaces, 12px card corners, 42px controls, clear focus outlines.
STORY: Sign in, read the common overview, maintain your own tasks, or manage CRM if authorized. Admins invite members and assign roles.
FIRST VIEWPORT: Compact workspace navigation, a single page title, a status line, search and scope controls, then the six-lane task board. New task opens an inline form. The dashboard uses a compact summary row above the five-stage read-only CRM board.
FORM: Precisely scoped extension of the incumbent board; no new visual world or concept tournament. Seed: incumbent-extension.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Constraints: no decorative imagery; no silent changes to accepted CRM stages; authorized human moves apply directly without Telegram messages; AI suggestions require review in Telegram. Members edit only their own tasks. Viewer accounts are read-only. Initial administrator is configured privately.

## Build record (native workspace)

Built: `/login` (password sign-in, invited sign-up), `/dashboard` (read-only: compact summary, CRM pipeline and Team tasks views), `/work` (My tasks, Team tasks read-only for others, CRM Work read-only), `/team` (admin: members, roles, Telegram user ID, invite), native `/outreach` (role-aware CRM with direct "Move now"). Shared top bar and tokens live in `src/board/page.ts`; `src/outreach/page.ts` imports them for native mode only, and the legacy page is unchanged.

Rules held: no magic-link promise; human CRM moves say no Telegram message is sent; AI suggestions are only ever "Awaiting Telegram review · not applied"; members edit only their own tasks, admins included; viewers see no write controls.

Review: `.impeccable/review/native-workspace/` (finish-review.md, documentation-review.md, browser-checks.json, desktop and mobile captures). Preview server: `npx tsx tests/board/ui-preview.ts` (synthetic only, port 19490).

## Build record (work ownership extension)

Fixed: Ravi's My tasks was empty because generated Work tickets had no owner. Adds `tickets.owner_id`, a DB default set to the configured initial owner, and an audited idempotent backfill that touches only unowned rows. `scope=mine|team` now unions personal tasks with source-eligible assigned Work. Rows carry `kind` (`personal|work`) so Work opens the existing context panel and personal tasks open the personal panel. An Owner label shows on Work rows.

Held: no new visual world, tokens, components or layout. CRM movement roles and source-approval restrictions unchanged. Root DESIGN.md, PRODUCT.md and design.json untouched.

Review: `.impeccable/review/work-ownership/` (documentation-review.md, browser-checks.json, desktop and mobile My tasks captures; synthetic data). Live backfill not yet applied: 29 Work rows verified, 27 active and 2 suspended.

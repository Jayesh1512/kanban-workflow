# Ticket detail panel documentation review

Disposition: scoped extension of the incumbent native workspace. The user chose a large shared detail panel and retained Jayesh's Viewer role. No new visual world, brand identity, product raster asset, or global token set was introduced.

## Intentional scope

`src/board/detail-panel.ts` supplies one native modal dialog for personal tasks, shared CRM Work tickets, and CRM relationships, reused by Overview, Work, and native CRM. Board cards open the panel; source groups, record identifiers, task editing, and suggestion history retain native disclosure inside it. This intentionally extends the earlier surface brief's inline inspection model for these ticket entry points. It does not replace the historical snapshot's inline disclosure or board layout.

The dialog inherits native `--ink`, `--soft`, `--paper`, `--line`, `--accent`, and `--tint`. It keeps flat borders, the existing 12px corners, system sans, 42px controls, 12px supporting labels, and 3px focus outlines. Desktop uses a bounded 960px panel, 90dvh maximum height, a sticky header, and three metadata columns. At 700px and below it fills the viewport, uses 16px horizontal insets, and reduces metadata to two columns. These are local panel rules, not replacements for the board's 650px breakpoint. The header's shrinking heading container (`min-width:0; flex:1`) reserves room for the fixed-size Close button when titles wrap.

The panel preserves source identity, explicit missing values, contacts, company context, blockers, linked CRM/Work records, source evidence, current facts, original messages, and recorded activity. Work facts and messages load further pages on request. Evidence excerpts and activity/proposal history remain bounded and disclose their limits. User-supplied email reports are labelled rather than presented as authenticated mailbox data. Loading, retry, conflict reload, and save status are local to the panel.

Shared CRM/Work direct moves are available only to Admin and CRM manager roles. Personal task changes require a non-viewer task owner, including for admins. These boundaries are visible in read-only copy and enforced by the server. Pending proposal details are returned only to authorized reviewers; decided history can remain inspectable. No account-role change is part of this extension.

## Evidence checked

- Product/system context: `PRODUCT.md`, `DESIGN.md`, `.impeccable/design.json`, and `.impeccable/surfaces/src-board-page-ts.md`.
- Built source: `src/board/detail-panel.ts`, `src/board/ticket-details.ts`, shared tokens and ticket integration in `src/board/page.ts` and `src/outreach/page.ts`, ownership checks in `src/board/routes.ts`, and role/access checks in `src/access/service.ts`.
- Existing QA: `browser-checks.json` reports manager CRM/Work moves and refreshed details, personal owner moves, retry, Escape/focus restoration, mobile viewer inspection, and no uncaught browser errors. This pass inspected that record; it did not rerun a browser.
- Captures visually inspected: `desktop-crm.png`, `desktop-work.png`, `desktop-personal.png`, `mobile-work-viewer.png`, and `mobile-crm-viewer.png`. These are synthetic preview evidence, not evidence of production data or real user actions. The Work mobile capture shows the wrapped heading and visible Close control. The final CRM mobile recapture also shows Close fully within the viewport. The refreshed `browser-checks.json` has no reported errors (checked at `2026-10-29T19:42:05.280Z`).

## Detector advisories and limits

`detector.json` contains advisory findings, not a reason to expand the root design system. The panel's `rgb(0 0 0 / .4)` backdrop is a local modal scrim, not an additional brand color or shadow vocabulary. Its 16px section headings and 21px mobile dialog heading support the selected large-panel hierarchy. Record them here as scoped implementation values; do not promote these one-surface additions into global primitives.

The detector also flags pre-existing 18px headings in `src/board/page.ts` and 31px/11px KPI typography in `src/outreach/page.ts`. The 11px supporting KPI copy is below the root design document's recorded minimum. These values were neither repaired nor canonized in this pass because they are outside the ticket-panel scope. The root design document and sidecar remain snapshot-focused; this review records the extension without silently broadening their authority.

## Preservation

Only this review and the new ticket-panel surface record were written. `DESIGN.md`, `.impeccable/design.json`, `PRODUCT.md`, the existing workspace surface brief, source files, `docs/NATIVE_WORKSPACE.md`, and unrelated Approvals work were preserved.

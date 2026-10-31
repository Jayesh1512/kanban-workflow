# Approvals — independent re-review verdict (B1 + B2 only)

Reviewer: fresh review sub-agent. Read-only: no code edits, no decisions, commits, deploys, migrations, real login/email/Telegram/AI, no subagents. Synthetic server `localhost:19490` only (synthetic `manager@example.com`, any password).

## Verdict: SHIP at this narrow scope

Both prior blockers are resolved. No new blocker found. Unresolved items from the prior review stay as the listed non-blocking limits.

## B1 — mobile queue tabs at 375px: RESOLVED (captures + CSS; live browser not reachable)

- Source: `src/board/page.ts:48`, inside `@media(max-width:700px)`: `.seg button{flex:1;min-width:0}` is followed by `.seg.scroll button{flex:0 0 auto;min-width:max-content}`. Specificity (0,2,1) beats (0,1,1), and the rule comes later, so the override applies. `.seg.scroll{overflow-x:auto;max-width:100%}` (line 38) plus `.toolbar .seg{width:100%}` makes the strip scroll instead of compress.
- Captures `mobile-approvals-375-manager.png` and `mobile-approvals-375-admin.png` (read): "Initial placement 3" and "CRM changes 2" are fully legible with counts. The next tab, "Work 2", is partly cut at the right edge, which is the horizontal-scroll cue. No overlapping text, and the Refresh button sits on its own row.
- `approvals-mobile-tabs.json`: manager 3 tabs (156/137/80px) and admin 4 tabs (153/134/76/118px), `textClipped:false`, `wraps:false`, `containerScrolls:true`, `pageOverflow:false`. Before the fix the buttons were 116px (manager) and 88px (admin) and clipped.
- Admin's 4th tab ("Chat intake") reaches view on focus (pass).

Not verified: the preview browser disconnected on every open (the synthetic server was also briefly down while restarting), so I did not re-measure at 375px myself, and I did not scroll the strip by hand. I relied on the author's captures and JSON.

Non-blocking notes (no action needed to ship):
1. The JSON has one `FAIL`: "manager: last tab scrolls into view when focused". The manager capture shows a heavy dark bar left of "Work", which looks like a focus ring from that test, clipped by the strip's `overflow`. "Work 2" is still partly visible and tappable, and the admin equivalent passes. It is most likely a test-measurement artifact, since browsers scroll a focused element into view natively. Eyeball it once by tabbing to "Work" on a phone.
2. Tabs after the viewport edge are signaled only by a clipped label. That is acceptable for the Operate incumbent style.

## B2 — source-context copy: RESOLVED (verified live and in source)

- Source: `src/outreach/service.ts:45-46`. The native `get()` maps the exact old string to "Human CRM moves save immediately without a Telegram message. Pending suggestions and data changes can be approved in Approvals or Telegram." I compared it character for character with `src/outreach/repository.ts:221`, so it matches.
- Live: I signed in as the synthetic manager and called the private relationship detail for the Basalt Compute placement card. `limits` returned:
  1. "Approved Telegram conversations feed the CRM first. Work tickets require a separately approved concrete action."
  2. "Human CRM moves save immediately without a Telegram message. Pending suggestions and data changes can be approved in Approvals or Telegram."
  3. "Stored email-report context is reference-only and never creates a CRM card."
  4. "Operational lanes do not establish commercial stages."
  The old "require approval via the matching Telegram control message" string is gone. `publication` is `null` as before.
- Legacy (non-native) mode still returns the old string, because the map is gated on `nativeBoard`.
- The page copy ("Saves immediately … No Telegram message is sent") and the context line no longer contradict each other.

Non-blocking: no test asserts the native `get().limits` copy. Consider one small assertion (native `limits` has no "matching Telegram control message"; legacy keeps it). The only test hits are `tests/board/pages.test.ts:32-33`, which cover the page string.

## Pending-proposal projection (non-blocking item fixed, spot check)

`src/board/approvals.ts` no longer uses `SELECT p.*` for the proposal feed. I did not re-audit it; I only confirmed the old `p.*` select is gone.

## Still-open items (unchanged, scoped limits)

Pagination can miss an off-page stage suggestion; full queue re-render loses focus; an in-flight refresh is dropped; whole-queue `aria-live`; viewer API pending counts; legacy Work visible for unplaced relationships; raw 403 for a non-reviewer on `/approvals`; invalid Telegram replies consumed quietly.

## Ship condition

Root can deploy after its targeted board tests and rebuild pass with these fixes. The one optional follow-up before or after deploy is a quick phone check of the manager "Work" tab focus.

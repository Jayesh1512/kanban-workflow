## Disposition

**Ship** the native workspace UI (`/login`, `/dashboard`, `/work`, `/team`, native `/outreach`) within the reviewed scope, with the verification limits below.

## Evidence validity and scope

Inspected the captures in this folder against the built pages: desktop (1280) login, dashboard CRM and Team-tasks views, CRM card open, My tasks, Access, dark CRM; mobile (390) dashboard, CRM, My tasks, Access. Reviewed `PRODUCT.md`, `DESIGN.md`, the scoped surface brief, the craft floor and operate notes, source, `browser-checks.json`. All data is synthetic (`tests/board/ui-preview.ts`); no real login, email, Telegram or AI call was made. No approved comp exists; the incumbent outreach board is the visual authority.

## Material findings fixed during the build

- Dashboard and CRM requested 200 relationships; the API caps at 100. Both now ask for 100 and offer Load more.
- Stage history labelled human moves "AI suggestion". Human moves now read "Moved to X · Saved immediately"; only non-manual origins read "AI suggestion", and pending ones say "Awaiting Telegram review · not applied".
- Admin-only nav links leaked on the CRM page (`hidden` overridden by flex). Fixed with an explicit rule; verified for manager.
- Stage select was named "Proposed sales stage" instead of its visible label; relabelled.
- Access form: the Telegram field label broke grid alignment; members now lead the page, role legend is a disclosure.
- Mobile: toolbar wrapped Refresh onto its own row, empty actions row left a gap, KPI cards were tall. Tightened.

## Direction and craft assessment

Follows the committed Operate direction: one system sans, restrained green only for selection/primary/focus, flat tonal columns with 12px cards, 42px controls, native `details` cards, horizontal boards with stage-jump buttons, no shadows, no decorative imagery. Permission state is stated in words (View only, Read-only, role badges), never colour alone. Dates, source dates and "not applied" wording keep uncertainty visible. Reduced motion removes transitions and the loading shimmer. Dark scheme works through the same token set.

## Residual issues (non-blocking)

- Admin nav "Connections" is clipped on a 390px viewport; the nav scrolls horizontally.
- CRM KPI cards keep the incumbent gradient and 31px/11px sizes; kept for continuity with the production page.
- Task lane changes use the edit form; there is no drag-and-drop (deliberate, keyboard-first).
- Verification limits: no real Supabase or Telegram, no screen reader pass, no 100+ record browser run.

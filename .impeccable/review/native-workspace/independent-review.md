**Section 1: Evidence validity and scope**
- I read the craft floor, DESIGN.md, the surface brief, `src/board/page.ts` and `src/outreach/page.ts`, `finish-review.md` and `browser-checks.json`. I viewed all nine required PNGs and made no changes.
- The captures are valid as synthetic, DPR2 layout evidence at 1280 and 390 px. They cover the top bar, role badges and nav gating, KPI and summary rows, the five-stage and six-lane boards, the CRM manager's stage move panel, Access rows, and login/signup. The mobile and desktop datasets differ (for example 8 vs 9 "Companies in talks"), so don't compare numbers across viewports.
- The CRM-move capture predates the two history-label strings, as you said. I checked those in source instead: `proposalTitle` and `proposalState` at `src/outreach/page.ts:39-40` now key off `human_move` and `decision_source`. `src/outreach/service.ts:211-212` returns them (`human_move` is true only for `source='http'` with human provenance). `tests/board/pages.test.ts:43-49` covers the old-manual and pending-manual cases. No recapture is needed for that.
- I did not run a browser, so the one finding below comes from a source trace and is not a browser reproduction.

**Section 2: Material findings**
1. **Medium, fix: the open card steals keyboard focus from the search box.** The code is at `src/board/page.ts:118`, `:167`, `:137` and `:160`.
   - `openId` is set after Save (`:118`) and after Create (`:167`). It is only cleared on scope or view change and on delete.
   - `render()` (`:137`) re-opens that card and calls `summary.focus()` on every render.
   - Search is wired to `render(true)` (`:160`), so after a member saves or creates a task and types a query that matches it, the first keystroke moves focus into the card summary and the rest go there. Space then toggles the card.
   - Refresh and "Load more" also re-open a card the user closed.
   - The browser checks did not exercise this path.
   - Suggested fix: make `openId` one-shot by clearing it after `render()` applies it.
   - This affects the "keyboard-visible focus" requirement and the main member flow, so it should be fixed before shipping. It is a small change in source and does not change layout, so no recapture is needed.

**Optional polish, not blockers**
- Placeholder text isn't themed. DESIGN.md says supporting ink at full opacity, but the captures show the browser default light grey, which is close to the contrast limit in light mode and unchecked in dark mode.
- The dashboard states "read-only" three times: the View only tag, the description line, and the notice. The two paragraphs stack with a visible gap.
- Mobile CRM puts the KPI grid, status line, import control and search above any board content. The first mobile viewport shows no stage cards. This is the incumbent behaviour, as is the KPI gradient.
- Top-bar nav and Sign out are 36 px tall on mobile. The incumbent stage nav is also 36 px.
- The Connections link is clipped but scrollable at 390 px, as the self-review says.
- `/connections` is the legacy page and only links back to "Outreach pipeline". That is outside the scoped files.

**Section 3: Direction and craft assessment**
- The build matches the incumbent system: system sans, restrained green only for selection, primary and focus, flat wash columns, 12px cards, 42px controls, 3px focus outlines, no shadows or imagery.
- Fixed stages and lanes are respected. Horizontal boards with stage-jump buttons are preserved. The skeleton and shimmer respect reduced motion.
- Ownership and source state are legible in words, not colour alone: "View only", role badges, "You" vs the owner's name, "Accepted" vs "Provisional · not applied", "Saved immediately" vs "Awaiting Telegram review · not applied".
- UI gating matches the request on read:
  - `managesCrm()` and `canEdit()` (owner only, admins included) gate the controls.
  - Viewers get no create control.
  - Admin nav is hidden for other roles.
- Server enforcement is a backend matter and can't be shown by screenshots.
- No craft-floor refusal applies. There are no eyebrows, gradient text, glass or decorative imagery, and the cards are not nested.

**Section 4: Remaining verification limits**
- Not shown in any required capture:
  - the New task editor and the inline task edit form;
  - the delete confirmation;
  - the Access invite form and the role legend (both below the fold);
  - the viewer and manager-read-only CRM views.
  - These are verified only by source and the existing browser-check notes.
- Provisional cards are not exercised. The dashboard keeps them out of stage columns and shows them under "Awaiting CRM placement", while the CRM page places them in `displayStage` columns. Both label them, but counts could differ with real data (the captures show 0 provisional).
- Not checked:
  - real Supabase and Telegram;
  - signup email delivery, where the confirmation email may still hit rate limits;
  - Telegram approval round trips;
  - 100+ relationships and Load more in a browser;
  - 409 stale-version recovery;
  - a screen-reader pass.
- Copy such as "No Telegram message is sent" reflects the UI contract and the tests. It does not show live delivery behaviour.

**Section 5: Disposition**
**fix**: apply the one-shot `openId` change, rerun the board tests, and ship. No recapture is needed.

# Native workspace documentation review

Disposition: documented compatible extension of the incumbent outreach board.

Updated only the scoped surface record `.impeccable/surfaces/src-board-page-ts.md` and this folder. Root `PRODUCT.md` and `DESIGN.md` were not edited (same convention as the meetings review). Both still describe the Vikunja-era outreach snapshot; root should decide whether to fold these items in:

- Standalone workspace pages reuse the outreach tokens (`--ink`, `--soft`, `--paper`, `--wash`, `--line`, `--accent`, `--tint`, `--warn`) with host-variable fallbacks and a dark set; the primary button uses `--primary` (accent in light, #286e50 in dark).
- Shared top bar: brand, five-item nav, name + role badge, Sign out, skip link. Active page uses `aria-current`.
- Role vocabulary on screen: Admin, CRM manager, Member, Viewer. Read-only states are written out.
- Six Work lanes and five CRM stages stay separate; CRM columns come from accepted stage only, with provisional stages listed under "Awaiting CRM placement" as "not applied".
- CRM moves by humans: "Move now", saves immediately, no Telegram. AI suggestions: always "Awaiting Telegram review · not applied".

Evidence: screenshots and `browser-checks.json` in this folder are synthetic-only. Not shown: real sign-in, email, Telegram approval, production volume.

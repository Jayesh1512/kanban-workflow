# Outreach M1 ordinary-extension documentation

Date: 25 October 2026.

Disposition: documentation complete for the ordinary product extension. The supplied finish verdict is **ship** at synthetic-render/code M1 scope. This documentation pass found no material visual blocker in that scope and made no product fixes. Existing `DESIGN.md`, `.impeccable/design.json`, product context and surface direction remain authoritative and unchanged.

## Authority and scope

Reviewed the Impeccable document reference, `PRODUCT.md`, `DESIGN.md`, `.impeccable/design.json`, `.impeccable/surfaces/src-outreach-page-ts.md`, `src/outreach/page.ts` and `src/platform/page.ts`. The task is an extension of the approved compact outreach interface, not a new visual identity or a design-system refresh. No root design documentation or sidecar regeneration is needed or authorized.

The user-selected stages remain **Lead / Prospect, Qualification, Negotiation, Deal Won, Archived**, in that order. The page reads stored records and distinguishes accepted, provisional and unknown placement. Email import, sales approvals and native Vikunja publication are explicitly deferred to M2/M3; their absence is not an M1 defect. The operational workflow lanes remain separate.

## Evidence inspected

- [Desktop synthetic render](desktop.png): 1440 × 1631. All five sales stages are visible; three provisional fixture relationships occupy the first three stages, unsupported outcome columns explain their empty state, and a company-unknown record appears in the separate context-review section. The opened relationship exposes pending source enrollment, contacts, facts and sourced date interpretation without presenting pending context as approved business content.
- [Mobile synthetic render](mobile.png): 390 × 1732. The heading, workspace link, notice and labelled search stack legibly; action controls wrap. The board retains readable-width columns with horizontal overflow and the review record fits the available width. The first open column has bounded vertical overflow rather than forcing long source context across the entire page.
- Code evidence: `src/outreach/page.ts:7–8` defines the inherited palette, compact type, radii, borders, layout and responsive rules; `:25–30` builds native source and relationship disclosures; `:32` builds the stage columns, counts and jump controls; `:33` reads paginated stored records; `:16` identifies deferred milestones. These are source observations, not evidence of live service availability.
- `/tmp/antseed-outreach-design-detect.json` contains **zero Outreach-page findings** and eight advisory findings for the existing platform page.

Both PNGs are review evidence, not shipping raster assets. Their synthetic-test annotation and fixture names must not be read as production relationship data. There are no shipping raster assets requiring provenance in this code-led surface. No browser, server, credentials, model, real service or additional agent was used in this documentation pass. The renders establish the supplied visual states; they do not establish live integration readiness, every interaction state, or host-theme accessibility.

## Fit with the incumbent system

The extension preserves the incumbent's compact single-family typography, restrained green links/focus/open-card border, neutral paper and wash, thin separators, flat depth, 12px relationship and column corners, 7px controls and 12px supporting text. Relationship titles wrap inside their columns. Native `details` disclosures retain inline source inspection; explicit text labels carry stage and source status. The source date fallback says “Source date unknown” rather than inventing a date. Empty Deal Won copy requires supported accepted commercial outcomes rather than treating a completed native lane as revenue.

The board retains the documented five-track minimum of 244px, increases to 270px at 1500px and at the 650px mobile breakpoint, and uses a 10px mobile gap. Column heights remain bounded at 780px/680px with sticky headings. Jump actions scroll and focus the requested column; reduced-motion preference selects immediate scrolling. These observations support compatibility with the approved surface direction.

The application shell deliberately supplies page padding, a maximum width and a paper background (`src/outreach/page.ts:8`). `DESIGN.md:163` describes the original snapshot's transparent, unpadded embedding canvas. This is a standalone-route adaptation, not authority to change the snapshot's embedding contract. Likewise, the stored-record notice replaces a fixed snapshot-age warning and the new context-review heading uses 18px; these are local implementation facts, not additions to the normative token ramp.

## Recorded fidelity differences; no edits

- **Host inheritance is partial.** The extension retains host-variable color fallbacks for ink, supporting ink, paper, wash and borders, but its font declaration omits `--font-sans` and its warning pair is literal (`src/outreach/page.ts:7–8`). The incumbent specifies host sans and warning-variable inheritance (`DESIGN.md:142`, `:146`, `:215`). This is a real compatibility difference; the supplied light renders do not expose its effect, and custom-host/error-theme behavior was not verified. No theme fix or new token has been introduced here.
- **Stage navigation is stateless.** Jump buttons scroll and focus correctly by code inspection, but do not expose the incumbent selected-stage `aria-pressed` state or selected ink/wash/border treatment (`src/outreach/page.ts:32` versus `DESIGN.md:193`). The renders show uniformly neutral jump buttons. This is a fidelity difference, not a blocked jump interaction; the supplied M1 finish verdict remains ship.
- **Some snapshot embellishments are absent.** Relationship hover-border transitions and the authored external-source SVG are not carried into this page (`src/outreach/page.ts:8`, `:24` versus `DESIGN.md:173`, `:209`). Source links remain readable underlined text with no replacement glyph or raster dependency. These omissions do not change the M1 evidence/approval distinctions and are not grounds to rewrite the incumbent system.

## Preexisting platform drift

`git diff -- src/platform/page.ts` shows only the workspace navigation link to `/outreach`. The operational page's CSS remains unchanged. The detector's six color advisories (`#f7f8f5`, `#cdd7d1`, `#145844`, `#455d54`, `#b46924`, `#8b2430`) and two type advisories (`2rem`, `1.2rem`) all point to its incumbent CSS on line 4. They are preexisting platform-page values, not new Outreach drift.

`DESIGN.md` already documents the platform page as a separate operational surface with its own reading width, density, colors and focus treatment. Consequently, these advisories do not authorize changing platform CSS or broadening the outreach snapshot tokens. No preexisting drift was fixed and no discrepancy was concealed by regenerating documentation.

Completion: ordinary-extension documentation recorded; incumbent design authorities preserved; no material fixes or production-readiness claims added.

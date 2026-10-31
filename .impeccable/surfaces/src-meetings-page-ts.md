# Meeting notes surface

Mode: Operate. Route: `/meetings`. Source: `src/meetings/page.ts`.

Status: implemented; independent finish review **Ship** on 26 October 2026.

## Authority and scope

Extend the established AntSeed interface: compact system sans, restrained green
interaction accent, white reading surfaces, neutral secondary layers, flat
borders, visible focus and native controls. Preserve the existing onboarding
and outreach screens. No new visual identity or system token change is intended.

`PRODUCT.md`, `DESIGN.md` and `.impeccable/design.json` retain their existing
outreach scope. The root design tokens describe an embedded outreach snapshot
with host-theme inheritance. This meeting archive is a standalone operating
page with its own top navigation, light page field and outer spacing. Its
source explicitly sets `color-scheme: light` and literal local colors; it does
not inherit the snapshot's transparent body or host theme. Treat this as a
scoped difference, not a replacement of the root Theme Inheritance Rule.

## Product contract

The operator finds a customer, filters meeting history, reads a source summary
and complete transcript, and checks automatic task handoff. A customer list,
meeting list and selected conversation form the desktop workspace. Narrow screens
stack these regions; selecting a meeting brings its detail into view. Keep source
availability, owners, recording timestamps and uncertain task outcomes visible.

Confirmed product decisions: Fathom source; existing Vikunja destination;
automatic task creation for incomplete, unambiguous source actions. Historical
task effects remain inspectable when later Fathom data removes their action.
Source text is escaped. Deadlines and remote user assignments are not inferred.

Hermes uses the existing MCP connection to search the archive and retrieve
complete versioned JSON. Customer associations can be corrected with a reason;
future imports preserve that correction. Transcript availability and source
revision remain visible even when later source data omits content. Date filters
operate on recording start time in the browser's local timezone, with inclusive
start and exclusive end. History import instead uses Fathom creation time.

## Implemented visual contract

The following records the current page, rather than introducing global tokens.

### Colors and depth

- Reading ink (`#192d26`), supporting ink (`#52635b`), white paper (`#fff`),
  page wash (`#f4f6f3`) and separators (`#d4dcd5`) match the outreach fallback
  palette. The customer region and row hover use a lighter wash (`#f8faf7`).
- Interaction green (`#176b52`) and selected tint (`#eaf2ed`) are page-owned
  literal values. They replace the snapshot's host-derived mixed expressions
  only within this page. The solid primary action darkens (`#12573f`) on hover.
- Source warnings use the existing warm ink (`#755014`) and wash (`#fbf3e2`).
  The synthetic banner also uses a warm border (`#dfcca6`). Green status badges
  retain explicit task-state labels; color alone never establishes delivery.
- Depth comes from tonal fields, thin borders and section dividers. No shadows
  or decorative imagery are implemented.

### Typography and shape

One system sans stack serves the entire page. Body is (14px/1.55); the page
heading is (26px/1.2, -0.025em), becoming (23px) at the narrow breakpoint. The
selected meeting heading uses (22px), becoming (23px) on narrow screens. Summary
text uses (13px/1.75), transcript text (13px), and most metadata and labels
(12px). The summary measure is capped at (72ch), transcript rows at (75ch).

Controls have gently rounded corners (7px) and minimum height (40px); notices
use (8px), the workspace (12px), and task badges (4px). Task badges currently
use (11px) text. This is smaller than the root outreach snapshot's documented
(12px) supporting minimum; record it as a scoped implementation deviation,
not a new shared typography rule. The independent finish review found no
material readability defect in the supplied captures.

### Layout and responsive behavior

The standalone page has a white topbar and a centered main area capped at
(1760px), with desktop padding (26px 28px). Filters wrap above a shared bordered
workspace. The desktop tracks are customer navigation (210px), meeting list
(270–340px), and selected detail (at least 340px, consuming the remaining width).
The workspace has minimum height (600px), viewport-relative height
(`calc(100dvh - 290px)`) and maximum height (1100px). Customer, list and detail
regions scroll independently; the list heading is sticky.

- At widths up to (1150px), customer and list tracks tighten to (180px) and
  (250–310px), the detail minimum becomes (300px), and page/detail insets reduce.
- At widths up to (950px), customer navigation and meeting list occupy two
  columns above a full-width detail. Each upper region is capped at (520px).
  Workspace height becomes natural and detail content joins document scrolling.
- At widths up to (580px), all regions stack. Customer choices wrap as compact
  buttons in a region capped at (210px); the list is capped at (390px). Main
  padding becomes (20px 12px), detail padding (22px 18px), search takes a full
  row, and other filter fields share available rows. Connection/import content
  is single-column.

Selecting a meeting moves focus to its heading. At widths up to (950px), it
also scrolls the detail into view, honoring reduced-motion preference. This
workspace stacking and scroll behavior is specific to meetings; the outreach
snapshot's horizontal five-stage board rules do not apply.

### Components and states

- Customer navigation uses native buttons with `aria-pressed`, visible counts
  and green selected text/tint. Meeting rows use native buttons with
  `aria-current`, source date, customer, summary snippet and availability.
- The detail presents source links, complete JSON download, summary, source
  action checkboxes/owners/task states, full transcript disclosure, retained
  task history when applicable, and customer/source details. Source completion
  checkboxes are disabled indicators; they do not edit source task completion.
- Transcript and configuration sections use native `details`/`summary`.
  Transcript segments load on first disclosure, then page explicitly. Complete
  JSON download retrieves every transcript page pinned to the selected source
  revision. A list snippet is not the complete source record.
- Inputs, selectors, buttons and disclosures use visible focus. The global
  focus-visible outline is green (3px); controls and summaries have offset
  (3px). Error notices use alert semantics; ordinary notices and result counts
  use polite status announcements. Busy/disabled states are explicit.
- Button/link background and border transitions last (.15s ease-out), only
  when reduced motion is not requested. No animation is needed to understand
  selection, availability or task handoff.

## Preview and verification

The standalone preview is an explicitly synthetic six-meeting archive, including
two recordings at the same time. It holds queues locally and makes no external
provider calls. Production pages use the actual archive and configuration.

Verification viewports: 1440 desktop, 1280 user viewport, 390 mobile. Check customer
and transcript search, half-open local date/time filters, complete JSON download,
source disclosure, customer correction, keyboard focus, overflow and error/empty
states. Browser check evidence and captures live in `.impeccable/review/meetings/`.

Reviewed `desktop.png`, `user-1280.png`, `mobile.png`, `browser-checks.json` and
`finish-review.md` against the current page source. All captures show the same
synthetic archive and implemented responsive composition. The supplied report
records passing customer/search/date-boundary checks, transcript disclosure,
complete pinned JSON download, customer correction/restoration, no horizontal
overflow at the three viewports, and no JavaScript errors. The 1280 capture
ends within the internally scrolling detail; it does not establish absent
transcript/source content. The mobile capture shows those sections.

The package build command is `tsc -p tsconfig.build.json`, compiling
`src/**/*.ts` to `dist` with declarations and source maps under the shared
strict NodeNext/ES2023 rules. The documenter ran `npm run build` successfully
on 26 October 2026. No browser or provider flow was rerun for documentation.

Evidence limits: the captures show one selected synthetic meeting and collapsed
transcript/setup disclosures. The supplied functional report provides broader
behavior checks, but neither establishes live Fathom ingestion, real Vikunja
publication, production archive coverage or an authenticated Hermes round trip.
These limits must accompany any readiness claim.

## Maintenance boundaries

Keep page-local colors, light-field ownership, standalone spacing, region
layout and task-badge sizing in this scoped record. Do not silently promote
them into the outreach root tokens. Root product documentation remains about
outreach and is not a complete product specification for meetings; the
confirmed meeting decisions above provide the scoped contract. Existing
PRODUCT/DESIGN/sidecar scope differences are recorded, with no root repairs
or identity replacement authorized by this extension.

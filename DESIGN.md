---
name: AntSeed outreach operating interface
description: Inherited compact interface for inspecting outreach evidence and next actions.
colors:
  primary: "color-mix(in srgb,var(--foreground,#192d26) 70%,#168366)"
  ink: "var(--foreground,#192d26)"
  soft: "var(--muted-foreground,#52635b)"
  paper: "var(--card,#fff)"
  wash: "var(--secondary,#f4f6f3)"
  line: "var(--border,#d4dcd5)"
  brandwash: "color-mix(in srgb,var(--foreground,#192d26) 6%,var(--card,#fff))"
  warning-ink: "var(--warning-foreground,#755014)"
  warning-wash: "var(--warning-surface,#fbf3e2)"
typography:
  headline:
    fontFamily: 'var(--font-sans,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif)'
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  headline-mobile:
    fontFamily: 'var(--font-sans,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif)'
    fontSize: "23px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.4
  stage-title:
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1.35
  body:
    fontFamily: 'var(--font-sans,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif)'
    fontSize: "14px"
  card-body:
    fontSize: "13px"
    lineHeight: 1.55
  detail-body:
    fontSize: "13px"
    lineHeight: 1.6
  label:
    fontSize: "12px"
    fontWeight: 600
  supporting:
    fontSize: "12px"
    lineHeight: 1.45
rounded:
  badge: "4px"
  count: "5px"
  control: "7px"
  notice: "8px"
  card: "12px"
spacing:
  badge-block: "3px"
  field-gap: "5px"
  compact-gap: "7px"
  small-gap: "8px"
  card-gap: "10px"
  board-gap: "12px"
  card-inset: "14px"
  section-gap: "16px"
  support-gap: "24px"
components:
  button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
  button-hover:
    backgroundColor: "{colors.wash}"
  field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 11px"
  stage-button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "7px 10px"
  stage-button-selected:
    backgroundColor: "{colors.brandwash}"
    textColor: "{colors.primary}"
  badge:
    backgroundColor: "{colors.wash}"
    textColor: "{colors.soft}"
    rounded: "{rounded.badge}"
    padding: "3px 6px"
  badge-email:
    backgroundColor: "{colors.brandwash}"
    textColor: "{colors.primary}"
  badge-research:
    backgroundColor: "{colors.warning-wash}"
    textColor: "{colors.warning-ink}"
  relationship-card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
  source-warning:
    backgroundColor: "{colors.warning-wash}"
    textColor: "{colors.warning-ink}"
    rounded: "{rounded.notice}"
    padding: "12px 14px"
---

# Design System: AntSeed outreach operating interface

## Overview

This records the inherited AntSeed operating interface as implemented in the finished outreach snapshot. It establishes no new brand metaphor or visual identity. Compact system typography, restrained green accents and neutral layers support reading evidence, locating a relationship and inspecting its next action.

The normative tokens above describe `artifacts/outreach-dashboard/index.html`, whose styles match `.local/outreach-dashboard/template.html`. They apply to this snapshot and compatible extensions. `src/platform/page.ts` remains a separate production operational page: it uses a system sans body (16px/1.6), a centered reading width (58rem), page padding (1.5rem), article corners (8px) and its own source-owned colors and focus treatment. The snapshot's density, edge-to-edge embedding and board breakpoints do not supersede that page's existing rules.

**Key Characteristics:**

- Compact evidence-first reading with dates, source labels and visible uncertainty.
- Flat neutral layers, thin separators and restrained green interaction cues.
- Native inline disclosure and keyboard-visible navigation.
- Host-theme colors and font inheritance on a transparent, unpadded embedding field.

## Colors

The snapshot uses one restrained green interaction accent with neutral reading surfaces and a warm warning pair. Frontmatter preserves the actual CSS color expressions; host theme variables take precedence over their light-theme fallbacks.

### Primary

- **Restrained interaction green** (`primary`): links, placement signals, selected stage buttons, open-card borders and focus outlines. It mixes the current foreground with the inherited green input rather than fixing a separate theme color.
- **Subtle interaction wash** (`brandwash`): selected navigation, reported-email badges and text selection. Derived from a small foreground contribution over the current card surface.

### Neutral

- **Reading ink** (`ink`): headings, primary content and counts.
- **Supporting ink** (`soft`): dates, source identifiers, labels and explanatory text.
- **Card paper** (`paper`): fields, buttons, cards and count badges.
- **Column wash** (`wash`): column backgrounds and neutral source badges.
- **Separator** (`line`): thin borders, dividers and scrollbars.
- **Warning ink / warning wash** (`warning-ink`, `warning-wash`): source-age limits and historical/research evidence labels. These signal evidence conditions, not performance or success.

**The Theme Inheritance Rule.** Preserve the host-variable fallbacks and mixed-color accent when extending the snapshot; hardcoded light-only surfaces would break its embedding contract.

## Typography

**Body Font:** the host sans font, falling back to the system sans stack in `typography.body`. Headings, controls and source text use that same family. There is no separate display or mono font.

**Character:** compact and direct. Weight, size and whitespace establish hierarchy; counts and dates use tabular numerals where implemented.

### Hierarchy

- **Headline:** the single page heading; switches to `headline-mobile` at the mobile breakpoint.
- **Title:** relationship names; long names wrap anywhere instead of widening a card.
- **Stage title:** compact column headers with adjacent count badges.
- **Body:** the snapshot's base size; general paragraphs use a line height (1.55).
- **Card body / detail body:** next-action text and expanded source context respectively.
- **Label / supporting:** source badges, metadata, field labels, navigation and help. Supporting text remains at least (12px).

**The Readable Density Rule.** Keep card content compact through hierarchy and disclosure rather than reducing supporting text below the implemented minimum.

## Layout

The snapshot has a transparent root and body, zero body margin and no outer padding or containing card. The host supplies its surrounding page field. A heading row, dated warning, compact counts and filtering controls precede the board. Header description text is limited to a reading measure (70ch); longer supporting descriptions use up to (75ch).

The five-column composition is specific to this outreach surface: Lead / Prospect, Qualification, Negotiation, Deal Won, Archived, in that order. It is a display classification, separate from operational lanes. Do not infer a universal five-column layout for other AntSeed screens.

The board uses five equal grid tracks with a minimum width (244px), a gap from `board-gap` and horizontal overflow. From (1500px) viewport width, each track has a larger minimum (270px). At and below (650px), tracks also use that larger minimum, the board gap becomes (10px), the headline switches to its mobile role, search takes a full row, remaining controls share available width, and support grids become single-column. At intermediate thread width, the base minimum remains in force. Columns are never squeezed into unreadable mobile slivers or silently removed.

Each column has an inset (12px), independent vertical overflow, a stable scrollbar gutter and a maximum height (780px), reduced to (680px) at the mobile breakpoint. Column headers remain sticky within their own scroll area. Horizontal proximity snapping supplements explicit stage-jump buttons; selecting a stage scrolls it into view and focuses its column. This is snapshot behavior, not a responsive rule for the production operational page.

## Elevation & Depth

The snapshot uses no box shadows. Card paper sits on column wash; thin borders and separators distinguish containment. Hover changes a card's border to supporting ink, and an open card uses the interaction accent. The heading row's stronger bottom rule (2px) marks the top-level boundary. Focus uses an outline rather than elevation.

**The Flat Surface Rule.** Preserve tonal containment and borders when adding compatible snapshot components; there is no shadow vocabulary to extend.

## Shapes

Cards and columns share the gently rounded `card` radius. Compact controls use `control`; warnings and no-results panels use `notice`. Small badges and count markers use their respective tighter radii. Most borders and separators are (1px); a no-results panel uses a dashed border. These are functional containers rather than decorative material effects.

## Components

### Buttons

Plain paper buttons use a thin separator border, the control radius and semibold text (600). Default minimum height is (40px); toolbar buttons are (42px). Hover uses column wash and a supporting-ink border. Disabled buttons use opacity (.5) and a default cursor. Search reset and visible-pipeline CSV export share this treatment; export disables when there are no visible pipeline records.

### Inputs / Fields

Search and source selection use paper, a thin separator border, the control radius and a minimum height (42px). Labels use the compact label role with `field-gap`. Placeholder text uses supporting ink at full opacity. Search has a base minimum width (190px); the source field starts at (160px), reduced to (140px) in the mobile arrangement.

### Navigation

Stage navigation is a horizontally scrollable row with `compact-gap`. Buttons use compact labels, a minimum height (36px), tabular counts and `aria-pressed` for the selected stage. Selected buttons use interaction ink, wash and border together. Keyboard activation moves focus to the requested column. There is no hover-only navigation dependency.

### Chips

Source badges are informational, not filters. Neutral evidence uses wash and supporting ink; reported-email evidence uses interaction wash and ink; historical/research evidence uses the warning pair. Their compact label weight (600), badge radius and inset distinguish source identity without enlarging the card.

### Cards / Containers

Each relationship is a native `details` element with a full-card summary. Card paper, a thin separator border and the card radius create containment. Summary and expanded-detail insets use `card-inset`; cards stack with `card-gap`. Source label and identifier precede the relationship title; a placement signal, next action and evidence date follow. Expanded content adds a top separator and detailed context. Original extracted history is a nested native disclosure, collapsed until requested. The record remains in its column when opened.

### Source warning and empty states

The source-age warning uses the warning pair, notice radius and a compact body (13px/1.5). It appears before the board and carries actual dates and limits. Empty outcome columns explain the missing evidence; a separate no-results panel explains filtering and reset. Preserve these contextual distinctions rather than turning an unknown outcome into a success or a zero-valued metric.

### Links, focus and motion

Links use interaction ink and an underline offset (3px); hover thickens the underline (2px). External links share one authored, unfilled SVG stroke style (14px square, stroke width 1.6). Focus-visible outlines are (3px), offset (3px), using interaction ink across buttons, links, summaries, fields and focusable columns. Card border transitions take (.16s ease-out). Stage scrolling is smooth unless reduced motion is requested; reduced motion removes transitions and smooth scrolling.

## Do's and Don'ts

### Do:

- **Do** inherit the host theme and sans font through the recorded CSS expressions.
- **Do** preserve readable compact labels, visible focus and native inline disclosure.
- **Do** keep evidence dates, source attribution and uncertainty visible alongside operational content.
- **Do** preserve the snapshot's horizontal board and explicit stage navigation at narrow widths.
- **Do** use flat surface contrast and thin separators for containment.

### Don't:

- **Don't** apply snapshot density or responsive board rules to the separate production operational page without a scoped implementation request.
- **Don't** encode stages or source categories through color alone; retain their text labels.
- **Don't** promote this surface's five-stage composition into a system-wide layout requirement.
- **Don't** replace authored external-link SVGs with glyph icons or image dependencies.
- **Don't** hide source-age limits or present an unsupported outcome as a confirmed result.

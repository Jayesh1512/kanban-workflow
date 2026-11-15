---
name: Antseed Vision Deck
description: The open intelligence network, presented through the official Antseed brand system.
colors:
  action-green: "#4f7a24"
  night-green-text: "#98c463"
  acid-light: "#c8f53c"
  paper: "#ffffff"
  page: "#fcfcfc"
  text: "#30382c"
  h1-second: "#595959"
  title-second: "#929292"
  body: "#56656f"
  small: "#66746b"
  dot: "#e2e2e2"
  night-page: "#0f1312"
  night-rail: "#181d1b"
  night-text: "#eceee9"
  night-gray: "#9ba49e"
  night-dot: "#3d4340"
typography:
  display:
    fontFamily: "\"Geist Pixel Var\", \"Geist\", sans-serif"
    fontSize: "90px"
    fontWeight: 400
    lineHeight: "93px"
    letterSpacing: "-0.08em"
    fontVariation: "\"ELSH\" 11"
  headline:
    fontFamily: "\"Geist Pixel Var\", \"Geist\", sans-serif"
    fontSize: "48px"
    fontWeight: 400
    lineHeight: "46px"
    letterSpacing: "-2px"
    fontVariation: "\"ELSH\" 40"
  lede:
    fontFamily: "\"Geist\", system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 400
    lineHeight: "36px"
    letterSpacing: "-0.01em"
  subheading:
    fontFamily: "\"Geist\", system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 500
    lineHeight: "28px"
    letterSpacing: "0"
  body:
    fontFamily: "\"Geist\", system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: "27px"
    letterSpacing: "0"
  button:
    fontFamily: "\"Geist\", system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: "20px"
    letterSpacing: "0"
  small:
    fontFamily: "\"Geist\", system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
    letterSpacing: "0"
  counter:
    fontFamily: "\"Geist Mono\", ui-monospace, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: "18px"
    letterSpacing: "0"
rounded:
  card: "11px"
  window: "8px"
  popover: "6px"
  control: "5px"
  tile: "3px"
  button: "10px"
spacing:
  grid: "8px"
  page-gutter: "16px"
  mobile-gutter: "24px"
  desktop-gutter: "48px"
  split-gap: "64px"
  content-gap: "24px"
components:
  action-primary:
    backgroundColor: "{colors.action-green}"
    textColor: "{colors.paper}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    padding: "0 20px"
    height: "44px"
  action-ghost:
    backgroundColor: "rgba(214, 219, 211, .2)"
    textColor: "{colors.text}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    padding: "0 20px"
    height: "44px"
  navigation-button:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "8px"
    width: "40px"
    height: "40px"
  source-card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.text}"
    rounded: "{rounded.popover}"
    padding: "32px"
    width: "min(780px, 100%)"
---
# Design System: Antseed Vision Deck

## Overview

**Creative North Star: "Friendly and technical"**

This document applies to the Antseed vision presentation in this directory. The published Antseed v1 guide, snapshotted in `brand/AGENTS.md` and `brand/DESIGN.md`, establishes the identity; `brand/tokens.css` and `brand/components.css` supply its numeric and component rules. The user-approved compliance pass supersedes the previous warm-paper palette, acid action buttons and uniform ELSH 11 headings. Parent CRM and neobank artifact documents do not govern this deck.

Clean structure carries the technical story. Approved watercolor landscapes and round dots supply its friendly half. The presentation remains quiet and readable while preserving the official logos, separate day/night paintings, source evidence and qualifications.

**Key Characteristics:**
- White paper rails and dot-matrix margins by day, distinct charcoal page and rail at night.
- Two-tone Geist Pixel titles above plain Geist prose.
- Approved watercolor pairs and original monochrome logos.
- Flat narrative rows, accessible controls and a secondary evidence dialog.

## Colors

Action green is restrained and functional. Paper, gray typography and quiet matrix dots carry the light theme; the dark theme separates the page from its rail and uses a lighter green for text.

### Primary
- **Action green:** primary button fill in both themes, daytime green text and text selection.
- **Night green text:** dark-theme emphasis, links, focus and the selected slide indicator.
- **Acid light:** the static dot-ants on the night painting; it does not replace action green.

### Neutral
- **Paper and page:** white content rail against the slightly softer page.
- **Text, body and small:** separate roles for primary copy, explanations and metadata.
- **H1 second and title second:** distinct gray second halves for the cover and section titles.
- **Night page and night rail:** distinct dark ground and content surface.
- **Night text and night gray:** primary text and the shared secondary gray at night.
- **Dot and night dot:** themed round points in margins and rail outlines.

**The Color Role Rule.** Action green fills the primary button in both themes. Night green text uses its separate text token. Acid belongs to light effects and night dot-ants, never the primary CTA.

## Typography

**Display Font:** Geist Pixel Var, with Geist and sans-serif fallbacks. H1 shape ELSH 11; section shape ELSH 40; flow figures ELSH 20.

**Body Font:** Geist, with system-ui and sans-serif fallbacks.

**Mono Font:** Geist Mono for the compact slide counter, with ui-monospace and monospace fallbacks.

Only regular and medium weights load. The H1 retains the official opacity treatment (.82). Cover and section titles use the kit’s tight display tracking; ledes use the kit’s subtler tracking. Supporting subheads and body prose use neutral tracking. Figures are tabular.

### Hierarchy
- **Display:** the cover’s two-tone H1. On phones the official role becomes 46px/50px.
- **Headline:** slide and evidence-dialog section titles. The phone section role is 34px/36px with −1.4px tracking.
- **Lede:** cover explanation; the phone role becomes 20px/28px.
- **Subheading:** medium Geist labels in narrative rows, flow and economics. Closing-slide subheads use 20px/26px.
- **Body:** explanatory copy uses the sub role, with ordinary body copy at 16px/24px. The sub role becomes 16px/24px on phones. The compact mobile comparison table uses 14px/20px, with 12px/18px row labels.
- **Small:** header context, qualifications and source metadata.
- **Button:** sentence-case action labels.
- **Counter:** tabular Geist Mono navigation detail.

**The Two-Tone Rule.** The cover uses the H1 pixel shape and gray second line without a final period. Section titles use the section pixel shape, a gray second half and a final period.

## Layout

The presentation fits a 1280×720 board proportionally into the desktop viewport. The active slide has a 96px header, 560px content region and 64px footer, with 48px horizontal content gutters. Split layouts use 608px of text, 64px of separation and a 512px painting. Painting panels are 480px high. Narrative rows, the four-step flow, comparison table, trust definitions and economics columns share open space and light separators.

At 760px and below, the board becomes a natural scrolling document inside 16px page margins. Slide gutters become 24px and the header 80px. Text/art splits stack; the flow becomes two columns; trust and economics stack into single columns. Story paintings remain 320px high. Fixed bottom controls remain available, with 96px of page space reserved below the content. Compact counters replace the desktop dot navigation and keyboard help.

**The Paper Rail Rule.** The dot matrix belongs in the margins. Content and the logo sit on the rail, with dotted rail outlines.

## Elevation & Depth

Narrative structure stays flat. Fine dividers and themed surfaces separate the argument without raised content cards. The official primary and ghost buttons retain the kit’s inset lip and subtle day shadow. The navigation frame uses the kit’s white inset ring by day and its faint near-white night ring on the dark rail. Source notes open on a solid rail surface over a dim backdrop, with scroll contained inside the dialog. Peer annotations use the supplied light or smoked glass backgrounds and a backdrop blur.

## Shapes

Radii nest by role: painting card, navigation window, source popover, icon control and small tile. Actions use the button radius. Dots remain circular, with the matrix and rail outlines on the official 8px pitch. Logo proportions remain unchanged. There is no orbit, central hub illustration or replacement mascot.

## Components

### Buttons

A group contains one filled primary action, followed by kit ghost variants. The primary keeps white text and action green in either theme. Kit hover fills and inset lips supply feedback. Focus uses the themed focus token, a 2px outline and an offset of 2px on kit actions or 4px on general controls. Hover feedback is limited to a fine pointer for presentation controls.

### Painting panels

Approved day/night images fill clipped card-shaped panels. Overlay annotations use the control radius and supplied glass treatments. The cover’s watercolor blends into the rail so the title sits in readable sky. Painting files are not treated as an invitation to invent new scenes.

**The Paired Painting Rule.** Day and night use separate approved paintings. A theme change reveals the new painting from the sky downward; it does not recolor the day image with a filter.

Theme changes crossfade page colors over .6s and reveal the paired painting from top to bottom over 1.2s, with a soft front. Initial load, reduced motion and still/demo captures show the completed state immediately. Painting transition overlays are removed on navigation, hidden tabs and reduced-motion changes. The deck has no idle animation or repeated text entrances.

### Navigation

Previous/next, slide counter, theme and fullscreen remain visible. Desktop dot indicators select any slide. Endpoints disable the unavailable arrow. Keyboard shortcuts and horizontal swipes mirror the visible controls. Icon buttons are 40px square with simple consistent SVG icons and control corners. Inactive slides are hidden, aria-hidden and inert.

### Source dialog

Every slide’s Sources control opens a scrollable evidence surface with linked citations, source dates and claim qualifications. Protocol economics remains secondary here. The dialog uses the popover radius, 32px padding on desktop and 24px on phones. Opening it makes the presentation and navigation inert; Tab stays inside, Escape dismisses it and focus returns to the trigger.

### Narrative tables and rows

Medium labels and regular explanatory text are separated by fine themed rules. The comparison’s Antseed column uses the kit’s neutral tile surface rather than an acid wash. The flow’s ordinal figures use the pixel figure role and green text token. Source and statistic language remains attributed, without inventing a product UI capture.

## Do's and Don'ts

### Do:
- **Do** use the official color, type, radius and component tokens before adding local values.
- **Do** keep words readable independently of artwork and source evidence reachable from each slide.
- **Do** use the original logo files and approved day/night painting pairs without stretching or recoloring them.
- **Do** place round peer dots on the 8px coordinate grid and keep the network composition free of a central hub.
- **Do** retain keyboard navigation, focus return, inert inactive content and a readable reduced-motion still.

### Don't:
- **Don’t** reinstate cream UI paper or acid primary action buttons.
- **Don’t** use font weights outside 400 and 500 or apply negative tracking to ordinary prose and subheads.
- **Don’t** turn sparse watercolor panels into dense illustrations or invent a new mascot.
- **Don’t** add idle seed or dot loops, repeated text entrances or hidden running animations.
- **Don’t** scale desktop text down as the mobile reading layout; stack the content instead.

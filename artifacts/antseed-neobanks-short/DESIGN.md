---
name: Antseed Neobank Partner Deck
description: Eight-slide Antseed presentation using the supplied PDF’s measured visual system.
colors:
  green: "#4f7a24"
  green-hover-light: "#436a1e"
  green-hover-dark: "#5b8a2b"
  green-lip: "#3b5e17"
  green-text-night: "#98c463"
  ink: "#0a1a12"
  paper: "#ffffff"
  page: "#fcfcfc"
  night: "#0f1312"
  night-surface: "#181d1b"
  text: "#30382c"
  text-grey: "#929292"
  h1-second: "#595959"
  text-body: "#56656f"
  text-small: "#66746b"
  text-night: "#eceee9"
  text-muted-night: "#9ba49e"
  dot: "#e2e2e2"
  dot-night: "#3d4340"
  tile: "rgba(214, 219, 211, .2)"
  tile-night: "rgba(255, 255, 255, .06)"
  tile-line: "rgba(64, 76, 66, .1)"
  tile-line-night: "rgba(255, 255, 255, .1)"
  smoked-glass: "rgba(14, 33, 23, .64)"
  smoked-strong: "#ecf3ee"
typography:
  display:
    fontFamily: '"Geist Pixel Var", "Geist", sans-serif'
    fontSize: "46px"
    fontWeight: 400
    lineHeight: "50px"
    letterSpacing: "-0.08em"
    fontVariation: '"ELSH" 11'
  headline:
    fontFamily: '"Geist Pixel Var", "Geist", sans-serif'
    fontSize: "34px"
    fontWeight: 400
    lineHeight: "36px"
    letterSpacing: "-0.04em"
    fontVariation: '"ELSH" 40'
  title:
    fontFamily: '"Geist", system-ui, sans-serif'
    fontSize: "17px"
    fontWeight: 500
    lineHeight: "24px"
  card-title:
    fontFamily: '"Geist Pixel Var", "Geist", sans-serif'
    fontSize: "24px"
    fontWeight: 400
    lineHeight: "28px"
    letterSpacing: "0"
    fontVariation: '"ELSH" 20'
  body:
    fontFamily: '"Geist", system-ui, sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "24px"
  card-body:
    fontFamily: '"Geist", system-ui, sans-serif'
    fontSize: "15px"
    fontWeight: 400
    lineHeight: "22px"
  label:
    fontFamily: '"Geist", system-ui, sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "18px"
  small:
    fontFamily: '"Geist", system-ui, sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  button:
    fontFamily: '"Geist", system-ui, sans-serif'
    fontSize: "15px"
    fontWeight: 500
    lineHeight: "20px"
  figure:
    fontFamily: '"Geist Pixel Var", "Geist", sans-serif'
    fontSize: "32px"
    fontWeight: 400
    lineHeight: "36px"
    letterSpacing: "0"
    fontVariation: '"ELSH" 20'
  figure-compact:
    fontFamily: '"Geist Pixel Var", "Geist", sans-serif'
    fontSize: "26px"
    fontWeight: 400
    lineHeight: "30px"
    fontVariation: '"ELSH" 20'
  price-range:
    fontFamily: '"Geist Pixel Var", "Geist", sans-serif'
    fontSize: "60px"
    fontWeight: 400
    lineHeight: "66px"
    letterSpacing: "-0.04em"
    fontVariation: '"ELSH" 20'
  terminal:
    fontFamily: '"Geist Mono", ui-monospace, monospace'
    fontSize: "11.475px"
    fontWeight: 400
    lineHeight: "20.06px"
rounded:
  card: "11px"
  window: "8px"
  control: "5px"
  bar: "5px"
  button: "10px"
  pill: "999px"
spacing:
  grid: "8px"
  frame: "16px"
  content-gutter: "80px"
  card-padding-y: "20px"
  card-padding-x: "22px"
  model-gap: "16px"
  panel-inset: "40px"
  benefit-column-gap: "40px"
  offer-arrow-slot: "51.2px"
components:
  button-primary:
    backgroundColor: "{colors.green}"
    textColor: "{colors.paper}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    padding: "0 20px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.green-hover-light}"
  button-primary-hover-night:
    backgroundColor: "{colors.green-hover-dark}"
  topic:
    textColor: "{colors.text-small}"
    typography: "{typography.label}"
  offer-card:
    backgroundColor: "{colors.tile}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
    padding: "20px 22px"
    height: "302px"
    width: "339.2px"
  model-card:
    backgroundColor: "{colors.tile}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
    padding: "16px"
    height: "150px"
  launch-card:
    backgroundColor: "{colors.tile}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
    padding: "52px 18px 18px"
    height: "190px"
  nav-control:
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "8px"
    size: "40px"
  cover-pill:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 11px"
    height: "24px"
---

# Design System: Antseed Neobank Partner Deck

## Overview

**Creative North Star: "Antseed’s illustrated partner rail"**

The supplied Antseed PDF is the visual authority: a white or dark presentation rail inside dotted margins, measured pixel headlines, restrained Geist text, and original ant characters against watercolor landscapes. The visual tone is clear, light and approachable, with the authored technical chapters held in night colors.

This records the completed eight-slide condensation. Source measurements override the earlier intro-deck approximation. Pinned section topics, illustrated offer cards and compact merged-content rows are approved adaptations; claims and editorial decisions belong in story-map.json. The eight slides follow the PDF’s styles without claiming to reproduce all fifteen source pages pixel for pixel.

**Key Characteristics:**

- Measured source typography and a 16px paper frame
- Two-tone variable pixel headings and Geist 400/500 text
- Original PDF ants, paintings, extracted icons and model marks
- Fixed dark technical chapters with optional global night
- Editable native text and pricing, responsive reflow and quiet controls

## Colors

### Primary

Forest green anchors filled actions, topic dots and positive price outcomes. Night leaf green lifts links and figures against the dark rail. Hover greens vary with the global theme; the white button label remains stable.

### Neutral

White paper forms the light rail over the near-white page. Text ink, body slate, small-text green-gray and two heading grays establish hierarchy. Night uses a near-black page, dark green-gray rail, near-white ink and muted sage-gray text. Tiles use translucent neutral fills and subtle inset edges. Smoked green glass belongs over technical landscape artwork. The list-price and network bars use the source’s warm neutral and muted leaf fills; the after-reward bar uses forest green.

**The Technical Night Rule.** The Gateway and network snapshot retain the source dark rail, text and night artwork in either global theme.

The default presentation follows the PDF’s light pages and authored dark chapters. The optional global night theme changes eligible rails, scenes and logo variants; it is stored separately from earlier deck theme preferences.

## Typography

**Display Font:** locally bundled Geist Pixel Var, with Geist/sans-serif fallback. **Body Font:** locally bundled Geist regular and medium. **Label/Mono Font:** locally bundled Geist Mono regular for terminal code, prices and the slide counter.

The frontmatter records the effective desktop type from the PDF fidelity stylesheet, which loads after the shared kit. The cover uses ELSH 11 and 0.82 opacity; section headings use ELSH 40; card headings, figures and price ranges use ELSH 20. Source topic labels use ordinary Geist and a small green dot. Body emphasis uses weight 500, with font synthesis disabled.

**The Two-Tone Heading Rule.** Keep the primary phrase in text ink and its companion phrase in the appropriate heading gray; retain the measured tracking and pixel variation for each role.

Body and lede copy share the body role. Benefits use the title role and card-body role. Model names use Geist medium (14/20); model discounts use Geist Mono (18/24), and model prices use Geist Mono (12.5/16). Figure labels use Geist (13/16); Solid figures use the compact figure role. Follow-up and playbook text use Geist (14/20). Page numbers and source qualifications use the small role. Native numeric comparisons remain editable and use tabular alignment where provided.

## Layout

The source’s 960×540pt page maps to a 1280×720 CSS canvas at 4/3 scale. The desktop canvas scales as a whole within a viewport inset 24px at the top, 16px at the sides and 104px at the bottom. Each slide has a plain inner paper rail inset by the frame token; round dots remain visible in the outer margin on the grid pitch. Standard slide padding is 72px 80px 56px, with source-specific master offsets for pricing and split pages. Page numbers sit 32px from the right and 24px from the bottom.

The cover painting shares the paper frame. Its logo plate is 123×59px at 32px/32px, with an 8px radius and 27px-high logo. Cover copy starts at y80; the lede is at most 620px wide. Original cutouts occupy the source positions, separate from editable text.

Benefits use three columns with the benefit gap and two dotted-separated rows. Offer cards begin at y208 in a five-track grid: three equal 339.2px cards, separated by two arrow slots. The reward caption and qualification remain below the cards. Pricing uses a 504px explanation column at x80, and native bars/model cards beginning at x664; the chart starts at y160. Model cards use three columns with the model gap.

The Gateway has a 520px copy column at x80 and a 600×640px artwork panel at x640/y40. Its terminal is inset 24px horizontally and 44px from the panel top. Proof and Solid use a 538×640px panel at x40/y40, with text starting at x633.6 and ending at the content gutter. Metric grids use two columns. The launch master has four horizontal cards at y216, each 190px tall, with 16px gaps; a compact three-column playbook row follows at y430.

At max-width 760px, the canvas becomes a fluid selected-slide reading surface within 16px viewport margins. Slide padding becomes 40px 32px 48px, with an 8px paper frame. The cover remains at least 650px tall, with a 36/40 headline; section headings become 30/34, while body copy stays at the desktop body role. Benefits, offers, model cards, launch cards and playbook rows stack into one column. Offer cards retain their desktop height and arrows disappear. Metrics stay in two columns. Image panels move into flow; Solid keeps a 538/640 aspect ratio. Gateway stacks terminal and character within a panel at least 640px tall; terminal text becomes 10.5/18 and pane tags enter normal flow. Dot navigation and keyboard help hide, while main controls remain fixed below the content. Print places all eight desktop slides on separate 1280×720 pages.

## Elevation & Depth

The rail and explanatory cards are flat. Cards and bar tracks use fine inset edges rather than elevated shadows. Artwork supplies depth through original ant cutouts and soft upward landscape masks. Filled actions have a shallow lower lip and inset highlight; pills and the controls tray use a fine inset ring. The Gateway terminal uses the shared smoked-glass shadow and half-pixel green edge. Its final PDF-fidelity override disables backdrop filtering, leaving the landscape unblurred through the translucent smoke.

**The Still-at-Rest Rule.** Nothing animates while idle. Motion answers a control action and stops for reduced motion, hidden documents and still captures.

Surface/text theme feedback takes 600ms; user-triggered painting sweeps take 1200ms with ease-in-out. Filled-button feedback takes 150ms. Slide changes are immediate. The terminal cursor’s inherited blink is explicitly disabled in the effective deck stylesheet.

## Shapes

Artwork panels, offer cards, model cards and launch cards share the card radius. Terminal windows, the logo plate and navigation tray use the window radius. Bar tracks and controls use their small corner roles; filled actions are gently rounded and the cover context label is fully round. Dot textures and row separators are round. Artwork panels clip their images; offer landscape strips fade upward through a mask behind editable copy and original ant cutouts.

## Components

### Buttons

Filled green anchors use the button tokens, shallow lip, white text and theme-specific hover fill. Focus is a 2px green outline with a 2px offset. Book a call and Gateway docs share the same primary component. The Stats text link underlines on hover. No input or form component is present in the artifact.

### Navigation

The centered tray uses the window radius, 8px 16px padding and 8px gaps. Icon controls are 40px squares with 20px inline SVGs. Disabled previous/next controls have 0.35 opacity. Each desktop slide target is 32×40px with a 4px dot; the current dot is 8px and green. The counter uses Geist Mono (12.5/18). Fine-pointer hover adds a translucent tile; visible focus uses a 2px green outline with a 4px offset.

Arrow/Page keys, Space, Home and End navigate; T toggles theme and F toggles fullscreen. Horizontal swipes require more than 60px and 1.8 times the vertical travel. Inactive slides are hidden, aria-hidden and inert. The count announces changes; incoming heading focus is restored when focus was inside the outgoing slide. Theme preference persists and can be selected by URL.

### Cover Pill and Section Topics

The context pill uses white glass by day and translucent dark glass by night. Content topics remain above the heading, with the label role, an 8px gap and a 6px forest-green circular marker. These source-template devices are explicitly approved for this deck.

### Illustrated Offer Cards

The offer-card tokens set the measured frame. Each combines a green label, pixel title and card-body text above a 120px masked watercolor strip and original PDF ant. The fine edge is an inset 1px shadow. Phones retain the frame height at full available width. Cards are explanatory and have no hover or selection behavior.

### Native Pricing Bars and Model Cards

Bar rows align a 150px label, 266px track and 88px right-aligned amount, with 16px gaps. Tracks are 32px tall. The source fills are warm neutral (#d9d6c8), muted leaf (#b9c99a) and green; widths follow the displayed native prices. Each model card has an extracted 24px mark, mono discount, model name and a semantic definition list of list/effective prices. These are cards, not a comparison table or flattened slide image. Phones use narrower label/amount columns, 26px tracks and stacked model cards. Qualifications and source dates remain visible native text.

### Artwork, Terminal and Figures

Use supplied PDF cutouts, extracted icons/model marks and the Solid panel unchanged. Pair approved day/night scenes through their actual image sources; technical chapters pin both sources to the night image. Original black/near-white logo variants swap with the global theme. Eligible night cutouts use brightness(.84) saturate(.83) contrast(1.12); the authored technical scenes preserve their cutouts without that filter.

The shared terminal preserves its translucent smoke without backdrop blur and uses a 34px title bar, three colored 10px window lights, dotted pane separators and wrapping native code. Its 11.475/20.06 mono body, 10.2/17.85 title and 9.35/16.4 tags follow the source kit. Metrics use dotted top edges and the measured pixel numeral roles. Source popup and footer-left description markup are absent.

### Launch Cards

Four numbered cards use the launch-card frame. Their top-left ELSH-20 numerals use the compact figure role and green outcome color; titles use Geist medium (16/24), with card-body descriptions. They form one horizontal row on the source canvas and stack into content-height cards with a 170px minimum on phones. The compact follow-up row and final action remain outside the cards.

## Do's and Don'ts

### Do:

- **Do** preserve the supplied PDF’s measured typography, paper frame, content gutter and component proportions.
- **Do** preserve the approved pinned topics, illustrated offer cards and compact merged-content rows.
- **Do** use original PDF ants, logos, paintings, extracted icons and model marks; keep the source Solid artwork intact.
- **Do** keep pricing as editable native bars and model cards, with labels readable independently of color.
- **Do** reflow the selected slide into a scrollable reading layout at the phone breakpoint.
- **Do** retain visible focus, accessible control labels, the live slide count and inert inactive slides.

### Don't:

- **Don't** reinstate superseded approximate type sizes, card dimensions or pricing-table layouts.
- **Don't** add a Sources popup or footer-left slide descriptions.
- **Don't** replace the fixed night artwork in technical chapters with day scenes.
- **Don't** introduce idle character, cursor, dot or background animation.
- **Don't** inherit unused shared-kit sizes as though they were the effective deck styles.

Made by AstraOS for Antseed — v1, 12 Nov 2026

# Antseed design guide

The full written guide to the Antseed brand, in the order of the kit's page (/brand/): each "## " heading below matches a section of the page and its anchor (#logo is "## Logo"). Every value carries the file and line it was read from on the live site.

Read AGENTS.md first. AGENTS.md and this file are written to agree; where they do not, tokens.json wins, then this file. This file wins over the live site, the live site over Figma Board 3 and anything older.

The black AstraOS bar and colophon on the kit's page are the maker's frame, not the Antseed brand. Copy nothing from them.

## Idea

Friendly and technical. Antseed speaks to prosumers: people who run agents, choose models and read docs, and still like a product with a face. The layout is the technical half: clean, quick to scan, it says what Antseed sells in two seconds. The paintings, the round shapes and the ant are the friendly half. Neither may swallow the other.

This part is Elio's statement of 12 Nov 2026, the authority for the brand's logic (decision D03, restated that day), set as eight principles. Each one says what it means, then "So": what you do because of it. Every other part of this guide follows from them.

### The eight principles

| Principle | What it means | So | Proof on the site |
|---|---|---|---|
| Friendly and technical, for prosumers | The layout is clean and says what Antseed sells in two seconds; the paintings, the round shapes and the ant give it a face. | Name the half a thing serves, then check the other half is still there. | The hero (`hero/index.html`); the Gateway panel: a terminal on the wheat painting v01 (`hero/sections.html:66-75`). |
| The dot is the ant | A point that moves, queues, follows a trail and carries something is an ant seen from far away. So the margins are dots, the outlines are rows of dots and the titles are set in a face made of dots. | Dots are round, sit on the 8px grid and move like ants: walk, queue, gather, carry. | The mark's nodes (`files/logo/antseed-mark-black.svg`, cut from the site's lockup); the margin matrix (`hero/sections.css:41-43`); the dot-ants of Private by design, radius 1.9 in `#c8f53c` (`hero/dither.js:156-157`). |
| Dither and the LED mosaic make it modern and technical | The paintings break into a grid of round dots as they arrive and under the cursor: the machine showing through the painting, which keeps the watercolor from reading as a children's book. | Use them as an arrival or a touch response, never as wallpaper. Make them in code or in the lab; never ask an image model for them. | The hero's arrival (`hero/unveil.js`); every landscape panel's arrival (`hero/card-unveil.js`) and hover mosaic (`hero/wash-led.js`). |
| Soft watercolor is the naive side, and it suits the mascot | Light washes, suggested landscapes, little detail, no ink outline on scenery. That simplicity is what lets a slightly silly character live in it. | Suggested, sparse, mostly paper, the subject low or at the edges, no outline on scenery. | v01, the approved reference, and every vignette v01-v11 (`assets/home/vignettes/`). |
| The mascot has Rabbids energy | One anthropomorphic ant, never scary and never a gross insect: round, a big head, huge white eyes with tiny pupils looking two ways, a small straight mouth. A bit dumb; it carries things and gets amazed. | One round ant on two legs, or a dot. Never insectoid, never a second design. Never name the Rabbids in a prompt and never attach their images: describe the energy in words. | You on the network board (`assets/home/net/ant-you-idle-day.webp`); off-brand: the slim ant (`assets/hero/ant-standing/ant-standing.webp`), the orb-era ant on four legs (`assets/hero/ant-walk.png`). |
| Nothing has a center | Antseed has no middleman, so nothing is drawn around a hub. | No hub in any diagram, layout or composition. Peers sit apart; a painting's subject sits low or at the sides. | The footer's three ants, apart (`assets/home/footer/meadow-wide.webp`); v03, birch trunks at both sides and the middle left as paper. |
| The seed is what gets passed along | The name, the torrent idea of seeding and ants that carry seeds meet in one object: the request, the value moved from peer to peer. | The seed is the request, the cursor and what the ants carry. Caramel by day, a soft amber glow at night; never gold. | The hero's cursor and the seed on its ground (`assets/hero/seed-day.webp`, `seed-night.webp`). |
| Day and night are two paintings | Night is never a filter on the day. Every painting has its own night, made by editing the day image. | If it has a day version, give it a night version. Cut-out ants take the night filter `brightness(.84) saturate(.83) contrast(1.12)` (`hero/index.html:198`). | The hero by day (`assets/hero/whimsical-2.webp`) and at night (`assets/hero/night/whimsical-2-night-b.webp`); every vignette's `-night` file. |

### What an agent does with this

- Before adding anything, say which half it serves, friendly or technical, and check the other half is still there.
- Draw ants as dots or as the one round mascot. Never as a realistic insect, never a second ant design.
- When dots move, give them ant behavior (walk, queue, gather, carry, catch up), not electronic behavior (blinking clusters, square blocks).
- Use the dither and the LED mosaic as a transition or a touch response, not as wallpaper.
- Keep watercolor scenery soft, sparse and outline-free; subjects (the mascot, the coin) may carry a thin ink line.
- Never put a hub in the middle of a diagram.
- If it has a day version, give it a night version.

### Why, principle by principle

| Principle | Since | Decisions | Why |
|---|---|---|---|
| Friendly and technical, for prosumers | 26 Oct 2026 | D03 | 26 Oct, on a call with Antseed: the tone agreed is technical and sophisticated, with the friendliness of the ants. 2 Nov: round shapes for consumers and prosumers, approachable and fun, a step away from the sometimes sterile B2B side of AI products. 4 Nov: every version keeps the same clean, professional layout, which also keeps the brand away from the meme-coin look, even with a big mascot; sober tech sites are easy to scan but cold, mascot-led sites have personality but bury the product. Restated by Elio on 12 Nov as the first principle. |
| The dot is the ant | 2 Nov 2026 | D11, D31, D35 | 2 Nov, the first version of the idea: small marks standing for single ants moving across a pixel matrix. 3 Nov: round dots, never square pixels. 4 Nov: in the more technical hero, the ant is abstracted into moving dots. 6 Nov: the margin matrix and the dotted outlines on one 8px grid. 12 Nov: the green 3 × 3 clusters behind Private by design looked electronic, so single lime dots now walk the grid as ants (commit 6228924). |
| Dither and the LED mosaic make it modern and technical | 9 Nov 2026 | D32, D33, D34 | 9 Nov: dither in round dots, ordered by an R2 sequence, because a Bayer matrix draws little crosses (`hero/dither.js:9-11`). 11 Nov: a shader tool to mix dither with the watercolor, the crisp painting breaking up little by little. 12 Nov: the LED reveal kept for the hero and every landscape panel (commits b40d8b8, 68deb12), the LED mosaic under the cursor, and the dithered flower overlay removed because it did not work. |
| Soft watercolor is the naive side, and it suits the mascot | 3 Nov 2026 | D49, D50 | 3 Nov: the painting is shown, not only used as a base. 9 Nov: not too much detail, so it works with a slightly silly mascot; keep the hero's almost wash-like side. 12 Nov: the landscapes are suggested; the first v02, too zoomed out and detailed, distracted from the content and was redone. |
| The mascot has Rabbids energy | 2 Nov 2026 | D20, D21, D22, D23 | 2 Nov: an insect mascot risks looking gross and uninspiring, and Antseed's marketing asked for a lazy, slightly dumb character people can make fun of. 12 Nov: one ant for everything, the big round one from the hero; the walking ants get the lost look, wide eyes looking to the sides (commits 89e7f1d, 616b5ac). Elio's reference is the Raving Rabbids' energy; it is never named in a prompt nor shown as an image. |
| Nothing has a center | 26 Oct 2026 | — | 26 Oct, on the same call: Antseed has no middleman, so no diagram, layout or illustration is drawn around a hub. |
| The seed is what gets passed along | 2 Nov 2026 | D12, D27, D28 | 2 Nov: the seeding metaphor spreads outward, each point activated and passing it on, so the decentralized side and the information spreading can be read. 3 Nov: the cursor is the seed and the mascot reaches for it. 9 Nov: the seed replaces the orb. 11 Nov: caramel by day, a soft amber glow at night; gold turns flat ochre in watercolor and adds a color. |
| Day and night are two paintings | 11 Nov 2026 | D42, D43, D46 | 11 Nov: Amos and Pranit found the dark mode read as an overlay; the night became a painting of its own for the hero, the footer, the vignettes and the coin, and the hero's night with the crescent moon was picked. 12 Nov: cut-out ants take the night's light (`hero/index.html:198`). |

### On the kit's page

- The cover is built as the site's hero: the lockup where the nav has it (`hero/index.html:68`; the clean file `files/logo/antseed-lockup-black.svg`), then Whimsical 2 with the title in its sky, Geist Pixel ELSH 11 at 90/93, -0.08em, two tones, opacity .82, no full stop (`hero/index.html:97-99`). The painting arrives through the site's own LED unveil, `hero/unveil.js`, loaded unchanged; the title and the buttons fade up once from .94 as on the hero, then hold still (`hero/index.html:248-255`). On a phone the title sits 40px down in the sky, clear of the hills, as the site's phone hero (`hero/index.html:301`). AstraOS's credit is in the colophon only. With reduced motion the painting is there from the start.
- The proofs beside the principles are the site's own files and components. The LED arrival runs on the site's `card-unveil.js`; the walking dots are a small port of the dot-ants in `dither.js` (on the margins' 8px grid here, the site's run on Private by design's 15.45px mosaic).

### Kit copy to approve

New lines written for the kit, not taken from the site:
- The section title "Friendly / and technical." and the lead under it; under it the page heads the first principle "For prosumers.", as the title already names the pair.
- The proof captions of this section.
- The cover: the title "Antseed / brand kit", the buttons "Download the kit", "Agent guide" and "Shader Lab", and the line "Using an agent? Point it at /brand/AGENTS.md."

## Logo

The mark is an ant drawn as a network: three ovals for the body, eight limbs, and a node at the end of each limb. It is where the brand's dot comes from: the dots and dotted lines everywhere else are the ant seen from far away, and the logo is already that abstraction. The logo comes in black and near-white only.

On the kit's page the title is "An ant / made of nodes." (kit copy, to approve).

### Files

In the kit zip they are in `logo/`; on the web, in `/brand/files/logo/`. They are cut from the site's own file (`assets/hero/logo.svg`): the same 26 shapes, centered in a whole-number box, without the Figma export's `preserveAspectRatio="none"` (which lets the logo stretch when its box changes shape).

| File | Size at 1× | For |
|---|---|---|
| `antseed-lockup-black.svg`, `-1x.png`, `-2x.png`, `-4x.png` | 91 × 27 (PNG 91 × 27, 182 × 54, 364 × 108) | The logo on light: paper, frosted glass, the light page |
| `antseed-lockup-near-white.svg` and its PNGs | 91 × 27 | The logo on dark |
| `antseed-mark-black.svg` and its PNGs | 27 × 27 (PNG 27, 54, 108) | The mark alone, on light |
| `antseed-mark-near-white.svg` and its PNGs | 27 × 27 | The mark alone, on dark |
| `favicon.svg` | any | The browser tab: black, near-white when the system is dark |
| `favicon-32.png` | 32 × 32 | Browsers without SVG favicons; the black mark on transparent |
| `apple-touch-icon.png` | 180 × 180 | A phone's home screen: the black mark on paper `#ffffff`, the mark 60 % of the height |
| `icon-512.png` | 512 × 512 | A web app manifest: the black mark on paper, 60 % |
| `antseed-avatar-400.png`, `antseed-avatar-400.svg` | 400 × 400 | Social profiles: the white mark on the action green `#4f7a24`, 60 %, so a round crop keeps every node. Proposal, to approve |

1× is the size the site shows the logo at. For anything bigger use the SVG; where SVG is not accepted (Google Slides), the 4× PNG.

On a coded page, use the black file and let the token turn it at night:

```html
<img class="ak-logo" src="antseed-lockup-black.svg" width="91" height="27" alt="Antseed">
```

`.ak-logo` is `filter: var(--filter-logo)` (components.css): `none` by day, `invert(.93)` at night, which gives about `#ededed`, the site's own way (`hero/sections.css:18`, `:29`, `:660`; `hero/index.html:313`). Everywhere else (images, slides, video, print), use the near-white file on dark.

Favicons:

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

<!-- assets:start kind=logo -->

| ID | Kind | Subject | Size | Status | Day / file | Night | Used on | Recipe |
|---|---|---|---|---|---|---|---|---|
| logo-lockup | logo | The lockup: the ant mark made of nodes, then ANTSEED. Black on paper, near-white #eceee9 at night | 91 × 27 | live: Nav and footer. Clean files cut from the site's ../assets/hero/logo.svg (a Figma export with preserveAspectRatio="none"): the same 26 shapes, centered in a 91 × 27 box; PNG at 1×, 2× and 4×. On a coded page the black file takes --filter-logo at night (class ak-logo); everywhere else use the near-white file | files/logo/antseed-lockup-black.svg | files/logo/antseed-lockup-near-white.svg | ../hero/ |  |
| logo-mark | logo | The mark alone: the ant made of nodes. Black on paper, near-white #eceee9 at night | 27 × 27 | live: Cut from the lockup, so mark and lockup always match, centered in a 27 × 27 square; PNG at 1×, 2× and 4×. The site's favicon, ../assets/home/icons/ant-mark.svg, is the same drawing at 92 % in antseed.com's ink #001E12: favicon.svg replaces it | files/logo/antseed-mark-black.svg | files/logo/antseed-mark-near-white.svg | ../hero/ |  |
| logo-green | logo | antseed.com's green mark, #10B981 |  | retired: The logo is black and near-white only (decided 12 Nov); pending Antseed's agreement | archive only |  |  |  |
| logo-clay | logo | antseed.com's clay mark, #D79627, once kept for $ANTS and fees |  | retired: The logo is black and near-white only (decided 12 Nov); pending Antseed's agreement | archive only |  |  |  |
| logo-favicon | logo | Favicons: the mark as SVG (black, near-white when the system is dark), a 32 px PNG on transparent, the 180 px Apple touch icon and a 512 px icon, both on paper |  | spare: Made for the kit, not on the site yet: the site's favicon is still ../assets/home/icons/ant-mark.svg (index.html:32). In the icons on paper the mark is 60 % of the square's height | files/logo/favicon.svg |  |  |  |
| logo-avatar | logo | Profile picture: the white mark on the action green #4f7a24 | 400 × 400 | in-progress: Proposal, to approve. For social profiles; the mark is 60 % of the square's height, so a round crop keeps every node | files/logo/antseed-avatar-400.png |  |  |  |

<!-- assets:end -->

### Color

- Black `#000` on light. It is the site file's own fill (`assets/hero/logo.svg`).
- Near-white `#eceee9` on dark: the night text color (`--color-text` at night, `hero/sections.css:25`).
- Nothing else: no green, no gradient, no outline, no shadow. antseed.com's green mark `#10B981` and clay mark `#D79627` (once kept for $ANTS and fees) are retired, pending Antseed's agreement (decided 12 Nov).
- The $ANTS coin is green and carries the mark painted in white. It is an illustration, never a logo file.

### How it is built

Measured from `assets/hero/logo.svg`, in its own units. The file is 95.3464 × 33, so at the site's size 1 unit = 1 px; H is its height, 33.

| Part | Geometry | Source |
|---|---|---|
| Nodes (2 antennae, 6 legs) | 8 circles, radius 1.03 (diameter 2.06, 0.062 H). Centers: antennae (11.54, 2.49) and (21.43, 2.49); front legs (7.42, 9.09) and (25.55, 9.09); middle legs (5.77, 16.50) and (27.19, 16.50); back legs (6.60, 24.74) and (26.37, 24.74) | `logo.svg:10-17` |
| Head | Ellipse at (16.48, 9.09), 4.12 wide, 4.53 high | `logo.svg:18` |
| Thorax | Ellipse at (16.48, 14.85), 5.77 × 6.59 | `logo.svg:19` |
| Abdomen | Ellipse at (16.48, 22.68), 7.41 × 9.89 | `logo.svg:20` |
| Limbs | 8 straight bars with round ends, 0.74 thick (0.022 H) | `logo.svg:21-28` |

- Mirror-symmetric about x = 16.48.
- Body widths grow 4.12 : 5.77 : 7.41, about 1 : 1.4 : 1.8, head to abdomen. The head nearly touches the thorax (0.21 apart); the thorax overlaps the abdomen by 0.41.
- The front-leg nodes sit level with the head's center (y = 9.085). The middle-leg nodes sit on y = 16.5, the file's center line and the wordmark's.
- Reach from the axis: middle legs ±10.71, back ±9.89, front ±9.06, antennae ±4.94.
- A node's diameter (2.06) equals the stem of the E (70.666 to 72.728): the mark and the letters share one weight.

| Lockup | Units (H = 33) | Ratio to H |
|---|---|---|
| Mark | 23.48 × 26.16 (x 4.74 to 28.22, y 1.46 to 27.62) | 0.71 H × 0.79 H |
| Gap, mark to word | 4.74 | 0.14 H |
| ANTSEED | 62.38 wide, capitals 14.14 high (y 9.42 to 23.56) | 1.89 H wide, capitals 0.43 H |
| The drawing | 90.60 × 26.16 | 2.75 : 1 |
| The site's file box | 95.35 × 33: padding left 4.74, top 1.46, bottom 5.38, right 0 | 2.89 : 1 |
| The kit's files | The same drawing centered in 91 × 27 (lockup) and 27 × 27 (mark): 0.20 to the sides, 0.42 above and below | — |

The wordmark is a condensed, monoline, all-caps sans with square ends and rounded inner corners on S and D. Its typeface is not named anywhere. There is one lockup, horizontal: no stacked lockup, no wordmark alone.

### Clear space and minimum size (proposal)

- Minimum clear space: the height of the capitals, c, on every side (14.14 units, 0.43 H; 14 px at the site's size). Every current use clears it.
- Preferred, wherever there is room (banners, posters, slides): the width of the mark (23.48 units, 0.71 H), antseed.com's own rule, "room equal to the icon's width on every side".
- Nothing inside the clear space: no text, no button, no painting, no dotted line. The page's dotted outlines and dot matrix stay outside it.
- Smallest lockup: 66 px wide (the drawing 19 px high). Below it the limbs fall under half a pixel and the legs disappear.
- Smallest mark: 24 px. The 16 px favicon is the one exception: its limbs fall to 0.36 px.
- What the site does: the lockup at 91 px wide (its file at 95.3464 × 33) in the nav, a 69 px bar with 16 px side padding on frosted white glass (`hero/index.html:68-69`, `:418`); in the footer, first column (`hero/sections.html:401`). Nowhere else on the site.

### Never

- Straight on a painting, a dither, an LED mosaic or the dot matrix. The logo sits on paper or frosted glass, with its clear space: in the nav it is on glass; in the footer the painting starts below the words (`hero/footer.css:1-3`).
- Recolored, even in the brand's greens; with a gradient, outline, shadow or other effect. Two things look like exceptions and are not rules to copy: the proposed avatar (the one colored use, to approve) and the green lockup inside the Desktop app's captures, which is the app's own UI (DECISIONS.md K19).
- Stretched, squeezed, rotated or skewed; the mark and the word rearranged.
- At the center of a hub or network diagram: Antseed has no middleman, and nothing is drawn around a center.
- Given a face: the mark is not the mascot, which is a separate character.
- Redrawn, repainted or regenerated by an image model. Attach the file; never ask a model to draw the logo.
- As a pattern behind the logo. The mark may repeat as a pattern in posters only.

### Open items

- Clear space, minimum sizes and the avatar are proposals, to approve.
- Does the 16 px favicon need a heavier drawing?
- Which black is the master: the site's `#000` or antseed.com's `#001E12` (the site's favicon, `assets/home/icons/ant-mark.svg`, is the same drawing at 92 % in `#001E12`)?
- The wordmark's typeface and its original vector source, if Antseed has them.

## The dot

The page's title for this section, "The dot / is the ant.", is kit copy, to approve.

A dot that moves, queues, follows a trail and carries something is an ant seen from far away (Elio's statement of the brand, 12 Nov). So the margins are a matrix of dots, the outlines are rows of dots, the titles and figures are set in a pixel face made of dots, and every effect on the paintings is made of round dots on one 8px grid. When dots move, they move like ants. The dot is the link between the logo (an ant made of nodes, see Logo) and the type (made of dots, see Type).

Sources below are files of the live site (`hero/`, `main` ce969b4) with their line, and the lab's files under `lab/shader-lab/`.

### Rules

- **Round, never square. Dotted, never dashed.** Square pixels "just look pixelated" (D11). A dotted line is round dots: in CSS a strip of `radial-gradient` dots, in SVG a stroke with `stroke-dasharray: 0 <gap>` and round caps.
- **On the 8px grid.** The sky dither's 2px cells and the Private by design mosaic's 15.45px step are the only other pitches. The grid is measured on the board, before a template's scale: an X post drawn at 1.5625× shows it at 12.5px in the PNG.
- **Moving dots behave like ants.** They walk a cell at a time, mostly straight on, now and then a quarter turn; they queue, gather, follow and carry. Never a swarm, never free particles, never blur (D35: the green 3×3 clusters "look like something electronic").
- **An arrival or a touch, never wallpaper.** Dither and the LED matrix arrive, answer the cursor and go (D33). Dithered symbols laid over the paintings were tried and removed (D34).
- **Drawn in code or in the lab, never asked of an image model.** The paintings stay plain watercolor; the dots, dither, LED matrix and glass are added on top (PROMPTS.md, rule 3).
- **Touch gets no hover. With reduced motion, the finished still.**

### The grid

**The margin matrix** (Figma's "Trame"). A 2px round dot every 8px, one dot on the page's center line and one on its top edge.

```css
.page { background: var(--dots-matrix), var(--color-page-bg); }   /* components.css .ak-page */
/* = radial-gradient(circle at 4px 4px, #e2e2e2 .85px, #0000 1.25px) 50% -4px / 8px 8px, #fcfcfc by day;
     the same with #3d4340 on #0f1312 at night (sections.css:43, :12, :25) */
```

**The dotted outline.** An overlay 1px larger than the box, one strip of the same dots per side, the first dot on the corner; each side switched on by setting it to 2px (sections.css:56-66).

```css
/* <div class="ak-outline"> (components.css), or ak-outline--top / --right / --bottom / --left / --all */
.rail { --outline-top: 2px; --outline-right: 2px; --outline-bottom: 0px; --outline-left: 2px; }
/* one side, raw: radial-gradient(circle at 1px 1px, var(--color-dot) .85px, #0000 1.25px) 0 0 / 8px 2px repeat-x
   on a ::before with inset: -1px */
```

The rail draws its outline on the top, right and left, under its content, as Figma does (sections.css:67-68).

**Why the edges land on the dots.** The rail is a multiple of 16 wide and centered (sections.css:45), and the matrix has a dot on the center line, so the rail's edges fall on columns of dots. Every section is snapped to a multiple of 8 high (sections.js:61-64), so every section's top falls on a row of dots. In the margins the outline's dots sit on the matrix's own. Keep both when you build a page: a rail width in steps of 16, section heights in steps of 8.

**Other dotted lines on the site.** Private by design's top line: the same dots, 8px apart, 2px high, across the whole width (sections.css:591-592). The terminal's inner lines: dots in `rgba(150, 196, 150, .22)` (sections.css:248).

**Pixel type.** Geist Pixel's ELSH axis sets the dot: 20 (round dots) for eyebrows and figures, 40 (a grid of small dots) for section titles (sections.css:75, :82). See Type.

### The effects

All are drawn on a 2D canvas, never WebGL ("no GL context per panel", wash-led.js:14-15), with the device pixel ratio capped at 2; each stops off screen and in hidden tabs, and has a still for reduced motion. On the kit's page the LED arrival and the hover mosaic run on the site's own scripts; the sky dither and the dot-ants are ports of `dither.js` with the same numbers.

#### LED arrival (unveil.js, card-unveil.js)

The painting arrives as an LED display switching on. The panel is there first in its own plain color, with its text and windows; then the painting grows from the center in an oval, its moving edge breaking into round dots on the 8px grid, dense by the picture and thinning further out, and just inside the edge the painting comes in cell by cell as squares. It is drawn as a cover in the panel's color with holes cut in it, so the dots show the painting itself; at the end the cover is gone and the panel is exactly as before.

Where: the hero's painting, once at load; every landscape panel below it (Gateway, Desktop, the four points of Private by design, the providers' three, the network, $ANTS) as it comes into view, and a chosen point of Private by design each time it is chosen (card-unveil.js:1-10).

| Parameter | Value | Source |
|---|---|---|
| Grid | 8px | card-unveil.js:15, unveil.js:10 |
| Dot radius | 0.42 × the pitch | card-unveil.js:16 |
| Fringe | 0.34 of the oval's radius (1 reaches the corners) | card-unveil.js:17 |
| Cell-by-cell part | the inner 0.22 of the fringe, as squares | card-unveil.js:18, :56 |
| A dot's chance | `e^1.6`, e its place across the fringe | card-unveil.js:57 |
| Panels | 150ms, then 1500ms; 160ms between panels arriving together | card-unveil.js:19 |
| Hero | 100ms, then 1500ms; inside the oval the painting fades up from the hero's color over the first 55% | unveil.js:14-15, :41-46 |
| Easing | cubic out, `1 − (1 − t)³` | card-unveil.js:20 |
| Trigger | a third of the panel in view, once | card-unveil.js:102 |
| Randomness | a fixed hash per cell, the same on every load | card-unveil.js:21 |

The windows on a panel wait hidden, then pop in as the painting starts to grow: from .9 and faded, opacity 0.55s ease-out, scale 0.9s `cubic-bezier(.2, .9, .25, 1.12)` (sections.css:116-117; components.css `.ak-window--pop`). The painting for the current theme is decoded before the cover lifts, and a theme flip mid-arrival recolors the cover (card-unveil.js:24-30, :111-112). Reduced motion and still captures (`?still`, `?demo`): not played (card-unveil.js:10-13).

#### Hover mosaic (wash-led.js)

Under a mouse the painting breaks up locally into the lab's LED mosaic: round dots on the same 8px grid, each in its cell's own color, the paper coming up around them toward the trail's heart; at the trail's edge the painting comes back cell by cell as flat squares. The trail fades within half a second or so and the painting is whole again (wash-led.js:1-6).

| Parameter | Value | Source |
|---|---|---|
| Grid, dot | 8px, radius 0.42 × the pitch | wash-led.js:17-18 |
| Reach | 88px around the pointer | wash-led.js:19 |
| Fade | the trail halves every 0.3s: `0.5^(dt / 0.3)` a frame | wash-led.js:20, :180 |
| Levels | a flat square from 0.46, a dot from 0.5 with the paper coming up around it until 0.8, bare paper from 1.06 | wash-led.js:21, :146-150 |
| Paper | `#ffffff` by day, `#181d1b` at night (the rail) | wash-led.js:22 |
| Color | as the lab's "Hero → LED mosaic": contrast 1.1, saturation 1.2; at night lifted 12% toward white, as LEDs on dark paper | wash-led.js:30-34, :107 |
| Edge | a hash per cell plus value noise, so the edge is ragged | wash-led.js:25-29, :109 |
| Trail | a soft disc laid every half cell between pointer samples | wash-led.js:114-131 |

A mouse only, never on touch, never with reduced motion, and not before the panel has arrived (wash-led.js:164-166, :187). It is drawn on the painting under everything in the panel: the windows show it through their frost, never drawn on the glass (wash-led.js:46-51). Every landscape panel has it except the network's.

#### Sky dither (dither.js, part 1)

Fine pale points gather at the edges of the hero film's clouds, read from the film itself and mixed from the paint under them: the technical layer inside the painting. By day only: at night the hero's painted night covers the sky (index.html:350-353).

| Parameter | Value | Source |
|---|---|---|
| Cell | 2px, each masked to a round dot of radius .86px with a .14px soft edge | dither.js:9, dither.css:3-5 |
| Order | thresholds from an R2 low-discrepancy sequence; a Bayer matrix, at these densities, draws little crosses | dither.js:10-11 |
| Where | the top half of the film (`SKY_END = 0.5`), gathering 3 cells around a cloud (`HALO`), clusters 0.72 full (`DENSITY`) | dither.js:20 |
| Color | the film's color mixed 70% toward `(255, 251, 238)`, alpha 165/255 | dither.js:110 |
| Wind | `0.9 + 0.1·sin(x·0.017 − t·0.8) + 0.05·sin(x·0.043 + t·0.5)` | dither.js:121 |
| Pointer | lifts points within 90 cells, easing in and out at 0.32 a frame | dither.js:98, :119 |
| Calm | behind the title and install block the points drop by 55%, within 110px across and 70px down | dither.js:78-85, :105 |
| Rate | 12 frames a second, the film read every third | dither.js:118, :128 |
| Arrival | fades in over 0.6s ease-out, as the hero starts | dither.css:7-8, dither.js:146-147 |

Reduced motion: drawn once, still (dither.js:121, :126).

#### Dot-ants (dither.js, part 3)

The literal dots-are-ants moment: single lime dots walk the Private by design mosaic as ants, with a short trail; a click on the background calls the nearest ones. The mosaic is Figma's dot mosaic (`assets/home/privacy-dots.svg` and `-dark.svg`: 13px dots 15.45px apart round the edges of a 1504 × 832 frame), drawn small, its top half laid from the section's top and its bottom half from its bottom (sections.css:576-580, dither.js:169-179). The section keeps its night gray, `#181d1b`, by day too (sections.css:17).

| Parameter | Value | Source |
|---|---|---|
| Mosaic | 15.45px step, dots 2.4px in radius | dither.js:156 |
| Ant | 1.9px in radius, `#c8f53c`, glowing `rgba(200, 245, 60, .55)` blurred 6px | dither.js:156-157, :255 |
| How many | `round(clamp(W·H / 160000, 4, 10))`: 8 on a laptop, 4 on a phone | dither.js:191 |
| Life | 18 to 40s each, fading in and out over 1s, then in again elsewhere | dither.js:196-199, :246 |
| Walk | a cell every 120 to 200ms, 70% straight on, otherwise a quarter turn; smoothstep from cell to cell | dither.js:211-213, :248 |
| Trail | the last 3 cells crossed tinted at 0.3, 0.21 and 0.12 | dither.js:203, :249 |
| Called | a click calls up to 6 within 720px: 70 to 100ms a cell toward it (85% of steps), 160 to 240ms milling about it, released after 5 to 6.5s | dither.js:157, :206-209, :234-238 |
| Twinkle | 2% of the dots, each over 3 to 6s to a peak of 0.6 to 0.9; a fifth near-white `#f4fbe2`, the rest lime | dither.js:182, :227 |
| Cursor | warms the dots within 110px, a quarter lit at most, cooling ×0.9 a frame | dither.js:229-233 |
| Clear of the title | the ants fade within 40px across and 32px down of the eyebrow, title and sub, over 28px | dither.js:187-190, :200 |
| Rate | about 30 frames a second | dither.js:223 |

Reduced motion: the mosaic only, no twinkle and no ants (dither.js:193, :221).

### Posters and stills

- The lab (`lab/`) draws the same dots, dither, halftone and LED mosaic on a poster. Its ant dots come in four modes (trame, network, ants, colony) and six shapes (full, band, column, circle, frame, blob); the grid defaults to a pitch of a 90th of the width (12 at 1080) and a dot 0.28 of the pitch; seeds carried by its ants are `#b86746` by day and `#ffb347` at night (lab dots.js:9-11, :66-67, :79).
- The lab sets the opacity of a poster's dots and lines by its paper so they read the same on any of them: 0.15 on white is the reference, about 0.23 on the night and about 0.33 on the mid greens (lab palettes.js:21-32, `seenAlpha`).
- Exported to SVG or Figma, its dotted lines stay strokes with round caps, a 0 dash and a gap of the pitch (lab dots.js:207).

### In progress, do not extrapolate

The network board is on hold. Its dotted line today: your lookup, a stroke 3.5 wide with round caps and a dot every 8 (`stroke-dasharray: 0 8`, sections.css:467).

### Every dot token

<!-- tokens:start dots -->

**dots** — Use for UI and effects. The dot is the ant: round, never square; dotted, never dashed; on the 8px grid. Effects made of dots (LED reveal, hover mosaic, dither) are drawn in code or the lab, never asked of an image model.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| pitch | `8px` | `--dots-pitch` | One dot every 8px, everywhere. | 8px | hero/sections.css:43; hero/unveil.js:10 |
| matrix | `radial-gradient(circle at 4px 4px, #e2e2e2 .85px, #0000 1.25px) 50% -4px / 8px 8px` | `--dots-matrix` | The margin matrix (Figma's "Trame"): a 2px round dot every 8px, one on the page's centre line and one on its top edge. Set it as a background over the page colour. | .s-page background | hero/sections.css:41-43 |
| outline | `radial-gradient(circle at 1px 1px, #e2e2e2 .85px, #0000 1.25px)` | `--dots-outline` | One dot of a dotted outline: laid in strips 8px apart on each side that is switched on (components.css .ak-outline). | --d | hero/sections.css:56-66 |
| led-dot | `0.42` | `--dots-led-dot` | LED matrix (the painting's arrival and the hover mosaic): a dot's radius, times the 8px pitch. | DOT | hero/unveil.js:11; hero/card-unveil.js:16 |
| hover-reach | `88px` | `--dots-hover-reach` | The hover mosaic's reach around the pointer. Mouse only, never on touch. | RADIUS | hero/wash-led.js:19 |
| hover-half-life | `300ms` | `--dots-hover-half-life` | How fast the hover mosaic's trail fades. | HALF_LIFE | hero/wash-led.js:20 |
| sky-cell | `2px` | `--dots-sky-cell` | The hero sky's dither: 2px cells, ordered by an R2 sequence, not a Bayer matrix (which draws little crosses). | HERO_CELL | hero/dither.js:9-11 |
| ant-radius | `1.9px` | `--dots-ant-radius` | A dot-ant: a round acid dot that walks the grid a cell at a time. | ANT_R | hero/dither.js:156 |
| ant-ink | `#c8f53c` | `--dots-ant-ink` | The dot-ants' colour, with a glow rgba(200, 245, 60, .55) blurred 6px. | ANT_INK | hero/dither.js:157, :255 |
| mosaic-pitch | `15.45px` | `--dots-mosaic-pitch` | The Private by design mosaic's step; its dots 2.4px in radius. | PRIV_STEP | hero/dither.js:156 |

<!-- tokens:end -->

### Motion

Motion keeps to the dot: words come first, arrive once at most and then hold still; paintings, dots and characters arrive around them, once. This is the kit's one place for motion (Building blocks points here). The values below are the site's; the kit names them as tokens (`--ease-*`, `--dur-*`, tokens.css). Every effect, one by one, with its trigger and its still: `reference/#motion`.

#### Principles

1. **Words first.** Text is readable from the first frame, never from a blank start, never assembled from dots. The pill, the H1 and the install block may fade up once from .94 (opacity .55s ease-out, scale .9s on `--ease-window`, at 0, 80 and 180ms), then they hold still (index.html:248-255; D80, Elio, 12 Nov). Paintings, dots and characters arrive around the words, never before them (index.html:40-41; Amos's review, 11 Nov).
2. **Motion is made of dots on a grid.** Reveals, hovers, trails, network lines and ants are round dots on fixed pitches (2, 8, 15.45px). They move cell to cell, never as free particles or blur.
3. **Ants behave like ants.** Mostly straight on, now and then a quarter turn; they pause, queue, keep their distance, follow a leader, carry pieces, answer a call, then go back to wandering.
4. **Painted, not puppeted.** Character motion comes from painted frames and poses, re-rendered when a pose is missing, stepped at about 12 drawings a second like the films. Code only adds cartoon physics on top: a hop, a squash on landing, a lean, a toss with a wind-up, breathing. The hero's rig is a documented exception.
5. **Small amplitudes.** Lifts of 2 to 24px, scales from .9 or .98 to 1, turns of 9° at most; overshoot only on small confirmations (checks and badges) and on windows.
6. **Arrive once, loop only while seen.** Entrances play once at 20 to 35% in view; loops pause off screen and in hidden tabs; heavy media load only when they will be seen.
7. **Four curves do the work.** Arrive for arrivals, slide for state changes and sliding controls, pop for small confirmations, window for a window or a title fading up on its painting; linear only for continuous travel.
8. **Day to night is light moving through the painting.** A 0.6s page crossfade over painting changes of 1.2 to 1.8s, with a direction that means something: the night comes down from the sky and closes toward the sun. Never on load.
9. **Technical motion is precise and honest.** Real keystrokes, real states captured from the app, live figures counting to their true value. No fake progress.
10. **No center.** Network motion is many to many, on independent clocks; nothing flows into or out of a hub.
11. **Reduced motion means the finished picture.** Every effect has a complete, readable still; `?still` and `?demo` give the same for captures.
12. **Touch gets no hover; phones get fewer pieces, not another story.**
13. **Cheap by construction.** 2D canvas, 12, 30 or 60 frames a second by need, writes only on change, device pixel ratio capped at 2.

#### Curves

| Curve | Token | Value | Use | Source |
|---|---|---|---|---|
| Arrive | `--ease-arrive` | `cubic-bezier(.2, .7, .2, 1)` | Blocks rising into view, menus and rows coming in | sections.css:680 |
| Slide | `--ease-slide` | `cubic-bezier(.65, 0, .35, 1)` | State changes: tab thumbs and panels sliding | sections.css:147 |
| Pop | `--ease-pop` | `cubic-bezier(.3, 1.6, .5, 1)` | Small confirmations only: a check, a badge | micro.css:95 |
| Window | `--ease-window` | `cubic-bezier(.2, .9, .25, 1.12)` | A window popping in on its painting; the hero's words fading up | sections.css:117; index.html:250 |
| Linear | — | `linear` | Continuous travel only | — |

In scripts: cubic out `1 − (1 − t)³` for the LED arrivals (card-unveil.js:20); exponential out `1 − 2^(−10k)` for figures (count.js:8); smoothstep `t²(3 − 2t)` for an ant crossing a cell (dither.js:248); `0.5^(dt / half-life)` for trails fading (wash-led.js:180).

#### Duration bands

| Band | Range | Token | On the site |
|---|---|---|---|
| Feedback | 150–250ms | `--dur-feedback` 150ms | Hover colors 0.15s (sections.css:92), taps, a tooltip's fade |
| Controls | 350–450ms | `--dur-control` 350ms | Tab thumbs and panels 0.35s (sections.css:147), toggles, menus |
| Blocks | 500–900ms | `--dur-block` 600ms | Blocks rising: opacity 0.6s, transform 0.7s, panels 0.8s (sections.css:681-684); the theme's crossfade 0.6s (index.html:349) |
| Paintings | 1.2–2.2s | `--dur-painting` 1500ms, `--dur-count` 2200ms | The LED arrival 1.5s, the night coming down 1.2s (index.html:356), the footer's night 1.8s (footer.css:26), the count-up 2.2s (count.js:7) |

#### Pieces

- **Blocks rising.** 20px and faded in: opacity 0.6s, transform 0.7s, the arrive curve, 50ms between blocks arriving together; a big panel rises 24px from `scale(.98)` over 0.8s (sections.css:680-684).
- **Tabs.** The thumb slides with `transform .35s, width .35s` on the slide curve (sections.css:147).
- **Checks and badges.** From `scale(.7)` and faded: opacity 0.25s, transform 0.35s on the pop curve, after .35s (micro.css:95-96, the Signed badge).
- **Windows on a painting.** From `scale(.9)` and faded: opacity 0.55s ease-out, scale 0.9s on the window curve, as the painting starts to grow round them (sections.css:116-117). The hero's pill, H1 and install block do the same from .94, in turn (index.html:248-255).
- **The count-up.** A live figure counts once to its true value when a third of it is in view: 2.2s, exponential out, "most of the way in the first third, then a long settle". The number is parsed from its text with its prefix and suffix ("Epoch 30"), keeping decimals and grouping; a live value arriving before or during the count becomes its end. With reduced motion the text is written at once (count.js:1-8, :31-35).
- **Day and night.** The page crossfades over 0.6s ease-in-out (index.html:349); the hero's night comes down from the sky with a 25% soft front over 1.2s ease-in-out (index.html:350-356); the footer's night closes toward the sun over 1.8s `cubic-bezier(.55, 0, .25, 1)` (footer.css:26); every painted ant takes the night filter over 1.2s (index.html:197-198). An instant swap with reduced motion.

#### Reduced motion, piece by piece

The end state, complete and readable, with nothing looping: the hero's opening and arrival never start and its film stays a poster; the theme switch cuts; landscape panels show their painting at once and have no hover mosaic; the sky dither and the mosaic are drawn once, still, with no ants; figures are written at once; sections do not rise; the terminal is printed in full; the network shows one composed still. On this kit's own page, the loops that run on the site (the terminal's cursor, the amazed ant's pupils) also stop after five seconds and whenever they are off screen; pointing at them plays them again, as a page of reference should (WCAG 2.2.2). The site keeps them running. The dot-ants demo shows a few ants still.

#### Every motion token

<!-- tokens:start motion -->

**motion** — Use for UI. Three curves do most of the work; four duration bands. Words first and still; arrive once; with reduced motion the finished still shows.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| ease-arrive | `cubic-bezier(0.2, 0.7, 0.2, 1)` | `--ease-arrive` | Arrivals: blocks rising into view, menus and rows coming in. | --rv-ease | hero/sections.css:680 |
| ease-slide | `cubic-bezier(0.65, 0, 0.35, 1)` | `--ease-slide` | State changes: tab lines and thumbs sliding, panels swapping. | cubic-bezier(.65, 0, .35, 1) | hero/sections.css:147 |
| ease-pop | `cubic-bezier(0.3, 1.6, 0.5, 1)` | `--ease-pop` | Small confirmations only: a check, a badge (strong overshoot). | cubic-bezier(.3, 1.6, .5, 1) | hero/micro.css:95 |
| ease-window | `cubic-bezier(0.2, 0.9, 0.25, 1.12)` | `--ease-window` | A window popping in on its landscape (scale .9 to 1, slight overshoot). | cubic-bezier(.2, .9, .25, 1.12) | hero/sections.css:117 |
| dur-feedback | `150ms` | `--dur-feedback` | Feedback band, 150 to 250ms: hovers, taps. | .15s | hero/sections.css:92 |
| dur-control | `350ms` | `--dur-control` | Controls band, 350 to 450ms: tabs, toggles, menus. | .35s | hero/sections.css:147 |
| dur-block | `600ms` | `--dur-block` | Blocks band, 500 to 900ms: sections rising, the page's theme crossfade. | .6s | hero/sections.css:681; hero/index.html:349 |
| dur-painting | `1500ms` | `--dur-painting` | Paintings band, 1.2 to 2.2s: the LED arrival of a painting, the night coming down. | DURATION | hero/unveil.js:14; hero/card-unveil.js:19 |
| dur-count | `2200ms` | `--dur-count` | A figure counting up to its live value once, exponential ease-out (1 - 2^-10k). | MS | hero/count.js:7-8 |
| stagger | `50ms` | `--motion-stagger` | Between blocks arriving together. | calc(var(--i) * 50ms) | hero/sections.css:681 |
| rise | `20px` | `--motion-rise` | How far a block rises as it comes into view (panels 24px from scale .98). | translateY(20px) | hero/sections.css:682, :684 |

<!-- tokens:end -->

## Type

Three families from one project: **Geist Pixel** for titles, eyebrows and figures, **Geist** for words, **Geist Mono** for code and prices. The display face was picked to look like a row of pixels, like the page's dots (D37). Its one axis, ELSH (element shape), sets the shape of every dot in a letter. On the kit's page this section is titled "Set in Geist. Made of dots." (kit copy, to approve).

Sources: `file:line` is on the live site (`hero/`, main ce969b4); the tokens are in `tokens.json`, tier `type`.

### Families

| Family | Use | Weights | Where it comes from | License |
|---|---|---|---|---|
| Geist Pixel | Titles, eyebrows, key figures | 400 | Self-hosted variable file `GeistPixel-VariableFont_ELSH.ttf` (3,656,708 bytes), declared as `"Geist Pixel Var"` (index.html:49-50; tokens.css). Google Fonts' plain `family=Geist+Pixel` request serves only the solid shape | SIL OFL 1.1, "Copyright 2026 The Geist Project Authors"; ship `OFL.txt` with it |
| Geist | Body, ledes, subs, buttons, labels, links | 400, 500 | Google Fonts: `family=Geist:wght@400;500`, plus `&text=%E2%86%92%E2%86%97` for the arrows → ↗, which the latin subset leaves out (sections.css:6) | SIL OFL 1.1 |
| Geist Mono | Commands, prices, the terminal, technical captions | 400, 500 | Google Fonts: `family=Geist+Mono:wght@400;500` (sections.css:4) | SIL OFL 1.1 |

Downloads on the page: the variable TTF (`../assets/fonts/GeistPixel-VariableFont_ELSH.ttf`) and its license (`files/fonts/OFL.txt`). In the kit zip: `fonts/`. Static instances at ELSH 11, 20 and 40 for Figma and Slides: **to make** (each needs its own family name, so the three install side by side).

### The ELSH axis

ELSH runs from 0 to 100, default 0. The font's named instances: Regular 0, Square 1, Circle 20, Grid 40, Triangle 60, Line 80.

| ELSH | Looks like | Used for | Source |
|---|---|---|---|
| 1 | Solid square pixels, joined | Nothing on the page. The smallest figures sit nearest this end | sections.css:402-403 |
| 11 | Square pixels with softened corners | The H1 | index.html:96-97 |
| 20 (Circle) | Round dots | Eyebrows and key figures | sections.css:82; index.html:205 |
| 40 (Grid) | Small separated square dots | Section titles | sections.css:75 |

Set it with `font-variation-settings: "ELSH" 40;`. The site's rule: the rounder the dots, the more ink they lose, so the smaller a figure, the nearer the square end (1) it sits, to stay readable (sections.css:402-403).

### Roles

Desktop values; the phone values switch at 760px and below (tokens.css does it). Use the tokens, never the numbers.

| Role | Spec | CSS | Source |
|---|---|---|---|
| H1 | Geist Pixel ELSH 11, 90/93, −0.08em, opacity .82, centered; two lines, the second in the H1 gray `--color-h1-second` (#595959 by day, #9ba49e at night, as the site; not the section titles' #929292, which gives 2.43:1 at .82); no full stop. Tablet 8.4vw/1.04, phones 46/50 | `.ak-h1`, or `font: var(--type-h1); letter-spacing: var(--type-h1-tracking); font-variation-settings: "ELSH" var(--type-h1-elsh); opacity: var(--type-h1-opacity);` | index.html:53, :96-100, :309 |
| Section title | Geist Pixel ELSH 40, 48/46, −2px; the second half gray; a full stop. Phones 34/36, −1.4px | `.ak-title`, or `font: var(--type-section-title); letter-spacing: var(--type-section-title-tracking); font-variation-settings: "ELSH" var(--type-section-title-elsh);` | sections.css:75, :78, :758 |
| Eyebrow | Geist Pixel ELSH 20, 18/27, green text, then a non-breaking space and ›. A link, usually to the docs | `.ak-eyebrow` | sections.css:82 |
| Figure | Geist Pixel ELSH 20, 30/30, tabular; large 40/44 (32/36 at 899px and below). Phones 26/26. Read live before use | `font: var(--type-figure); font-variation-settings: "ELSH" var(--type-figure-elsh); font-variant-numeric: tabular-nums;` | index.html:205; sections.css:571-572 |
| Lede | Geist 400, 26/36, −0.01em. Phones 20/28 | `.ak-lede` | sections.css:128 |
| Sub | Geist 400, 18/27, in `--color-text-body`. Phones 16/24 | `.ak-sub` | sections.css:79, :760 |
| Body, feature line, caption | Geist 400, 16/24; a caption's name in 500, in the text color | `.ak-body` | sections.css:237, :416-417 |
| Button | Geist 500, 15/20, 44 high, sentence case | `.ak-btn` | sections.css:91 |
| Price | Geist Mono 400, 12.5/16; the unit in small print | `font: var(--type-mono-price);` | sections.css:178-179 |
| Small | Geist 400, 12/16, tabular | `font: var(--type-small);` | sections.css:180 |

A two-tone title in HTML:

```html
<h2 class="ak-title">An API key <span>for every agent.</span></h2>
<h1 class="ak-h1">The open <span>intelligence network</span></h1>
```

### Rules

- Only Geist Pixel, Geist and Geist Mono. Weights 400 and 500: nothing else is loaded, so a `<b>` or a 600 would be a synthetic bold (sections.css:611).
- Titles in two tones: a strong first half, then the second half in `--color-text-grey`. Section titles end with a full stop; the H1 does not.
- Sentence case everywhere. No uppercase labels.
- Negative tracking only on the pixel display sizes (H1 −0.08em, titles −2px) and the lede (−0.01em).
- Tabular figures for every figure (`font-variant-numeric: tabular-nums`).
- The smaller a pixel figure, the nearer ELSH 1 it sits.
- Figures are read live (from AntSeedStats or the site's own data) before use, dated and credited. Never type a figure from memory.

### Title maker (on the page)

The page's Type section makes a two-tone title in Geist Pixel and exports it:

- **SVG, outlined.** Plain paths, no font needed: Figma, Slides, Keynote, Illustrator. The outlines are read in the browser from the variable file itself (its glyph outlines, moved along the ELSH axis by the font's variation data), so any value from 0 to 100 works, not only the named instances. Each letter sits where the browser lays out the same text, kerning and tracking included; checked against the browser's own rendering at ELSH 0, 1, 11, 20, 30, 40, 55, 70 and 100, where the two match to the pixel.
- **PNG, transparent, at 4×.** Drawn from the same paths.
- Options: the first half and the gray half; the style (section title: ELSH 40, 48/46, −2px; or H1: ELSH 11, 90/93, −0.08em, opacity .82, centered, two lines); any ELSH; day (#30382c and #929292) or night (#eceee9 and #9ba49e); a transparent background or the rail's color (#ffffff by day, #181d1b at night); the gray half on its own line or not.
- An agent driving the page can call `kit.titleSvg({ first, second, role: 'title' | 'h1', elsh, theme: 'day' | 'night', fill, breakLine })`, which resolves to the SVG text, or `kit.titlePng(options, scale)`, which resolves to a PNG blob.

### Google Slides

Not yet checked in Slides.

1. Geist Pixel, if Slides lists it under More fonts. It is on Google Fonts with its axis, but Slides is expected to show only the solid shape (ELSH 0), without the dots.
2. Otherwise **Doto** at 600, or 700 on a dark slide (Google Fonts, OFL). It reads as separated dots, close to Grid. It is about 1.19× wider: set it about 15% smaller than Geist Pixel would be, two short lines at most.
3. Or the title as an image, from the title maker.

Geist falls back to **Inter**; Geist Mono to **JetBrains Mono**. Avoid Instrument Sans as a fallback: it is the old system's face.

### Site leftovers

- **Instrument Sans** is still on the hero's buttons, install block and media tabs (index.html:76, :112, :135; sections.css:149). Retired in the kit: use Geist 500.
- **Figtree** is still on the announcement pill (index.html:91). Retired in the kit: use Geist 400.
- **Satoshi** sits in the site's font folder, used by no page, "All rights reserved". Never ship it.
- The site's `index.html:47` also loads Geist Pixel's static Google request and ABeeZee, for an old variant only.

### Every type token

<!-- tokens:start type -->

**type** — Use for UI. Three families, weights 400 and 500 only, sentence case, tabular figures. Negative tracking only on the pixel display sizes and the lede.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| font.sans | `"Geist", system-ui, sans-serif` | `--font-sans` | Geist: body, ledes, buttons, labels. Google Fonts, OFL 1.1. Load: https://fonts.googleapis.com/css2?family=Geist:wght@400;500&display=block, plus the arrows subset family=Geist:wght@400;500&text=%E2%86%92%E2%86%97 (Google's latin subset leaves out the arrows). Kit merge: Instrument Sans and Figtree, site leftovers, are folded into Geist. | Geist | hero/sections.css:40, :6; hero/index.html:47 |
| font.mono | `"Geist Mono", ui-monospace, monospace` | `--font-mono` | Geist Mono: commands, prices, the terminal, technical captions. Google Fonts, OFL 1.1. Load: https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&display=block | Geist Mono | hero/sections.css:4, :87 |
| font.pixel | `"Geist Pixel Var", "Geist", sans-serif` | `--font-pixel` | Geist Pixel, variable on its ELSH axis (element shape, 0 to 100), self-hosted from GeistPixel-VariableFont_ELSH.ttf under the family name "Geist Pixel Var" (tokens.css declares it). Titles, eyebrows, figures. OFL 1.1. Google Fonts' plain family=Geist+Pixel request serves only the solid shape. | "Geist Pixel Var" | hero/index.html:50; hero/sections.css:75 |
| weight.regular | `400` | `--weight-regular` | Text, titles, figures. | 400 | hero/sections.css:79 |
| weight.medium | `500` | `--weight-medium` | Buttons, names, links. The only other weight: nothing is loaded at 600 or 700, so a <b> would be a synthetic bold. | 500 | hero/sections.css:91, :611 |
| elsh.square | `1` | `--elsh-square` | Geist Pixel's Square instance: solid pixels. Not used on the page; the smaller a figure, the nearer this end it sits. | Square | GeistPixel-VariableFont_ELSH.ttf fvar; hero/sections.css:402-404 |
| elsh.h1 | `11` | `--elsh-h1` | The H1's shape: square pixels with softened corners. | "ELSH" 11 | hero/index.html:97 |
| elsh.circle | `20` | `--elsh-circle` | Round dots: eyebrows and key figures. | --eb-elsh, --fig-elsh | hero/sections.css:82; hero/index.html:205 |
| elsh.grid | `40` | `--elsh-grid` | Small separated dots: section titles. | "ELSH" 40 | hero/sections.css:75 |
| h1 | `400 90px/93px "Geist Pixel Var", "Geist", sans-serif, tracking -0.08em, ELSH 11, opacity 0.82; (max-width: 1023px) and (min-width: 761px): 8.4vw/1.04; (max-width: 760px): 46px/50px` | `--type-h1` | The display title: Geist Pixel ELSH 11, two tones (the text color, then the H1 grey #595959, #9ba49e at night), centered, opacity .82, no full stop. Tablet 8.4vw/1.04, phone 46/50. | h1 | hero/index.html:97-99, :100, :211 |
| section-title | `400 48px/46px "Geist Pixel Var", "Geist", sans-serif, tracking -2px, ELSH 40; (max-width: 760px): 34px/36px, tracking -1.4px` | `--type-section-title` | Section title: Geist Pixel ELSH 40, two halves, the second in text-grey, ending with a full stop. Phones 34/36, -1.4px. | .s-h2, .s-h3 | hero/sections.css:75, :78, :758 |
| eyebrow | `400 18px/27px "Geist Pixel Var", "Geist", sans-serif, ELSH 20` | `--type-eyebrow` | Eyebrow over a title: Geist Pixel ELSH 20 (16px × 1.125, line 1.5), green text, then a non-breaking space and ›. A link, usually to the docs. | .s-eyebrow | hero/sections.css:80-83 |
| figure | `400 30px/30px "Geist Pixel Var", "Geist", sans-serif, ELSH 20, tabular-nums; (max-width: 760px): 26px/26px` | `--type-figure` | A key figure under its label: Geist Pixel ELSH 20, tabular. Phones 26/26. Read live before use. | .backers b | hero/index.html:205, :213 |
| figure-large | `400 40px/44px "Geist Pixel Var", "Geist", sans-serif, ELSH 20, tabular-nums; (max-width: 899px): 32px/36px` | `--type-figure-large` | A large figure ($ANTS): Geist Pixel ELSH 20, tabular. 32/36 at 899px and below. | .s-ants.figs b | hero/sections.css:571-572, :724, :787 |
| figure-name | `400 24px/28px "Geist Pixel Var", "Geist", sans-serif, ELSH 20` | `--type-figure-name` | A point's name in pixel type ($ANTS points): ELSH 20. | .s-ants b | hero/sections.css:571 |
| lede | `400 26px/36px "Geist", system-ui, sans-serif, tracking -0.01em; (max-width: 760px): 20px/28px` | `--type-lede` | The lede: Geist 400, the only text size with negative tracking. Phones 20/28. | .s-lede | hero/sections.css:128, :763 |
| sub | `400 18px/27px "Geist", system-ui, sans-serif; (max-width: 760px): 16px/24px` | `--type-sub` | The line under a title, in text-body. Phones 16/24. | .s-sub | hero/sections.css:79, :760 |
| body | `400 16px/24px "Geist", system-ui, sans-serif` | `--type-body` | Body, feature lines, captions. | .s-feats li, .s-cap | hero/sections.css:237, :416 |
| body-strong | `500 16px/24px "Geist", system-ui, sans-serif` | `--type-body-strong` | A name at the start of a caption, in the text colour. | .s-cap b | hero/sections.css:417 |
| link | `500 16px/24px "Geist", system-ui, sans-serif` | `--type-link` | A standalone link in green text: → to the docs and the page, ↗ to other sites. | .s-link | hero/sections.css:80 |
| button | `500 15px/20px "Geist", system-ui, sans-serif` | `--type-button` | Button label, sentence case. | .s-btn | hero/sections.css:91-92 |
| card-name | `500 15px/20px "Geist", system-ui, sans-serif; (max-width: 760px): 14px/18px` | `--type-card-name` | A model's name on its price card, two lines at most. Phones 14/18. | .s-mcard b | hero/sections.css:176, :767 |
| footer | `400 14px/20px "Geist", system-ui, sans-serif` | `--type-footer` | Footer links and legal line. | .s-foot .col | hero/sections.css:657 |
| label | `400 13px/16px "Geist", system-ui, sans-serif` | `--type-label` | A figure's label, over its value. | .backers p | hero/index.html:204 |
| small | `400 12px/16px "Geist", system-ui, sans-serif, tabular-nums` | `--type-small` | Small print and counts, tabular. | .s-mcard .prov | hero/sections.css:180 |
| pill | `400 12px/16px "Geist", system-ui, sans-serif` | `--type-pill` | The announcement pill. The site sets it in Figtree 12/16; kit merge: Geist. | .pill (Figtree) | hero/index.html:91 |
| mono-price | `400 12.5px/16px "Geist Mono", ui-monospace, monospace` | `--type-mono-price` | A price; its unit in text-small. | .s-mcard code | hero/sections.css:178-179 |
| mono-saving | `500 14px/20px "Geist Mono", ui-monospace, monospace` | `--type-mono-saving` | A saving on a price card, in green text. | .s-mcard em | hero/sections.css:175 |
| mono-caption | `400 12.5px/18px "Geist Mono", ui-monospace, monospace` | `--type-mono-caption` | A technical caption, lowercase, in green text. | .s-ants .cap | hero/sections.css:573 |
| terminal | `400 11.475px/20.06px "Geist Mono", ui-monospace, monospace` | `--type-terminal` | Terminal text. | .term | hero/sections.css:250 |
| terminal-title | `400 10.2px/17.85px "Geist Mono", ui-monospace, monospace, tracking .2px` | `--type-terminal-title` | The terminal's window title. | .t-title | hero/sections.css:256 |
| terminal-tag | `400 9.35px/16.4px "Geist Mono", ui-monospace, monospace, tracking .56px` | `--type-terminal-tag` | A pane's tag, top right. | .t-tag | hero/sections.css:259 |

<!-- tokens:end -->

## Colour

Green is action, acid is light. Both were kept on purpose (D40); where they could meet, in the dark hero, only the button stays green (D18). Everything else is ink, grays and paper, and at night the same roles turn green-black (D44). On the kit's page this section is titled "Two greens, one job each." (kit copy, to approve).

Sources: `file:line` is on the live site (`hero/`, main ce969b4); the tokens are in `tokens.json`, tiers `core` (use freely) and `theme` (the same names by day and by night). Use the variables, never the hex: `tokens.css` swaps the themed ones under `[data-theme="dark"]` and `prefers-color-scheme`.

### The colors, day and night

| Role | Day | Night | Variable | Source |
|---|---|---|---|---|
| Green, action: every primary button's fill, in both themes | `#4f7a24` | `#4f7a24` | `--color-green` (buttons: `--color-button-fill`) | sections.css:15 |
| Green text: text, links, eyebrows, focus rings | `#4f7a24` | `#98c463` | `--color-green-text` | sections.css:12, :25 |
| Acid, light on dark ("lime" in conversation) | `#c8f53c` | `#c8f53c` | `--color-acid` | sections.css:35 |
| Ink, the darkest text: commands, text inside product scenes | `#0a1a12` | none | `--color-ink` | sections.css:35; index.html:54 |
| Text, and the first half of every title | `#30382c` | `#eceee9` | `--color-text` | sections.css:12, :25 |
| Title gray, the second half of every title | `#929292` | `#9ba49e` | `--color-text-grey` | sections.css:12, :25 |
| Body | `#56656f` | `#9ba49e` | `--color-text-body` | sections.css:12, :25 |
| Small print | `#66746b` | `#9ba49e` | `--color-text-small` | sections.css:12, :25 |
| Page, the margins under the dot matrix | `#fcfcfc` | `#0f1312` | `--color-page-bg` | sections.css:15, :26 |
| Rail, the paper the content sits on | `#ffffff` | `#181d1b` | `--color-rail` | sections.css:15, :26 |
| Dot, the margin matrix and every dotted line | `#e2e2e2` | `#3d4340` | `--color-dot` | sections.css:12, :25 |

The core names: `green #4f7a24`, `green-text` (`#4f7a24` by day, `#98c463` at night), `acid #c8f53c`, `ink #0a1a12`, `night #0f1312`, `night-surface #181d1b`, `paper #ffffff`, `page #fcfcfc`.

### How the greens share the work

- **Green `#4f7a24` is action.** The fill of every primary button, in both themes ("buttons keep their green", sections.css:23), and green text by day. One filled button per group, then ghosts. Hovers: `#436a1e` by day, `#5b8a2b` at night; the lip `#3b5e17` (sections.css:15, :26, :32). At night the button keeps only its lip (D47).
- **Green text at night is `#98c463`.** The action green reads 3.69:1 on the night page `#0f1312`; `#98c463` reads 9.28:1 (8.46:1 on the night rail). It is the same role, not a third brand color.
- **Acid `#c8f53c` is light on dark.** LEDs, the terminal cursor, the coin's glow at night, the dot-ants. It never sets text on white (1.27:1). On the site's other hero versions the announcement pill is acid with ink text, by day only.
- **One green in the dark hero.** At night the announcement pill turns to neutral glass, so the button is the hero's only green (D18; index.html:314).

### Contrast pairs that matter

Computed with the WCAG 2 formula from the token values (the page recomputes them from `tokens.json`). WCAG 2 asks 4.5:1 for text and 3:1 for large text (24px and over; the kit has no bold).

| Pair | Ratio | For |
|---|---|---|
| Text `#30382c` on paper `#ffffff` | 12.15:1 | Any text |
| Body `#56656f` on paper | 6.02:1 | Any text |
| Green `#4f7a24` on paper | 5.07:1 | Text, links, eyebrows |
| Paper `#ffffff` on green `#4f7a24` | 5.07:1 | Button labels |
| Small print `#66746b` on paper | 4.91:1 | Any text |
| Title gray `#929292` on paper | 3.11:1 | Large text only: the second half of a section title |
| H1 gray `#595959` on paper, at the H1's opacity .82 | 4.48:1 | The H1's second line (`--color-h1-second`) |
| H1 gray `#9ba49e` on the night page, at .82 | 5.28:1 | The H1's second line at night |
| Acid `#c8f53c` on paper | 1.27:1 | Never text |
| Text `#eceee9` on the night rail `#181d1b` | 14.61:1 | Any text |
| Gray `#9ba49e` on the night rail | 6.66:1 | Any text, the titles' second half |
| Green text `#98c463` on the night page `#0f1312` | 9.28:1 | Text, links, eyebrows |
| Green text `#98c463` on the night rail | 8.46:1 | Text, links, eyebrows |
| Green `#4f7a24` on the night page | 3.69:1 | Not for text at night: the reason for `#98c463` |
| Acid `#c8f53c` on the night page | 14.78:1 | Light: LEDs, cursors, dot-ants |
| Ink `#0a1a12` on acid | 14.18:1 | The acid pill's text |

### From the paintings, not tokens

Approximate colors measured from the images. They describe the watercolors; never set text or interface in them, and never ask an image model for a hex (models do not follow hex codes: describe colors in words).

| Where | Day | Night |
|---|---|---|
| Paper, empty sky | `#ffffff`, `#fcfcf8`, `#f6f9fa`, `#eef7fa` | none: the night has no white paper |
| Hero sky, top to horizon | `#bad5e8` → `#dde9ed` → `#edede3` | `#06192a` → `#193945` → `#2e515a` (night b); `#061c29` (night a); `#050a17` (night c) |
| Hero meadow | `#b4b077`, `#95884a`, `#bdb578`, `#8c8346` | `#315057` → `#1f3a40` |
| Footer, top band | `#ffffff` | `#0e1311`, which is the night page `#0f1312` |
| Footer landscape | `#d5c5a2`, `#baab72`, `#a69057` (the straw ledge), `#ccb780` | `#203938`, `#2d4c4e`, `#355048`, `#39493b` |
| Vignettes, sky | `#eef7fa` to `#fdefd8` (v10, golden hour) | `#081828` to `#172734` at the top |
| Vignettes, subject | wheat `#e7d1ac`; field `#ddd5b1`; v11's green band `#e7eccc` | `#314e55`, `#506c6e`, `#3f5c5d`; a silver river `#97afac` |
| Isometric map | `#9a9956`, `#b4b870`, `#cebe79`, `#e2d291` | `#0b2727`, `#1b3e39`, `#375650` |
| Warm accents | the caramel seed (`hero/seed-day.webp`) | the seed's amber glow `#ffb347` (index.html:681); fireflies `#d8f070`, `#a6e05a`, `#ffb347` (index.html:393) |
| A panel before its painting arrives | `#f6f3ea` (`--color-wash`, sections.css:107) | `#39403d` (sections.css:110) |

### Never

- **No gold, anywhere.** In watercolor gold turns flat ochre and adds a color (D28). The $ANTS coin is green like the buttons, with the white Antseed mark (D48). Gold is retired everywhere.
- **Seeds are caramel by day and amber at night** (D28).
- **No color outside these.** The network board's electric blue (`#1f6bff`, `#4d94ff` at night, sections.css:461-465) lives on that board only, and the board is in progress (`tokens.json`, tier `local`). The Antseed app's own navy night stays in the app; marketing assets use the green-black.
- **Acid is never text on a light ground**, and the title gray never sets small text on white.

### Merged in the kit

The kit keeps one value where the site has several (the site keeps its code):

| Kit | Also on the site |
|---|---|
| One ink, `#0a1a12` | `#090b0c` (the hero's ink, index.html:53), `#001E12` (the favicon mark), `#000` (product titles), `#1c1c1c` (the H1) |
| Titles `#30382c`, the second half gray | `#000` on the prices and product titles (sections.css:135, :235) |
| The focus ring is the green text color, 2px | `#789f00` on the hero (index.html:121) |
| Button text `#ffffff` | `#fafafa` on the nav button |

Shadows, glass and the button's depth are in Building blocks. The rest of the colors (tiles, hairlines, the wash, filters, the illustration inks and the local scene colors) are in the tables below.

### Every color token

<!-- tokens:start core theme illustration local -->

**core** — Use freely. The few colours that carry the brand, the same in both themes.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| green | `#4f7a24` | `--color-green` | The action colour: the fill of every primary button, in both themes; green text, links and icons by day. One filled green button per group. | --fill (and --o by day) | hero/sections.css:15, :12 |
| green-hover-light | `#436a1e` | `--color-green-hover-light` | Primary button hover, light theme. | --fill-hi | hero/sections.css:15 |
| green-hover-dark | `#5b8a2b` | `--color-green-hover-dark` | Primary button hover, dark theme. | --fill-hi (dark) | hero/sections.css:26 |
| green-lip | `#3b5e17` | `--color-green-lip` | The darker lip at the foot of every green button (an inset shadow). At night the button keeps only this lip. | #3b5e17 in .s-btn's box-shadow | hero/sections.css:93, :32 |
| acid | `#c8f53c` | `--color-acid` | Light on dark: LEDs, cursors, the coin's glow at night, the dot-ants. Called lime in conversation. Never text on white (1.27:1). | --acid | hero/sections.css:35 |
| ink | `#0a1a12` | `--color-ink` | The one ink: command lines, text inside product scenes, the darkest text. Kit merge (DECISIONS.md K09): the site also uses #090b0c (hero --ink, index.html:53), #001E12 (favicon mark), #000 (--title) and #1c1c1c (H1); the kit keeps #0a1a12 only. | --ink (sections), --cmd (hero) | hero/sections.css:35; hero/index.html:54 |
| night | `#0f1312` | `--color-night` | The dark page. Night paintings fade their top to exactly this colour. | --page (dark) | hero/sections.css:26; hero/index.html:16 |
| night-surface | `#181d1b` | `--color-night-surface` | The dark rail and dark surfaces; the Private by design section in both themes. | --rail-bg (dark), --priv | hero/sections.css:26, :17 |
| paper | `#ffffff` | `--color-paper` | The light rail, the white of paper, button text. | --rail-bg | hero/sections.css:15 |
| page | `#fcfcfc` | `--color-page` | The light margins around the rail, under the dot matrix: a shade darker than the white inside. | --page | hero/sections.css:15 |

**theme** — Use for UI. The same names in both themes; tokens.css swaps them under [data-theme="dark"] and prefers-color-scheme.

| Token | Light | Dark | CSS | Use | Site name | Source |
|---|---|---|---|---|---|---|
| page | `#fcfcfc` | `#0f1312` | `--color-page-bg` | Margins around the rail, under the dot matrix. | --page | hero/sections.css:15; hero/sections.css:26 |
| rail | `#ffffff` | `#181d1b` | `--color-rail` | The content column (the rail) and every surface on it. | --rail-bg | hero/sections.css:15; hero/sections.css:26 |
| text | `#30382c` | `#eceee9` | `--color-text` | Text and the first half of every title (12.15:1 on white). Kit merge: titles are #30382c; the site's #000 product titles are folded in. | --t (and --title) | hero/sections.css:12; hero/sections.css:25, :26 |
| text-grey | `#929292` | `#9ba49e` | `--color-text-grey` | The grey second half of every two-tone title; feature icons. 3.11:1 on white, so large text only. | --g | hero/sections.css:12; hero/sections.css:25 |
| h1-second | `#595959` | `#9ba49e` | `--color-h1-second` | The H1's second line, as on the site: 4.48:1 on white at the H1's opacity .82, where the title grey would give 2.43:1. Section titles keep the title grey. | --title-2 (hero) | hero/index.html:53, :99; hero/index.html:309 |
| text-body | `#56656f` | `#9ba49e` | `--color-text-body` | Body copy under titles, captions' second line (6.02:1 on white). | --b | hero/sections.css:12; hero/sections.css:25 |
| text-small | `#66746b` | `#9ba49e` | `--color-text-small` | Small print, units, provider counts (4.91:1 on white). | --m | hero/sections.css:12; hero/sections.css:25 |
| green-text | `#4f7a24` | `#98c463` | `--color-green-text` | Green text, links and eyebrows (5.07:1 on white). | --o | hero/sections.css:12; hero/sections.css:25 |
| dot | `#e2e2e2` | `#3d4340` | `--color-dot` | The margin dot matrix and every dotted outline. | --dot | hero/sections.css:12; hero/sections.css:25 |
| dot-off | `#e6eadc` | `#29302c` | `--color-dot-off` | A dot bar's unlit dots. | --empty | hero/sections.css:12; hero/sections.css:25 |
| tile | `rgba(214, 219, 211, .2)` | `rgba(255, 255, 255, .06)` | `--color-tile` | The ghost button's fill and the model card's tile. | --tile | hero/sections.css:16; hero/sections.css:27 |
| tile-hover | `rgba(214, 219, 211, .4)` | `rgba(255, 255, 255, .1)` | `--color-tile-hover` | Ghost button hover. | --tile-hi | hero/sections.css:16; hero/sections.css:27 |
| tile-line | `rgba(64, 76, 66, .1)` | `rgba(255, 255, 255, .1)` | `--color-tile-line` | The ghost button's hairline. | --tile-line | hero/sections.css:16; hero/sections.css:27 |
| control-ring | `#e4dfd2` | `rgba(236, 238, 233, .14)` | `--color-control-ring` | The warm hairline under tabs and round controls. | --seg-ring | hero/sections.css:141; hero/sections.css:144 |
| focus | `#4f7a24` | `#98c463` | `--color-focus` | Focus ring, 2px solid. Kit merge (DECISIONS.md K09): the focus ring is the green; the hero's #789f00 is folded in. | --o in :focus-visible (hero: #789f00) | hero/sections.css:152, :668; hero/index.html:121; hero/sections.css:152; hero/index.html:310, :327 |
| button-fill | `#4f7a24` | `#4f7a24` | `--color-button-fill` | Primary button fill: the same green in both themes. | --fill | hero/sections.css:15; hero/sections.css:23 |
| button-fill-hover | `#436a1e` | `#5b8a2b` | `--color-button-fill-hover` | Primary button hover. | --fill-hi | hero/sections.css:15; hero/sections.css:26 |
| button-text | `#ffffff` | `#ffffff` | `--color-button-text` | Primary button text. Kit merge: the nav's #fafafa is folded into #fff. | #fff in .s-btn | hero/sections.css:91 |
| button-shadow | `0 3.5px .5px 0 rgba(46, 74, 14, .1), inset 0 -.5px 0 0 rgba(200, 230, 170, .63), inset 0 -2px 1px 0 #3b5e17` | `inset 0 -2px 1px 0 #3b5e17` | `--button-shadow` | Primary button depth: a soft drop, a pale lip and the green lip. | .s-btn box-shadow | hero/sections.css:93; hero/sections.css:32 |
| button-ghost-shadow | `0 1.5px 0 0 rgba(255, 255, 255, .6), inset 0 -1px 2px 0 rgba(48, 56, 44, .2)` | `inset 0 -1px 1px 0 rgba(0, 0, 0, .2)` | `--button-ghost-shadow` | Ghost button depth. | .s-btn.ghost box-shadow | hero/sections.css:96; hero/sections.css:33 |
| wash | `#f6f3ea` | `#39403d` | `--color-wash` | A landscape panel's own colour while its painting has not arrived yet. | .wash background-color | hero/sections.css:107; hero/sections.css:110 |
| logo-filter | `none` | `invert(.93)` | `--filter-logo` | The black logo as it is. | --logo | hero/sections.css:18; hero/sections.css:29; hero/index.html:313 |
| character-filter | `none` | `brightness(.84) saturate(.83) contrast(1.12)` | `--filter-character` | Cut-out ants as painted. | (none by day) | hero/index.html:198; hero/index.html:198; hero/sections.css:218, :562, :622 |

**illustration** — Drawings and code effects only, never UI.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| night-character | `brightness(.84) saturate(.83) contrast(1.12)` | `--illustration-night-character` | Every cut-out ant at night: a little darker, cooler, less saturated, as the painting behind it. Also the night reference for assets made off the site (DECISIONS.md K20). | filter on the mascot at night | hero/index.html:198; hero/sections.css:218, :562, :622 |
| seed-night-glow | `drop-shadow(0 0 6px rgba(255, 200, 100, .85)) drop-shadow(0 0 22px rgba(255, 150, 50, .62)) drop-shadow(0 0 56px rgba(255, 128, 32, .4))` | `--illustration-seed-night-glow` | A seed glowing amber at night. | dark .cursor img filter | hero/index.html:187 |
| coin-shadow | `drop-shadow(0 12px 14px rgba(40, 60, 20, .18))` | `--illustration-coin-shadow` | The $ANTS coin floating, by day. | .s-tk-coin filter | hero/sections.css:559 |
| coin-night-glow | `drop-shadow(0 0 18px rgba(200, 245, 60, .3))` | `--illustration-coin-night-glow` | The $ANTS coin at night: an acid glow. | dark .s-tk-coin filter | hero/sections.css:563 |
| fireflies | `#d8f070, #a6e05a, #ffb347` | `--illustration-fireflies` | The hero's night fireflies, drawn in code (never painted). | INKS | hero/index.html:393 |

**local** — Never outside their scene. Kept so nobody mistakes them for brand colours.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| network | `link: #1f6bff; link-night: #4d94ff; other: rgba(10, 26, 18, .28); other-night: rgba(255, 255, 255, .3); base: #f4efdc; base-night: #24332f; base-edge: #b9b08c; base-edge-night: #121b19; provider-base: #bedc62; provider-base-night: #5d8a26; provider-edge: #6f8f2a; provider-edge-night: #2a4010` | `--local-network` | The network board only (in progress, left out of the kit's page): your links in electric blue, others' links faint, cream bases for people, green for providers. | --nd-* | hero/sections.css:462-465 |
| window-lights | `#ff5f57, #febc2e, #28c840` | `--local-window-lights` | macOS traffic lights on the terminal and app windows. | .t-lights i | hero/sections.css:253-255 |
| desktop-app | `ink: #16181d; muted: #6b6f7a; ink-night: #eef0f7; muted-night: #9aa1ba; check-night: #c6f06a; reply-night: rgba(14, 20, 44, .62)` | `--local-desktop-app` | Antseed Desktop's own app colours, drawn over its captures. The app's navy night differs from the site's green-black on purpose (DECISIONS.md K19). | .app .typed, .me, .ai, .sig | hero/sections.css:290-304 |

<!-- tokens:end -->

## Watercolour

Kit title (kit copy, to approve): "Soft, sparse, mostly paper."

The paintings are the friendly half of the brand. Soft watercolor gives the naive side that suits the mascot; the dots and the dither give the technical side (Elio, 12 Nov). So the painting stays plain and quiet, and the brand's dots, glass and words sit on top of it. Every painting has a night, made by editing its day. Decisions behind it, in DECISIONS.md: the watercolor is shown, not hidden under a treatment (D49); soft, suggested, sparse, no outline on scenery (D50); glass windows over landscape vignettes (D51); night is a painting, not an overlay (D42).

### What it is

1. Transparent washes on cold-pressed paper, with crisp dried edges and visible grain.
2. Mostly white paper.
3. Few elements, cropped close.
4. The subject sits low or at the side edges, never in the middle. Titles, UI and glass windows go in the quiet center and top.
5. A thin, broken, dark-brown line on subjects only (wheat ears, grass, the ants, seeds, the coin); none on scenery (hills, sky, river, clouds). At night the line turns teal-black.
6. High-key, soft, diffuse daylight, no hard cast shadows.
7. Nights in deep blue-green under soft moonlight. The only warm light comes from seeds (amber), one lit window, or the fireflies, which the site draws in code.
8. No ants, people, animals, buildings or text inside a background. The mascot is a separate cut-out layer; the footer is the one painted scene with ants in it.

The ant's world is the subject: meadow, wheat, grass and clover, ferns, hedgerows, river valleys, ponds, sea shore, fields at golden hour. The seed is almond-shaped and caramel.

Never in the style: photography or stock images, glossy 3D, vector flats, airbrush gradients, pixel art inside a painting, gold. Dots, dither, the LED reveal and glass are never painted: the site's code lays them over the painting.

### The measured check

A check, not a rule. Measured with Pillow's grayscale (`L = R·0.299 + G·0.587 + B·0.114`, 0 to 255); near-white is L ≥ 235. The page has a "Check an image" button that measures any image the same way, in the browser.

- Day vignettes on the site: 49 to 85% near-white, mean luminance 228 to 245.
- Night vignettes: mean luminance 43 to 74.
- Scenes are fuller and still leave their top quarter to a third to sky or paper: the hero is 25.8% near-white, the footer 38.4%.
- Rejected: the first v02 at 61% (busy), v05's day alternative at 41% (full of leaves), v07's pale night alternative at a mean of 188.

Measured on the site's files:

| Painting | Day, near-white | Day, mean | Night, mean |
|---|---|---|---|
| v01 | 81.1% | 239.0 | 73.0 |
| v02 | 81.4% | 241.9 | 67.8 |
| v03 | 56.8% | 230.7 | 57.8 |
| v04 | 83.3% | 240.5 | 57.3 |
| v05 | 75.5% | 234.1 | 43.6 |
| v06 | 49.7% | 228.9 | 71.3 |
| v07 | 63.2% | 231.9 | 55.6 |
| v08 | 72.0% | 236.0 | 58.8 |
| v09 | 75.1% | 238.7 | 67.2 |
| v10 | 80.5% | 240.5 | 64.5 |
| v11 | 85.0% | 245.4 | 71.5 |
| hero (Whimsical 2, night b) | 25.8% | 196.3 | 54.2 |
| footer (meadow-wide) | 38.4% | 206.4 | 54.7 |

### The paintings

v01, the wheat, is the approved style reference: "suggested, sparse, lots of white paper, a close crop with few elements" (Elio, 12 Nov). Use it as the style reference for any vignette; use Whimsical 2 (hero) for a scene, and the wide footer for a wide view of the world.

Where the site uses them: Gateway v01, Desktop v02, Private by design v07, v08, v09 and v04, Providers v03, v04 and v05, $ANTS v10 (`hero/sections.html:66`, `:104`, `:156`, `:347`, and the cards between them). v06 and v11 are finished spares. The network board's maps (map-2, map-3) are in progress with the board and left out of the page.

Every painting, film and object, from assets.json:

<!-- assets:start kind=painting,film,object -->

| ID | Kind | Subject | Size | Status | Day / file | Night | Used on | Recipe |
|---|---|---|---|---|---|---|---|---|
| hero | painting | Whimsical 2: the village meadow under a wide sky, the hero's scene | 1376 × 768 | live: The hero scene. The page plays its film (hero-film) over a 1280 × 714 poster; this still is the source of the night edits | ../assets/hero/whimsical-2.webp | ../assets/hero/night/whimsical-2-night-b.webp | ../hero/ |  |
| hero-film | film | Whimsical 2's film: the clouds drifting over the meadow, drawn at 12 a second, a muted loop | 1280 × 714 | live: Plays over its poster by day; paused at night; the poster alone with reduced motion | ../assets/hero/video/whimsical-2.mp4 |  | ../hero/ |  |
| hero-night-a | painting | The hero at night, a full moon top left | 1376 × 768 | spare: A night variant (?night=a); the crescent moon (night b) was picked | archive only | ../assets/hero/night/whimsical-2-night-a.webp | ../hero/?night=a | PROMPTS.md#hero-night-a |
| hero-night-c | painting | The hero at night, no moon | 1376 × 768 | spare: A night variant (?night=c); night b was picked | archive only | ../assets/hero/night/whimsical-2-night-c.webp | ../hero/?night=c | PROMPTS.md#hero-night-c |
| hero-night-loop | film | A seamless loop over the night still: the moon's glow, the grass moving | 1920 × 1072 | live: Only at night, only on screen, never with reduced motion | ../assets/hero/night/whimsical-2-night-b-loop.mp4 |  | ../hero/ | PROMPTS.md#hero-night-loop |
| footer | painting | The wide meadow down to a river, three mascots resting on caramel seeds; the footer | 2752 × 1276 | live: The footer, full bleed, its sky fading into the page. Documented as a still: its film is off | ../assets/home/footer/meadow-wide.webp | ../assets/home/footer/meadow-wide-night.webp | ../hero/ | PROMPTS.md#footer |
| footer-1k | painting | The footer meadow before its middle hill was cut out, 1K | 1376 × 768 | spare: Replaced on the site by the wide footer; still one of the lab's paintings | ../assets/home/footer/meadow.webp | ../assets/home/footer/meadow-night.webp |  | PROMPTS.md#footer |
| footer-hd | painting | The same footer meadow at twice the size | 2752 × 1536 | spare: Not loaded since the wide footer came in | ../assets/home/footer/meadow-2x.webp | ../assets/home/footer/meadow-night-2x.webp |  | PROMPTS.md#footer |
| v01 | painting | Golden wheat, close up: the approved style reference | 2400 × 1792 | live: The Gateway panel, behind the terminal. Elio's reference: suggested, sparse, lots of white paper, a close crop | ../assets/home/vignettes/v01-day.webp | ../assets/home/vignettes/v01-night.webp | ../hero/#gateway | PROMPTS.md#v01 |
| v02 | painting | Tall grass and two clover heads, low | 1200 × 896 | live: The Antseed Desktop panel, behind the app window. Still at 1K | ../assets/home/vignettes/v02-day.webp | ../assets/home/vignettes/v02-night.webp | ../hero/#desktop | PROMPTS.md#v02 |
| v03 | painting | A forest edge, birch trunks on both sides | 2400 × 1792 | live: Providers, first card (models to serve) | ../assets/home/vignettes/v03-day.webp | ../assets/home/vignettes/v03-night.webp | ../hero/#providers | PROMPTS.md#v03 |
| v04 | painting | A sea shore: dunes and beach grass | 2400 × 1792 | live: Providers, second card (incoming request), and Private by design, fourth point (no crypto needed) | ../assets/home/vignettes/v04-day.webp | ../assets/home/vignettes/v04-night.webp | ../hero/#providers | PROMPTS.md#v04 |
| v05 | painting | Ferns and broad leaves in the lower corners | 2400 × 1792 | live: Providers, third card (Antseed Colony) | ../assets/home/vignettes/v05-day.webp | ../assets/home/vignettes/v05-night.webp | ../hero/#providers | PROMPTS.md#v05 |
| v06 | painting | A river bend seen from above | 2400 × 1792 | spare: Finished pair, not placed: it was the network panel's before the board | ../assets/home/vignettes/v06-day.webp | ../assets/home/vignettes/v06-night.webp |  | PROMPTS.md#v06 |
| v07 | painting | Hills, hedgerows and patchwork fields | 2400 × 1792 | live: Private by design, first point (no account) | ../assets/home/vignettes/v07-day.webp | ../assets/home/vignettes/v07-night.webp | ../hero/#privacy | PROMPTS.md#v07 |
| v08 | painting | Poppies and daisies before soft hills | 2400 × 1792 | live: Private by design, second point (signed responses) | ../assets/home/vignettes/v08-day.webp | ../assets/home/vignettes/v08-night.webp | ../hero/#privacy | PROMPTS.md#v08 |
| v09 | painting | A pond, reeds and lily pads | 2400 × 1792 | live: Private by design, third point (TEE providers) | ../assets/home/vignettes/v09-day.webp | ../assets/home/vignettes/v09-night.webp | ../hero/#privacy | PROMPTS.md#v09 |
| v10 | painting | A warm field at golden hour, haystacks far off | 2400 × 1792 | live: The $ANTS panel, behind the coin and the amazed ant | ../assets/home/vignettes/v10-day.webp | ../assets/home/vignettes/v10-night.webp | ../hero/#token | PROMPTS.md#v10 |
| v11 | painting | A calm horizon band | 1584 × 672 | spare: Made for an earlier version of the network panel; unused since the board | ../assets/home/vignettes/v11-day.webp | ../assets/home/vignettes/v11-night.webp |  | PROMPTS.md#v11 |
| map-2 | painting | Isometric fields seen from above: 15 clearings, a river and a bridge; the network board | 2112 × 896 | in-progress: The network board is on hold and left out of the kit's page; do not extrapolate from it | ../assets/home/net/map-2-day.webp | ../assets/home/net/map-2-night.webp | ../hero/#network | PROMPTS.md#map-2 |
| map-3 | painting | An alternative board: 17 clearings | 2112 × 896 | spare: Ready but not placed; its night is provisional | ../assets/home/net/map-3-day.webp | ../assets/home/net/map-3-night.webp |  | PROMPTS.md#map-3 |
| seed | object | The seed: almond-shaped, caramel by day, glowing amber at night. The request, the thing the network passes along | 470 × 651 | live: The hero's cursor and the seed on its ground | ../assets/hero/seed-day.webp | ../assets/hero/seed-night.webp | ../hero/ | PROMPTS.md#seed |
| seed-small | object | The seed small, day and glowing | 92 × 128 | in-progress: Drawn on the network board, which is on hold | ../assets/home/net/seed-day.webp | ../assets/home/net/seed-glow.webp | ../hero/#network | PROMPTS.md#seed |
| coin | object | The $ANTS coin: green watercolor coin, tilted, the Antseed mark raised in white. The token's image; gold is retired | 557 × 603 | live: Floats over the amazed ant in $ANTS; at night it takes an acid glow in CSS | ../assets/home/ants-coin-cut.webp |  | ../hero/#token | PROMPTS.md#coin |
| coin-plate | object | The same green coin on its own pale wash, square | 1024 × 1024 | spare: Replaced by the cut-out, which can move on its own | ../assets/home/ants-coin.webp |  |  | PROMPTS.md#coin |

<!-- assets:end -->

Files are the site's WebP. The PNG masters, and the 2K masters of the vignettes, are on request from AstraOS.

### Not this

Off-brand, with the reason. Never use them, never attach them as a style reference.

- The first v02: a zoomed-out crop with fine detail everywhere. Too busy (61% near-white); the detail distracts from the content.
- v05's day alternative: the frame full of leaves (41% near-white).
- v07's night alternative: a pale night (mean 188). Nights are deep blue-green.
- The 2 Nov soil-strata washes: a cross-section, heavier, more saturated, outlined. Superseded.
- Plain abstract washes as a section ground: they say nothing of the ant's world. Replaced on 12 Nov by landscape vignettes.
- Dithered daisy, sprig and leaf symbols over the paintings: they don't work (Elio, 12 Nov). Effects on paintings are the LED arrival and the hover mosaic only (`hero/card-unveil.js`, `hero/wash-led.js`).
- A gold coin: no gold anywhere. The $ANTS coin is green `#4f7a24` with the Antseed mark in white.
- Darkening the day image in CSS to fake night: replaced by painted nights on 11 Nov.
- A raw AI upscale: a plastic sheen. Repaint at 2K, or blend (below).
- A weak AI video over a good still: the footer's night loop was turned off because the take looked wrong.
- Any map, diagram or composition with a hub: Antseed has no middleman. Spread the pieces evenly; nothing radial round one object.

<!-- assets:start kind=not-this group=vignette,wash,effect,object -->

| ID | Kind | Subject | Size | Status | Day / file | Night | Used on | Recipe |
|---|---|---|---|---|---|---|---|---|
| not-v02-first | not-this | The first v02: a zoomed-out crop with fine detail everywhere | 1200 × 896 | retired: Too busy: 61 % near-white where the approved ones are 49 to 85 %; detail distracts from the content | files/not-this/v02-first-day.webp |  |  |  |
| not-v05-day-alt | not-this | v05's day alternative: the frame full of leaves |  | retired: Too full: 41 % near-white. Mostly paper, few elements | archive only |  |  |  |
| not-v07-night-alt | not-this | v07's night alternative: a pale night |  | retired: Not night enough: mean luminance 188. Nights are deep blue-green | archive only |  |  |  |
| not-soil-strata | not-this | A 2 Nov wash: soil strata and roots under a meadow | 800 × 600 | retired: The superseded 2 Nov style: a cross-section, heavier, more saturated, outlined | ../assets/home/washes/prov-strata.webp |  |  |  |
| not-lavis | not-this | A plain abstract wash used as a section ground | 796 × 736 | retired: Replaced on 12 Nov by landscape vignettes: a wash says nothing of the ant's world | ../assets/home/lavis/gateway.webp |  |  |  |
| not-dither-overlay | not-this | Dithered daisy, sprig and leaf symbols laid over the paintings |  | retired: They don't work (Elio, 12 Nov). Effects on paintings are the LED arrival and the hover mosaic only. Drawn in code, removed; no file | archive only |  |  |  |
| not-gold-coin | not-this | The first $ANTS coins: gold, with a drawn ant | 1024 × 1024 | retired: No gold anywhere: the coin is green with the Antseed mark | files/not-this/gold-coin.webp |  |  |  |

<!-- assets:end -->

### Making a new one

The full recipes, the record of every image and the post-processing are in PROMPTS.md. The essentials:

**Ten rules.**

1. Edit, don't re-describe. Anything that must match an existing image (its night, a bigger size, a pose or a color change) is an edit of that image: attach it, start with `Edit @img1.`, say `Keep exactly …`, then `Change only …`.
2. The night is always an edit of the approved day image, never a new generation, with the "pixel aligned … so the day and night versions line up perfectly when crossfaded" clause.
3. Never ask the image model for dots, dither, the LED matrix or glass. The site's code adds them (`hero/dither.js`, `hero/wash-led.js`, `hero/card-unveil.js`, `hero/unveil.js`).
4. Lots of white paper, few elements, a close crop. v01 is the reference.
5. The mascot has two legs and two arms. Say "exactly TWO legs … nothing grows from the round abdomen" every time. Never jointed insect legs.
6. Never build the mascot as a puppet from parts; re-render it and describe the pose.
7. These models make no transparency. Generate on plain white (or flat `#00FF00`, or flat dark navy for a night object) and cut out afterwards.
8. Hex colors in prompts are unreliable: describe colors in words, set exact values afterwards (the night sky's `#0f1312` is applied after the render).
9. Forbid what models add by habit: moon, stars, fireflies, lit windows, falling leaves, particles, text, frames, borders, shadows, ground lines.
10. End each prompt with a short tag (`v01 night.`) so outputs can be found in a shared feed.

**Models.** Tested with Nano Banana 2.1 for nearly everything, GPT 2.6 for walk frames and Kling 2.6 for loops, via Magnific. Another model works the same way: keep the fixed sentences word for word, attach the references in the order the prompt names them (`@img1` is the first image attached, `@img2` the second) and describe colors in words. The prompts are quoted as they were sent, British spelling included.

**References** (in the kit zip's `refs/`, and on the site):

| Role | refs/ | On the site |
|---|---|---|
| Vignette style, day | `style-vignette-day.webp` | `/assets/home/vignettes/v01-day.webp` |
| Vignette style, night | `style-vignette-night.webp` | `/assets/home/vignettes/v01-night.webp` |
| Scene style, day and night | `style-scene-day.webp`, `style-scene-night.webp` | `/assets/hero/whimsical-2.webp`, `/assets/hero/night/whimsical-2-night-b.webp` |
| The wide world, day and night | `world-wide-day.webp`, `world-wide-night.webp` | `/assets/home/footer/meadow-wide.webp`, `meadow-wide-night.webp` |

#### A day vignette (PROMPTS.md A4)

Nano Banana 2.1, 1K, 4:3 (21:9 for a band), one image per generation; make two or three and pick. `@img1`: v01 by day.

```text
A small decorative watercolour vignette painted in exactly the style of @img1: the same cold-pressed watercolour paper grain, the same soft transparent washes, the same loose suggested brushwork, the same light airy palette and the same amount of untouched white paper. Subject: [SUBJECT]. Very few elements, sparse and suggested, soft edges, no fine detail, no dense texture, low contrast, large quiet empty areas so text can be read over it. No characters, no ants, no insects, no animals, no birds, no people, no buildings, no text, no lettering, no signature, no frame, no border. The painting fills the whole image edge to edge. [TAG] day.
```

`[SUBJECT]`: one close crop of the ant's world, few elements, placed low or to one side. When text sits on it: "a close, simple crop of …, all kept low in the lower part of the page. The upper two thirds are pale sky fading into blank white paper." `[TAG]`: a short name.

#### Its night (PROMPTS.md A5)

Nano Banana 2.1, 1K, the day image's aspect. `@img1`: v01 at night (the night style); `@img2`: the approved day image. Then check the pair with an edge overlay: 0 px of drift is normal.

```text
Edit @img2. Turn this watercolour into the same scene by night, in exactly the night style of @img1: the same deep green-blue moonlit palette, soft transparent washes and the same cold-pressed paper grain. Keep the composition of @img2 exactly the same, element for element and pixel aligned: every shape, edge, horizon line, blade and wash stays in the same place and at the same size, so the day and night versions line up perfectly when crossfaded. Only the lighting and colours change: cool moonlight, deep teal and blue-green tones, soft pale highlights. Keep it as sparse as @img2: where @img2 is blank paper, the night version stays a calm, luminous blue-green paper wash and is not painted over with new grass, leaves, hills or shapes. Do not add a moon, stars, lights, characters, ants, animals, people, buildings, text, frame or border. Same framing, no crop, no zoom. [TAG] night.
```

Expect a night gone too navy, a night painted over the white margins, added shrubs or heavier clouds; PROMPTS.md A5 has the sentences that fixed each. A cut-out on white never reads as night when generated: grade it in code.

#### At 2K, for a panel (PROMPTS.md A10)

Nano Banana 2.1 at 2K, the approved 1K image as the only reference, day and night each; the pairs stay aligned. A repaint, not an upscaler.

```text
Repaint this exact watercolour illustration at high resolution. Keep the composition, every element, its position and size, the colours, the light and the paper texture exactly as in the reference; nothing added, nothing removed, nothing moved. Crisp, clean hand-painted watercolour on paper, fine detail, no text.
```

More templates in PROMPTS.md: recomposing a wide scene (A6), an object (A9), an ambient loop (A11).

#### After the render

- WebP for the site, PNG for the master. 2K vignettes stay 2400 × 1792, WebP quality 80, method 6; 1K vignettes go to 1200 wide (Lanczos), quality 82; cut-out objects quality 88.
- A night that meets the page: fade the top of the sky to exactly `#0f1312` (the dark page, `--color-night`), about 110 px at 1K and 220 px at 2752 wide.
- Bigger without the plastic look: repaint at 2K (above). If an upscaler is used, blend 60% of the upscale with 40% plain enlargement of the 1K.
- Dots, dither, the LED reveal and glass come from the site's code or the lab, on top.

#### Names and pairs

- `<subject>-day.webp` and `<subject>-night.webp`, the same size. Vignettes are numbered `vNN`, boards `map-N`; variants take `-a`, `-b`, `-c` (`whimsical-2-night-b.webp`); a bigger copy of a 1K image `-2x`; a loop `-loop.mp4`. Filenames stay as they are: the subject lives in assets.json.
- The night is an edit of the day: same composition, same elements in the same places, same size, so the site can swap or crossfade them.
- A panel names both, and the theme picks one: `style="--wash: url(…-day.webp); --wash-d: url(…-night.webp)"` (`hero/sections.html:66`; the mechanism, with its fallback colors `#f6f3ea` and `#39403d`, `--color-wash`, at `hero/sections.css:107-110`).
- The switch: the hero's night sweeps down from the sky over 1.2 s (`hero/index.html:344-356`); the footer's closes in toward the sun, low at the end of the river, over 1.8 s (`hero/footer.css:16-26`). Never on load, nothing with reduced motion.

#### Sizes to deliver

| Use | Aspect | Deliver |
|---|---|---|
| Panel vignette (half the rail or larger) | 4:3 | 2400 × 1792 (2K) |
| Small card vignette, or a trial | 4:3 | 1200 × 896 (1K) |
| Hero scene | 16:9 | 1376 × 768; the film runs 1280 × 714 |
| Footer, full-bleed scene | about 2.16:1 | 2752 × 1276 |
| Horizon band | 21:9 | 1584 × 672 |
| Cut-out object (coin, seed) | free | 470 to 560 px wide, transparent |

On the site the rail is at most 1312 px (`hero/sections.css:37`), the Gateway and Desktop rows at least 624 px tall (`hero/sections.css:229`), the Private by design panels 460 px (`hero/sections.css:623`), the footer 110% of the page's width (`hero/footer.css:9-11`).

#### Into the page

- Full-bleed scenes (the footer) melt into the page through their own sky. By day the top is plain white paper; by night it is painted down to exactly `#0f1312`. The CSS mask then fades the picture from transparent at 22% of its height to opaque at 42% (`hero/footer.css:12-13`).
- Card paintings (the hero, the vignettes) need no fade: they fill their panel edge to edge (`background-size: cover`, `hero/sections.css:107`), with the card radius, 11 px (`--radius-card`).

## Mascot

This is the illustration rule for every ant Antseed draws. There is one character: a small, chubby, round ant painted in soft watercolor with a thin dark-brown ink line. It is never an insect. It is the friendly half of the brand: a supporting part on the site, the lead in comms (D30). The clean, technical layout around it is what balances the meme side (D03).

Every ant that stands for a person, a device or a provider is this mascot, dressed as its archetype. Anywhere else, an ant is a dot (see The dot). Never a second ant design (D23, 12 Nov).

### The model

The reference is the You render: `files/mascot/you-1.webp` (641 × 992, cut out of its white; asset `you-render`; in the kit zip as `refs/mascot-you.webp`). Its transparent pixels keep the render's white, so a tool that drops transparency still sees it on white. Attach it to every prompt for a new pose or archetype.

| Part | The rule |
|---|---|
| Head | Enormous and round, close to half its height ("an enormous round head that takes up half of its height", the round ant's founding prompt, 2 Nov). A pale wet-in-wet bloom on its upper side |
| Eyes | Two huge white discs with a dark-brown outline; tiny black pupils with a small white catchlight. In three-quarter view the far eye bulges past the head's outline |
| The lost look | The pupils sit off to the sides, looking away from each other, one a little up and the other a little down, a touch smaller so the eyes look wider. Applied after the render, in code (`assets/home/derp-eyes.py`) |
| Mouth | A tiny flat line with a small tick at each end, low between the eyes. No eyebrows |
| Antennae | Two, short and thin, each ending in a small round ball |
| Bandana | Lime green, knotted at the back of the neck, its two ends like small leaves. It is You's mark. To confirm with Antseed: their original ant wore blue, which now marks the User archetype |
| Body | A small round chest in front, a big round abdomen behind with soft painted segment lines. No waist pinch, no visible joints |
| Arms | Two, thin, stubby and boneless, with simple mitten hands |
| Legs | Exactly two, both under the body. Nothing grows from the abdomen (the rule since 12 Nov, commit `3c6ccb1`) |
| Line and paint | A thin dark-brown ink line around the ant, and only around the ant: scenery has no outline (D50). Warm brown pigment, paper grain, wet-in-wet blooms, soft edges |
| Delivery | A cut-out on transparency, placed over a painting or the page. No sticker outline, no cast shadow in the file |

The colors of the art are sampled, not tokens. They describe the paint; never set them as UI colors.

| Part | Sampled | From |
|---|---|---|
| Body, warm brown | `#ba6f48`, `#b9754a`, `#cf8b63` | the You render; the board's idle; the hero rig |
| Ink outline | `#3d1710` to `#301403` | the same files |
| Bandana, lime | `#9abb19`, `#a4c922` | the You render; the hero rig |
| Eye white | `#fffffd` | the hero rig, the board's sprites |
| Pupil ink drawn by code | `#2b1b12`, `#261812` | `hero/index.html:1305`; `assets/home/carry/build.py:29` |
| Open mouth drawn by code | `#3b2116` | `hero/index.html:1306` |
| User: amber body, sky-blue bandana | `#ce792a`, `#6cb3d3` | the User render |
| Provider: charcoal hoodie | `#5f6464` | the Provider render |

The painted bandana is a duller watercolor lime than the site's acid `#c8f53c`. The acid is light (the dot-ants, the cursor); the bandana is paint.

### Personality

- Deadpan: a flat little mouth, no eyebrows, "an expression of total, serene incomprehension" (2 Nov).
- A bit dumb, wide-eyed, memeable. Never scary, never gross, never insectoid (Elio, 2 Nov and 12 Nov; D20).
- The lost look is the default, in every frame (D22, 12 Nov). It is the point of the character.
- It carries things, and it gets amazed.
- Never determined, cool or heroic by default. Cool is kept for Private (the sunglasses).

Elio's reference for the energy is the Raving Rabbids: a bit stupid, wide-eyed, memeable, never scary. That name is for people only. Never write it in a prompt, and never attach their images: models then draw rabbits or copy their likeness. Describe the energy in words, as in the prompts below, and give the eyes the lost look in code.

Other eyes, only when the moment needs them:
- the hero ant: its eyes follow your pointer and cross on the seed;
- the amazed ant under the $ANTS coin, its pupils trembling in awe;
- the incognito ant, behind its sunglasses;
- on the network board, receive (happy closed eyes in two arcs) and look (eyes up).

Still open: whether still images of the hero ant used elsewhere (posters, social) take the lost look.

### Archetypes

One body, dressed for its role. Props tell the roles apart, never color-coded tags: the board's name tags went back to one plain glass pill because "the archetypes will tell them apart" (D24; commits `3c6ccb1`, `64a89c0`). Each archetype has two legs and the lost look.

| Archetype | What it stands for (the site's words, `hero/net.js:41-43`) | Look | Status |
|---|---|---|---|
| You | Your device. It finds providers on its own and pays each request directly. | The mascot itself: warm brown, lime bandana | Final. The lime bandana: confirm with Antseed |
| Provider | Runs AI models on its own hardware and sells answers per request. | The geek: big round black-rimmed glasses over its eyes (eyes still visible through the lenses), a charcoal hoodie with the hood down, no bandana | In progress. One render is live on the board; the final pick is pending |
| User | Someone else on the network, reaching their own providers the same way. | A golden-amber ant, lighter and warmer than You, with a sky-blue bandana | In progress. One render is live; the pick is pending; the blue bandana: confirm with Antseed |

A second User (a brown ant in a small red knitted beanie, no bandana) was rendered and is not used. Only the standing pose exists for each archetype; their receive, cheer, send and look come after the picks. Do not extrapolate from the in-progress archetypes.

Earlier role ideas are superseded: the four castes of 2 Nov (forager, leafcutter, scout, honeypot) and colored outlines on the tags.

### Poses

Every pose on the site, with its status. The files are on the site; the heavy zip has them all under `mascot/`.

<!-- assets:start kind=pose,sprite -->

| ID | Kind | Subject | Size | Status | Day / file | Night | Used on | Recipe |
|---|---|---|---|---|---|---|---|---|
| you | pose | You: the mascot standing, warm brown, lime bandana, the lost look | 207 × 320 | live: Final. The board's piece for you | ../assets/home/net/ant-you-idle-day.webp | ../assets/home/net/ant-you-idle-night.webp | ../hero/#network | PROMPTS.md#you |
| you-render | pose | You at full size, cut from the render the board's You comes from: standing in three-quarter view, two legs, the lost look. The kit's model sheet is drawn on it | 641 × 992 | live: Final. The reference to attach to every prompt for a new pose or archetype. Cut out of its white by the site's own cut (make-sprites.py); the white stays under the transparent pixels, so a tool that drops transparency still sees it on white | files/mascot/you-1.webp |  |  | PROMPTS.md#you |
| provider | pose | Provider: the same ant as a geek, big round black-rimmed glasses, a charcoal hoodie instead of the bandana | 217 × 320 | in-progress: provider-4 is live on the board; the final pick is pending | ../assets/home/net/ant-prov-idle-day.webp | ../assets/home/net/ant-prov-idle-night.webp | ../hero/#network | PROMPTS.md#provider |
| user | pose | User: a golden-amber ant with a sky-blue bandana | 207 × 320 | in-progress: user-a-1 is live on the board; the final pick is pending; the blue bandana is to confirm with Antseed | ../assets/home/net/ant-user-idle-day.webp | ../assets/home/net/ant-user-idle-night.webp | ../hero/#network | PROMPTS.md#user |
| pose-idle | pose | The mascot standing, the board's resting pose | 207 × 320 | in-progress: A network board reaction (the board is on hold). Three or four feet: a documented exception to the two-leg rule | ../assets/home/net/ant-idle-day.webp | ../assets/home/net/ant-idle-night.webp | ../hero/#network | PROMPTS.md#pose-idle |
| pose-receive | pose | Receive: hugging a seed, eyes closed in two happy arcs | 194 × 320 | in-progress: A network board reaction (the board is on hold). Three or four feet: a documented exception to the two-leg rule | ../assets/home/net/ant-receive-day.webp | ../assets/home/net/ant-receive-night.webp | ../hero/#network | PROMPTS.md#pose-receive |
| pose-cheer | pose | Cheer: arms up, mouth open | 206 × 320 | in-progress: A network board reaction (the board is on hold). Three or four feet: a documented exception to the two-leg rule | ../assets/home/net/ant-cheer-day.webp | ../assets/home/net/ant-cheer-night.webp | ../hero/#network | PROMPTS.md#pose-cheer |
| pose-send | pose | Send: a toss, one arm out | 224 × 320 | in-progress: A network board reaction (the board is on hold). Three or four feet: a documented exception to the two-leg rule | ../assets/home/net/ant-send-day.webp | ../assets/home/net/ant-send-night.webp | ../hero/#network | PROMPTS.md#pose-send |
| pose-look | pose | Look: eyes up at something flying over | 206 × 320 | in-progress: A network board reaction (the board is on hold). Three or four feet: a documented exception to the two-leg rule | ../assets/home/net/ant-look-day.webp | ../assets/home/net/ant-look-night.webp | ../hero/#network | PROMPTS.md#pose-look |
| incognito | pose | The incognito ant: small black round sunglasses, a faint knowing smile, sitting with its legs over an edge | 360 × 557 | live: Private by design, sitting on the panel's top edge. Sunglasses mean Private, never night | ../assets/home/ant-incognito.webp |  | ../hero/#privacy | PROMPTS.md#incognito |
| token-ant | pose | The amazed ant: arms up, looking up, mouth open; its pupils are separate layers that tremble in awe | 544 × 769 | live: $ANTS, under the floating coin | ../assets/home/ants-token-ant.webp |  | ../hero/#token | PROMPTS.md#token-ant |
| carry | sprite | The carrying ant: an 8-frame walk, a run, stand, look and hop, in two layers (the ant behind the card, its near hand over it) | 984 × 260 | live: Hauls each model card in the models' lanes. The 8-frame walk is final | ../assets/home/carry/ant.webp |  | ../hero/#prices | PROMPTS.md#carry |
| hero-rig | pose | The hero's mascot in parts: the body with its arms painted out, the back arm, the front arm, and a neutral fallback | 1024 × 1024 | live: The hero only: a rig whose eyes follow the pointer and arms reach for the seed. The one approved exception to never puppet the ant; never build a new pose this way. Three or four feet: a documented exception | ../assets/hero/ant-rig/ant-body.png |  | ../hero/ | PROMPTS.md#hero-rig |
| footer-ants | pose | Three mascots painted into the footer: one leaning on a seed, one asleep on one, one sitting with its chin on its hand |  | live: Part of the footer painting, not cut-outs | archive only |  | ../hero/ | PROMPTS.md#footer |

<!-- assets:end -->

- Incognito (`ant-incognito.webp`): sunglasses, a faint knowing smile, sitting with its legs over an edge. It sits on the top edge of Private by design, mirrored to look at the text (`hero/sections.css:621`).
- Amazed (`ants-token-ant.webp`): arms up, looking up, mouth open. Its two pupils are separate files (`ants-token-pupil-l.webp`, `-r.webp`), placed at left 45.04 %, top 28.35 %, width 10.66 % and left 72.24 %, top 26.79 %, width 9.38 % of the ant (`hero/sections.html:348`), trembling every .48 s in sub-pixel steps, both together (`hero/sections.css:555-558`). The $ANTS coin floats over it.
- The carry walk (below).
- The five board reactions (idle, receive, cheer, send, look): in progress with the network board, which is on hold. They keep three or four feet: a documented exception, like the hero rig. Every new render has two legs.
- Three ants painted into the footer, resting on caramel seeds (one leaning on a seed, one asleep on one, one sitting with its chin on its hand). They are part of the painting, not cut-outs; there are no separate files of these poses.
- The hero rig (`assets/hero/ant-rig/`): the body with its arms painted out, the back arm, the front arm and a neutral fallback, 1024 × 1024 each. Its eyes follow the pointer and its arms reach for the seed. It is the hero's alone and the one approved exception to never puppet the ant (D25). Never build a new pose this way.

Pose ideas from 2 Nov wait to be re-rendered on the current model before any use: asleep, tied up, holding a receipt.

### The carry walk

On the site each model card is hauled by a little ant a third of the card's height, at its trailing side, its hand on the card's lower corner (D64). The sprite is `assets/home/carry/ant.webp` (984 × 260) with its table `assets/home/carry/ant.json`:

- 12 cells of 82 × 130 sheet px, drawn for a 352 px card (a 176 px card at 2×). Cells 0 to 7 are the walk, 8 the run, 9 stand, 10 look, 11 hop.
- Two rows: row 1 is the ant, behind the card; row 2 is its near arm and hand, over the card.
- The cell's corner `[54.7, 104.9]` goes on the card's lower-left corner; the walking feet are at 119.5.
- The walk's steps are even, 4.7 sheet px a frame, so the feet hold on the ground; `lift` says how far the card rises on each frame.
- The eight-frame walk is final. The lost look is fixed in every frame.

How it moves (`hero/sections.js:162`, `:205-206`, `:293-318`): carriers go 2.55 times the lanes' 32 px/s, with a gentle bob of 6 px; under the pointer it stops and looks at you and lifts the card a touch; a click and it hops (.56 s, 10 px), then runs to catch up; below 8 px/s it stands on both feet, never a frozen stride. Some walk in front of their card; the second lane walks left, the ant mirrored, never the card (`hero/sections.css:189-216`). At night the ant takes the filter, the card stays the card (`hero/sections.css:218`). With reduced motion the lanes slide plainly.

### Props and what they mean

| Prop | Means | Rule |
|---|---|---|
| Lime bandana | You, the mascot | Always on You, unless a costume replaces it. Confirm with Antseed |
| Seed (caramel, almond-shaped) | The request: what the network passes along; the hero's cursor | Carried, hugged, eaten or rested on. Caramel by day, a soft amber glow at night, never gold (D28). It replaced the blue orb (D27) |
| Small black round sunglasses | Private | Only for Private. Never a night costume (D26) |
| Round black-rimmed glasses and a charcoal hoodie | Provider | They replace the bandana. In progress |
| Golden-amber body and a sky-blue bandana | User | In progress. The blue bandana: confirm with Antseed |
| Green watercolor coin with the white Antseed mark | $ANTS | Floats over the amazed ant. Green like the buttons; gold is retired everywhere |
| Model card | A model on the network | Carried at its side like a big box, its hand on the card's lower corner |

### At night

The ant takes the night's light; it never changes costume. Every cut-out ant on the site takes the same filter (`hero/index.html:198`; `hero/sections.css:218`, `:562`, `:622`), half as strong as it first was, with a little more contrast (commit `a61d197`):

```css
/* a cut-out ant: the night's light, at night only (tokens.css) */
.ant { filter: var(--filter-character); }

/* the same, written out: the token --illustration-night-character */
filter: brightness(.84) saturate(.83) contrast(1.12);
```

The network board's sprites carry a night baked in by their cut-out script instead (darker mid-tones, cooler shadows, less color, a moonlit rim). For anything new, on the site or off it, the filter is the reference.

### Never

- The earlier slim ant: long thin limbs, crossed arms, a smirk (`assets/hero/ant-standing/ant-standing.webp`, `assets/home/ant-1.png`). One ant only, the big round one (D23).
- Jointed insect legs, a realistic insect, mandibles, segmented legs, six legs (D20).
- Four legs, or legs under the abdomen. Two legs, two arms.
- The blue orb, or anything on its head (`assets/hero/ant-walk.png`). The seed replaced the orb (D27).
- Castes or color-coded roles. One body; a role is told by its props (D24).
- Sunglasses at night. Sunglasses mean Private (D26).
- A pose built from parts, rigged, or moved by script. Re-render it with a precise prompt; only the pupils may be moved by script (D25).
- Another character's name or images in a prompt.
- Determined, cool or heroic by default.
- An outline on the scenery around it, or a busy painting behind it: the watercolor stays minimal so the character can be a bit silly in it.

The off-brand records:

<!-- assets:start kind=not-this group=mascot -->

| ID | Kind | Subject | Size | Status | Day / file | Night | Used on | Recipe |
|---|---|---|---|---|---|---|---|---|
| not-slim-ant | not-this | The earlier slim ant: long thin limbs, crossed arms, a smirk | 1448 × 2158 | retired: One ant only, the big round one. Never determined, cool or heroic by default | ../assets/hero/ant-standing/ant-standing.webp |  |  |  |
| not-orb-ant | not-this | The orb era: the round ant on four legs with a blue orb on its head | 467 × 800 | retired: Two legs, two arms; the seed replaced the orb | ../assets/hero/ant-walk.png |  |  |  |
| not-specimen | not-this | A realistic field-guide ant |  | retired: Never insectoid: no mandibles, no segmented legs, no six legs | archive only |  |  |  |
| not-castes | not-this | The four castes of 2 Nov: forager, leafcutter, scout, honeypot |  | retired: One body; a role is told by props (the archetypes), never by castes or color codes | archive only |  |  |  |
| not-sunglasses-night | not-this | The mascot in sunglasses as a night costume |  | retired: Sunglasses mean Private, never night. At night the ant takes the night's light, it does not change costume | archive only |  |  |  |
| not-jointed-legs | not-this | An ant with jointed insect legs |  | retired: Stubby, boneless limbs only; two legs | archive only |  |  |  |

<!-- assets:end -->

### Making a pose

Re-render, never assemble. Attach the You render and keep the face words, word for word: that is what keeps the character.

1. Attach the You render as `@img1` (`refs/mascot-you.webp` in the kit zip). For a costume, attach the archetype render as a second reference.
2. Fill the template's slots. End every prompt with a short tag naming it, so its output can be found later. Tested in Magnific with Nano Banana 2.1: 1K, square (1:1), three tries.
3. To change one leg in a walk frame, use the leg edit with GPT 2.6: it was the model that followed leg instructions; Nano Banana copied the reference pose. Nano Banana also ignores camera angles: give it a reference that already shows the angle.
4. Generate on plain white, then cut it out: no model gives transparency. Describe colors in words; models do not follow hex codes.
5. Give it the lost look with `derp-eyes.py`, unless the pose has eyes of its own. Its night is the filter.

The full recipes, and the exact prompt behind each pose, are in `PROMPTS.md` (`#you`, `#provider`, `#user`, `#pose-receive`, `#incognito`, `#token-ant`, `#carry`).

A pose or an archetype (the slots are `[COSTUME]`, optional, and `[POSE]`):

```text
The same cute watercolour ant mascot as the reference, same character, same framing, same hand-painted watercolour style with a dark brown outline: round brown head, two big white eyes with small black pupils, a flat line mouth, two antennae with round ball tips, a lime-green bandana, a round abdomen behind, thin little arms. [COSTUME] [POSE]. The ant has exactly TWO legs, both under its body, standing on its two feet; nothing grows from the round abdomen: no legs or feet under it. Two legs and two arms only. Full body, centred, plain pure white background, no shadow, no ground, no text.
```

Pose sentences that worked (`@img2` is the seed, `refs/seed.webp`):

```text
idle: standing, calm, looking toward the viewer, arms relaxed at its sides.
receive: a seed has just landed in its arms: it hugs the seed against its chest with both little arms, eyes closed in two happy upturned arcs, a small smile, antennae perked up. The seed looks exactly like @img2, small next to the ant.
cheer: both little arms raised up high in joy, eyes wide and shining, mouth open in a small happy round "o", antennae up.
send: it tosses a seed up and forward with both arms, as if passing it to a friend far away; the seed has just left its hands and is a little above and in front of them. The seed looks exactly like @img2, small next to the ant.
look: it turns its head up and to the side, as if watching something fly overhead, curious, antennae tilted, arms relaxed.
```

A costume, the provider's:

```text
now as a geek: it wears big round black-rimmed glasses over its big eyes (the white eyes and small black pupils still visible through the lenses) and a charcoal-grey hoodie with the hood down, instead of the bandana.
```

Two legs, every time (it is in the template; add it to any other mascot prompt):

```text
The ant has exactly TWO legs, both under its body, standing on its two feet; nothing grows from the round abdomen: no legs or feet under it. Two legs and two arms only.
```

One walk frame, the leg edit (GPT 2.6; attach the neighboring frame to redraw; name each leg by its side, near or far, by what overlaps what, and by shade):

```text
Redraw the reference image (the same watercolour ant walking to the right, in strict side view) exactly: same size, same position in the canvas, same head, eyes, bandana, antennae, arm and hand, same style, plain white background. Change only the legs.

The ant walks to the right, so the side facing us is its RIGHT side (the arm we see is its right arm).
In the reference, [WHICH LEG DOES WHAT]. Draw the opposite:
- Its RIGHT leg, the near leg on our side (its whole thigh visible, joining the body on our side, drawn in front of everything and over the other leg), [NEW POSITION].
- Its LEFT leg, the far leg on the other side of the body (its top hidden behind the body and behind the right leg's thigh, a little darker in shade), [NEW POSITION].

Exactly two legs. No shadow, no ground line, no text.
```

The lost look, in code (`assets/home/derp-eyes.py`, Python with Pillow; it works on cut-outs and on renders on white):

```text
python derp-eyes.py in.png out.png [scale] [push]
# scale: the pupil's size, default .72; push: 0 to 1 of the way to the eye's edge, default 1.0
```

The script's own header comment still says .85 and .8; the code's defaults are the ones above. It finds the two eye whites, lifts each pupil out, fills the eye with its white and sets the pupil back near the eye's outer edge. The lost look is this step, after the render. Never ask an image model for dots, dither or glass: those are code too.

### How it moves on the site

| Where | What | Source |
|---|---|---|
| Hero | A rig at the card's bottom right, 420 wide, 40 in from the right, 22 % of it below the card's edge. Its eyes follow the pointer (travel .8); its arms reach for it within 420 px, up to 150°; its mouth opens 30 px | `hero/index.html:660` |
| Hero, the seed | The cursor is a seed. The ant squints within 150 px of it, catches it within 30, chews it in three bites over 1200 ms with 5 crumbs a bite; a new seed lies by it | `hero/index.html:664-665` |
| Hero, the eyes | Pupils of 16 px of the art in `#2b1b12`, trembling 2.5 px while it is awake | `hero/index.html:1305` |
| Hero, the walk-in | From the screen's edge to its place in 2100 ms; the mascot drawn at 12 drawings a second, like the films | `hero/index.html:1441`, `:685` |
| Models | The carry walk (above) | `hero/sections.js:162`, `:205-206`; `assets/home/carry/ant.json` |
| $ANTS | The amazed ant rises from the panel's foot, seen down to just under its arms; its pupils tremble every .48 s; the coin floats over 3.6 s | `hero/sections.css:552-561` |
| Private by design | The incognito ant on the panel's top edge, mirrored, `clamp(64px, 16%, 120px)` wide; 88 px, then 52 px on smaller screens | `hero/sections.css:621`, `:716`, `:779` |
| Night | The filter on every cut-out ant | `hero/index.html:198`; `hero/sections.css:218`, `:562`, `:622` |
| Private by design, the dots | The mascot reduced to a dot: a few acid dots walk the mosaic like ants (see The dot) | `hero/dither.js` |

### How it got here

- 28 Oct: Antseed's own ant: brown watercolor, a teal-blue bandana ("its distinctive sign"), determined brows, blue energy.
- Late Oct: a slim ant with a lime bandana, crossed arms and a smirk.
- 2 Nov: Elio names the risks of an insect mascot: gross, childish, a memecoin look. Marketing asks for a dumber, memeable ant. The round ant is born: "like a first-generation starter monster from a 1990s handheld game", four stubby legs, hugging a blue orb.
- 3 Nov: the hero's rig: eyes that follow, arms that reach, the seed eaten.
- 4 Nov: Elio recommends the big chubby one, "the most memeable and the most fun"; the clean layout balances it (D19, D21).
- 9 Nov: the seed replaces the orb; sunglasses at night are tried and removed the same evening.
- 12 Nov: one ant for everything; two legs; the lost look everywhere; the archetypes; the carry walk; the incognito and amazed ants; the night filter made half as strong; never puppet, re-render.

### Still moving: do not extrapolate

- The Provider and User picks, and their other poses.
- The bandana colors: lime for You, blue for User. Confirm with Antseed.
- The hero rig and the five board reactions keep three or four feet: a documented exception. Every new render has two legs.
- The network board, where the archetypes live, is on hold.
- Still images of the hero ant used elsewhere: with or without the lost look.
- The mascot has no name yet, and no rule yet says how often or how big it appears in posts, banners and slides.
- Kit copy to approve: this section's title, "One ant. A bit lost.", and its sub-heads.

## Building blocks

Only the parts of the homepage that travel to other assets: posts, slides, banners and new pages. Each one is cut from the live homepage (the system comes from the homepage, never the other way round: D79) and lives in `components.css`, written on the variables of `tokens.css`. Load `tokens.css` first, then `components.css`; every class starts with `ak-`. In the zip they are `tokens/tokens.css` and `tokens/components.css`.

The site's own selectors (`.s-btn`, `.term`…) are named below so you can find a thing on the homepage. Never copy the site's CSS: use `components.css`. Every component and state of the homepage, including the ones that do not travel, is on `/brand/reference/`.

Page title of this section, "Built from the homepage.", is kit copy, to approve.

```html
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500&family=Geist+Mono:wght@400;500&display=block" rel="stylesheet">
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="components.css">
```

### Section head

An eyebrow that links to the docs, then a title in two halves (the second gray, a full stop at the end), then one sub. A column, 20 apart, left aligned; the sub at most 780 wide.

```html
<header class="ak-head">
  <a class="ak-eyebrow" href="https://antseed.com/docs/gateway/">Antseed Gateway&nbsp;<span class="chev">›</span></a>
  <h2 class="ak-title">An API key<br><span>for every agent.</span></h2>
  <p class="ak-sub">Deploy your own endpoint and give each agent, app, or teammate their own API key.</p>
</header>
```

- Eyebrow: Geist Pixel ELSH 20, 18/27, green text, then `&nbsp;›`; the chevron leans 3px on hover over .2s (`sections.css:80-83`, `micro.css:16-17`).
- Title: Geist Pixel ELSH 40, 48/46, −2px; 34/36 at −1.4px on phones (`sections.css:75`, `:78`, `:758`).
- Sub: Geist 400, 18/27, body gray; 16/24 on phones (`sections.css:79`, `:760`).
- Site: `.s-head`, `.s-eyebrow`, `.s-h2`, `.s-h3`, `.s-sub` (`sections.css:73-86`).

### Buttons

One filled green button per group, then ghosts. 44 high, padding 0 20, radius 10, Geist 500 15/20; a row 12 × 20 apart.

```html
<div class="ak-actions">
  <a class="ak-btn" href="https://antseed.com/docs/quickstart/">Set up AI gateway</a>
  <a class="ak-btn ak-btn--ghost" href="https://antseed.com/docs/gateway/">Learn more</a>
</div>
```

- Filled: `#4f7a24`, white text; hover `#436a1e` by day, `#5b8a2b` at night; a soft drop, a pale inner line and a dark lip `inset 0 -2px 1px 0 #3b5e17` (`sections.css:91-94`).
- Ghost: the tile fill, a 1px tile hairline, a light lip (`sections.css:95-97`).
- At night: no pale lip and no drop shadow. The green keeps only its lip, the ghost a faint dark one (`sections.css:32-33`; D47).
- The style comes from astraos.io's buttons, in Antseed's greens (D56). The green is the same in both themes.
- On a phone, the two buttons of a product share a line or each takes a whole one (`ak-actions--stretch`; `sections.css:755-756`).

### Announcement pill

One fact and a chevron, over a painting: 24 high, padding 0 11, fully round, 12/16.

```html
<a class="ak-pill" href="…"><span>We raised <b>$2.4M</b>, led by Spark Capital</span><span class="chev" aria-hidden="true">(chevron svg)</span></a>
```

- By day white, as on the live hero (`index.html:273`). `ak-pill--acid` is the acid pill of the hero's other versions, by day only (`index.html:89-91`).
- At night neutral glass, `rgba(24, 29, 27, .78)`, so the hero's only green is its button (`index.html:315`; D40).
- The site sets it in Figtree; the kit sets it in Geist (one family set).
- The chevron is the site's `chevron-right.svg` path, drawn in the text color at half opacity.

### Figure

A small gray label over a pixel figure, 14 apart: Geist 400 13/16, then Geist Pixel ELSH 20, 30/30 (26/26 on phones), tabular numbers (`index.html:202-205`, `:213`). A larger version, `ak-figure--large`, is 40/44 (`sections.css:572`).

```html
<div class="ak-figure"><p class="ak-figure__label">Active users</p><b class="ak-figure__value">20,280</b></div>
```

- Figures are live. Read them from AntSeedStats (antseedstats.com), write the date of the read and credit it (CC BY 4.0). Never type a figure from memory. The two on the kit's page were read on 12 Nov 2026.
- On the site they count up once, when a third of the box is in view: 2200 ms, exponential ease-out `1 − 2^(−10k)`, grouping and decimals kept; none with reduced motion (`count.js:1-8`).

### Caption

A name in the text color, then one line in the body gray: Geist 16/24, the name in 500. Under a panel, 20 below it.

```html
<p class="ak-caption"><b>Open-source models</b> Run them on your own GPUs and set your own price.</p>
```

Site: `.s-cap` (`sections.css:416-417`).

### Feature list

One line each, no full stop. A pixelarticons glyph at 24 (so each of its pixels is a whole 2px) in the title gray, no tile; 12 between icon and text; a dotted line between rows, starting with the text.

```html
<ul class="ak-features">
  <li><i class="ak-icon" style="--icon: url(…/icons/pixel/blocks.svg)" aria-hidden="true"></i>Access to 700+ models at lower prices</li>
</ul>
```

Icon rules, as the site follows them:
1. Product features: pixelarticons (MIT), 24px, gray, no tile, one per line. The set in use: analytics, blocks, plug, lock, sliders-horizontal.
2. Third-party products: the maker's own mark, in color when it has one, never redrawn.
3. Inside an illustrated window: small line icons at 11 to 14px in the window's grays and greens, plus real payment marks in their own colors.
4. No icon on a square tile in a list. Tiles only inside a window, white at night.
5. No decorative icon on a heading or an eyebrow.

Site: `.s-feats`, `.f-ic` (`sections.css:236-244`).

### Model price card

A square, 176 (152 on phones), padding 18 (14), radius 11: the maker's mark top left, the saving top right (text models only), then the name (two lines at most), the price with its unit, and how many providers serve it.

```html
<li class="ak-card" style="--mark: url(…/icons/labs/moonshot.svg); --nodes: url(…/v6/net-bt-nodes.svg)">
  <div class="ak-card__top"><i class="ak-card__mark" aria-hidden="true"></i><em class="ak-card__saving">−99%</em></div>
  <b class="ak-card__name">Kimi K3</b>
  <p class="ak-card__foot"><code class="ak-card__price">$0.002<span>/M</span></code><span class="ak-card__providers"><i aria-hidden="true"></i>35</span></p>
</li>
```

- The maker's mark in color when one exists (`ak-card__mark--color`, from `icons/labs-color/`), otherwise the mono mark in the text color (`icons/labs/`).
- Units: `/M` (text, per million tokens), `/image`, `/s` (video), `/M chars` (voice).
- Prices are real and dated. The two on the kit's page were read from AntSeedStats on 12 Nov 2026: the lowest paid input price, and the saving on the lab's own price. Read them again before you use them. Never invent a model or a price.
- Site: `.s-mcard` (`sections.css:168-181`).

### Glass window over a landscape

Product captures (screenshots of the app) go in a glass window over a close crop of a landscape panel. By day the light window glass; at night every window over a landscape is the smoked green glass. The window pops in once: from .9 and faded, `opacity .55s ease-out, scale .9s cubic-bezier(.2, .9, .25, 1.12)` (`sections.css:116-117`).

```html
<div class="ak-panel" style="--paint-day: url(…/v02-day.webp); --paint-night: url(…/v02-night.webp)">
  <div class="ak-window"><!-- the capture --></div>
</div>
```

- `ak-panel` takes the day and the night file of a pair from `assets.json`; its own color shows until the painting loads (`sections.css:107`, `:110`).
- Keep the landscape suggested and close-cropped, so the UI stays legible.
- The capture is assets.json `desktop-anon`. Its sidebar and top bar are frosted by a mask, `assets/home/desktop/frost-mask.webp`, stretched over the capture itself (the `<img>`, or a flush panel inside `.ak-window`): it keeps the chat card whole and lays the app's chrome at 70 %, so the glass shows through (`sections.css:318-326`). Where the window runs off a panel, run it off by the whole sidebar (21 % of the capture) or not at all, so no piece of the sidebar is sliced, as `x-post-desktop` and slide 2 do. Serve it from the same site as the page: a browser refuses a mask from another site and the capture disappears. Copy HTML+CSS leaves the mask out for that reason and names the file.
- The app's own night (its navy) is the app's; this rule covers marketing assets only.

### Gateway terminal

The gateway is a command-line tool, so it is always a terminal, never a drawn app (D59). Smoked green glass in both themes, radius 8, a 34px title bar with the window lights, panes split by a dotted line, Geist Mono 11.475/20.06.

```html
<div class="ak-terminal">
  <div class="ak-terminal__bar"><span class="ak-terminal__lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="ak-terminal__title">antseed — zsh</span></div>
  <div class="ak-terminal__pane">
    <span class="ak-terminal__tag">Gateway</span>
    <p><b>~ $</b> <span class="c">antseed gateway start</span></p>
    <p>API-key gateway listening on <span class="u">http://127.0.0.1:8379/v1</span></p>
  </div>
</div>
```

- Text `#cbd8d0`; the prompt `#ddf988`; a command `.c` `#ecf3ee`; a URL `.u` `#d3f5e3`; JSON `.j` `#e6f0ea`; the caret `.cur` 7 × 13 in acid, blinking `1.1s steps(1)` (`sections.css:248-266`).
- Use the real commands and output of the gateway, as on the site (`sections.html:67-91`). On the site it types each command a key at a time (24 to 38 ms a key) and prints each answer whole; the box never changes size; printed in full with reduced motion (`sections.js:371-394`).
- Site: `.term`, `.t-bar`, `.t-pane`, `.t-tag` (`sections.css:246-270`).

### Surfaces

**Layout.** A white rail in dotted margins.
- Gutter `clamp(16px, 6.4vw, 96px)`, 96 at 1504 (`sections.css:36`).
- Rail `min(1312px, 100% − 2 × gutter)`, rounded down to a multiple of 16 (`sections.css:37`, `:45`).
- Inner margin `clamp(20px, 9.64vw, 145px)`, 145 at 1504 (`sections.css:38`).
- Sections padded 120 above and below, 72 at 760 and narrower (`sections.css:69`, `:745`).
- Every section a multiple of 8 high, so each top lands on a row of dots (`sections.js:59-71`).

```html
<div class="ak-page">
  <main class="ak-rail">
    <section class="ak-pad">…</section>
  </main>
</div>
```

**Radii**, after aside.com, nested (D55): card 11 > window 8 > popover 6 > control 5 > tile 3. Where a box shares a corner with the one holding it, the outer radius less the inset, 2 at least. Buttons 10, pills fully round (`sections.css:21`; `v6.css:18-23`).

**Glass.** One glass by day, the smoked green at night.
- Window glass, by day: `rgba(255, 255, 255, .62)`, a `.5px` white edge, `blur(10px)`, shadow `0 14px 40px rgba(20, 51, 89, .14)` (`v6.css:45-46`).
- Smoked green: `rgba(14, 33, 23, .64)`, edge `.5px rgba(150, 200, 145, .42)`, inner top light `.5px rgba(190, 228, 170, .16)`, `blur(10px) saturate(1.3)`, shadow `0 12px 32px rgba(8, 26, 14, .26)` (`sections.css:248-250`). The terminal in both themes, and every screen over a landscape at night (`v6.css:388-391`).
- Glass edges are half-pixel hairlines. Day glass casts a cool blue shadow, smoked glass a dark green one.

| Glass | Fill | Where | Source |
|---|---|---|---|
| G1 Window, by day | `rgba(255, 255, 255, .62)`, blur 10 | provider scene windows, `ak-window` | `v6.css:45-46` |
| G2 Smoked green | `rgba(14, 33, 23, .64)`, blur 10, saturate 1.3 | the terminal, every window at night, the hero's install block at night | `sections.css:248-250`; `v6.css:388-391`; `index.html:372` |
| G3 Thin smoked | `rgba(14, 33, 23, .3)`, blur 10, saturate 1.6, brightness .72 (night .95, saturate 1.5) | Private by design windows, both themes | `v6.css:267-274` |
| G4 Frosted popover | `rgba(255, 255, 255, .74)`, blur 12, saturate 1.2; night `rgba(16, 38, 26, .94)` | menus, the proof popover | `v6.css:275-277`, `:392-393` |
| G5 Desktop window | `rgba(250, 249, 244, .4)`, blur 10, saturate 1.2, a warm shadow | Antseed Desktop by day on the site. Not a kit token: in the kit a Desktop window is `ak-window`, G1 | `sections.css:313-317` |
| G6 Install block | `rgba(182, 180, 140, .11)`; live hero `rgba(255, 253, 219, .33)`, blur 7 | the hero's install block by day | `index.html:104-110`, `:274` |
| G7 Nav | `rgba(255, 255, 255, .78)`, blur 2.5; solid white on the live hero | the nav on the hero's other versions | `index.html:68-69`, `:271` |
| G8 Tag | `rgba(255, 255, 255, .42)`, blur 8, saturate 1.3 | the network's tags (in progress) | `sections.css:487-500` |
| G9 Tooltip | `rgba(255, 255, 255, .86)`, blur 12; night `rgba(16, 38, 26, .9)` | the network's tooltip | `sections.css:513-521` |
| G10 Logo tile | `rgba(255, 255, 255, .33)`; night `.9` | a small tile behind a maker's mark in a scene | `v6.css:48-49`, `:404` |

### Motion

Motion lives in one place: The dot, Motion (`#dot-motion` on the page): the principles, the four curves, the duration bands, the pieces and every motion token.

### Where each block comes from

Site at `main` ce969b4. The site's selectors, for finding; build with the `ak-` classes.

| Block | Kit class | Site selector | Source |
|---|---|---|---|
| Section head | `ak-head`, `ak-eyebrow`, `ak-title`, `ak-sub` | `.s-head`, `.s-eyebrow`, `.s-h2`, `.s-sub` | `sections.css:73-86` |
| Buttons | `ak-actions`, `ak-btn`, `ak-btn--ghost` | `.s-actions`, `.s-btn`, `.s-btn.ghost` | `sections.css:32-33`, `:90-97` |
| Announcement pill | `ak-pill`, `ak-pill--acid` | `.pill` | `index.html:89-94`, `:273`, `:315` |
| Figure | `ak-figure` | `.backers .fig` | `index.html:202-205` |
| Caption | `ak-caption` | `.s-cap` | `sections.css:416-417` |
| Feature list | `ak-features`, `ak-icon` | `.s-feats`, `.f-ic` | `sections.css:236-244` |
| Model price card | `ak-card` | `.s-mcard` | `sections.css:168-181` |
| Landscape panel | `ak-panel` | `.wash.land` | `sections.css:107-117` |
| Glass window | `ak-window`, `ak-window--smoked` | `.v6c-win` (G1), at night G2 | `v6.css:45-46`, `:388-391` |
| Gateway terminal | `ak-terminal` | `.term`, `.t-bar`, `.t-pane` | `sections.css:246-270` |
| Layout | `ak-page`, `ak-rail`, `ak-outline`, `ak-pad` | `.s-page`, `.s-rail`, `--dt --dr --db --dl` | `sections.css:34-70`; `sections.js:59-71` |

### Tokens for these blocks

<!-- tokens:start space radius glass button -->

**space** — Use for UI. One 8px rhythm; the rail and its margins are clamps measured on Figma's 1504-wide frame.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| grid | `8px` | `--space-grid` | The grid: the dot pitch, and every section's height snaps to a multiple of it so section tops land on the dots. | 8px | hero/sections.css:41-43; hero/sections.js:61-64 |
| body-gutter | `16px` | `--space-body-gutter` | The hero card floats 16px from the screen's edges. | body padding | hero/index.html:58 |
| gutter | `clamp(16px, 6.4vw, 96px)` | `--space-gutter` | The dotted margin on each side of the rail (96 at 1504). | --gut | hero/sections.css:36 |
| rail-max | `1312px` | `--space-rail-max` | The rail's widest. | 1312px in --rail | hero/sections.css:37 |
| rail | `min(1312px, 100% - 2 * clamp(16px, 6.4vw, 96px))` | `--space-rail` | The rail's width; rounded down to a multiple of 16 where round() is supported (components.css .ak-rail), so its edges land on the dots. | --rail | hero/sections.css:37, :45 |
| pad | `clamp(20px, 9.64vw, 145px)` | `--space-pad` | The rail's inner margin (145 at 1504). | --pad | hero/sections.css:38 |
| section | `120px; (max-width: 760px): 72px` | `--space-section` | A section's top and bottom padding; 72px at 760px and below. | .s-pad | hero/sections.css:69, :745 |
| head-gap | `20px` | `--space-head-gap` | Between eyebrow, title and sub in a section head. | .s-head gap | hero/sections.css:84 |
| head-gap-tight | `16px` | `--space-head-gap-tight` | The same in a product half or the prices head. | .s-duo-head gap | hero/sections.css:133, :231 |
| head-to-content | `64px; (max-width: 760px): 40px` | `--space-head-to-content` | From a section head to its panel or cards; 40px at 760px and below. | margin-top 64px | hero/sections.css:412, :446, :782 |
| actions-row | `12px` | `--space-actions-row` | Row gap in a row of buttons. | .s-actions gap | hero/sections.css:90 |
| actions-column | `20px` | `--space-actions-column` | Column gap in a row of buttons (12 in a product half). | .s-actions gap | hero/sections.css:90, :233 |
| duo-pad | `64px` | `--space-duo-pad` | Padding of a product half's text. | .s-duo-text padding | hero/sections.css:230 |
| duo-gap | `36px` | `--space-duo-gap` | Between head, list and buttons in a product half. | .s-duo-text gap | hero/sections.css:230 |
| card-gap | `24px` | `--space-card-gap` | Between cards. | .s-cards gap | hero/sections.css:410 |
| feature-row | `8px` | `--space-feature-row` | A feature line's top and bottom padding. | .s-feats li padding | hero/sections.css:237 |
| icon-gap | `12px` | `--space-icon-gap` | From a feature icon to its text. | .s-feats li gap | hero/sections.css:237 |
| icon | `24px` | `--space-icon` | A pixel icon: 24px, so each of its pixels is a whole 2px. | .f-ic | hero/sections.css:244 |
| phone | `760px` | `--space-bp-phone` | Breakpoint: phones at this width and below (one column, 72px sections, smaller titles). Media queries cannot read variables: write the number. | @media (max-width: 760px) | hero/sections.css:744 |
| stack | `899px` | `--space-bp-stack` | Breakpoint: product halves and points stack at this width and below. | @media (max-width: 899px) | hero/sections.css:697 |
| tight | `1199px` | `--space-bp-tight` | Breakpoint: section grids tighten at this width and below. | @media (max-width: 1199px) | hero/sections.css:688 |

**radius** — Use for UI. Nested from the card (aside.com's scale, Elio's reference): what sits inside takes the next one down; where a box shares a corner with its parent, the outer radius less the inset, 2 at least. Buttons 10. Kit merge: the site's 12 and 14 leftovers are folded into this scale.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| card | `11px` | `--radius-card` | Cards, card panels, model cards, the $ANTS and Private panels, the tooltip. | --r-card | hero/sections.css:21 |
| window | `8px` | `--radius-window` | A window in a card; the Gateway terminal; the Desktop window. | --r-win | hero/v6.css:23; hero/sections.css:248 |
| popover | `6px` | `--radius-popover` | Popovers and menus. | --r-pop | hero/v6.css:23 |
| control | `5px` | `--radius-control` | Fields, buttons and rows inside a window. | --r-ctl | hero/v6.css:23 |
| tile | `3px` | `--radius-tile` | Small tiles, checkboxes. | --r-sm | hero/v6.css:23 |
| min | `2px` | `--radius-min` | The floor where a box shares a corner with the one holding it. | --r-min | hero/v6.css:23 |
| button | `10px` | `--radius-button` | Every page button, primary and ghost. | border-radius: 10px on .s-btn, .cta | hero/sections.css:91; hero/index.html:74 |
| pill | `999px` | `--radius-pill` | The announcement pill. | .pill | hero/index.html:89 |

**glass** — Use for UI over paintings. By day the light window glass; at night every screen over a landscape is the smoked green glass. The Gateway terminal is smoked green in both themes.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| day | `background: rgba(255, 255, 255, .62); border: .5px solid #fff; shadow: 0 14px 40px 0 rgba(20, 51, 89, .14); backdrop: blur(10px)` | `--glass-day` | Day window glass over a landscape. | .v6c-win | hero/v6.css:45-46 |
| smoked | `background: rgba(14, 33, 23, .64); border: .5px solid rgba(150, 200, 145, .42); shadow: 0 12px 32px 0 rgba(8, 26, 14, .26), inset 0 .5px 0 0 rgba(190, 228, 170, .16); backdrop: blur(10px) saturate(1.3)` | `--glass-smoked` | Smoked green glass: the Gateway terminal in both themes, and every window over a landscape at night. | .term; night .v6c-win | hero/sections.css:248-250; hero/v6.css:388-391 |
| smoked-text | `text: #cbd8d0; strong: #ecf3ee; chrome: #d5ddd9; prompt: #ddf988; url: #d3f5e3; json: #e6f0ea; cursor: #c8f53c; dot: rgba(150, 196, 150, .22); bar: rgba(150, 200, 145, .06)` | `--glass-smoked` | Colours on smoked glass (the terminal): body text, commands, window chrome, the prompt, URLs, JSON, the caret, its dotted lines and its title bar. Tuned for 4.5:1 over a bright sky. | .term, .t-bar, .term .c/.u/.j/.cur | hero/sections.css:248-265 |
| smoked-thin | `background: rgba(14, 33, 23, .3); border: .5px solid rgba(150, 200, 145, .42); shadow: 0 12px 32px 0 rgba(8, 26, 14, .22), inset 0 .5px 0 0 rgba(190, 228, 170, .16); backdrop: blur(10px) saturate(1.6) brightness(.72); backdrop-night: blur(10px) saturate(1.5) brightness(.95)` | `--glass-smoked-thin` | Thinner smoked glass (Private by design's windows, both themes): more painting shows; the frost dims what is under it so light text still reads. | --pv-glass, --pv-frost | hero/v6.css:268-275 |
| popover | `background: rgba(255, 255, 255, .96); border: .5px solid rgba(10, 26, 18, .08); shadow: 0 10px 28px 0 rgba(20, 51, 89, .2); backdrop: blur(6px)` | `--glass-popover` | A menu or popover by day. | .v6c-menu | hero/v6.css:52-53 |
| popover-night | `background: rgba(16, 38, 26, .94); border: .5px solid rgba(150, 200, 145, .34); shadow: 0 10px 28px 0 rgba(0, 0, 0, .34)` | `--glass-popover-night` | A menu or popover at night: the same green, denser. | night .v6c-menu | hero/v6.css:392-393 |
| pill | `background: #fff; ring: inset 0 0 0 1px #fff; backdrop: blur(2px)` | `--glass-pill` | The announcement pill by day, as on the live hero (Whimsical 2). | .whimsical .pill | hero/index.html:273 |
| pill-acid | `background: #c8f53c; ring: inset 0 0 0 1px rgba(9, 11, 12, .06), inset 0 0 0 1px rgba(255, 255, 255, .75); backdrop: blur(7px)` | `--glass-pill-acid` | The acid pill of the hero's other versions, ink text. By day only. | .pill | hero/index.html:89-91 |
| pill-night | `background: rgba(24, 29, 27, .78); ring: inset 0 0 0 .5px rgba(236, 238, 233, .16); backdrop: blur(6px)` | `--glass-pill-night` | At night the pill is neutral glass, so the hero's only green is its button. | dark .pill | hero/index.html:315 |

**button** — Use for UI. One filled green button per group, then ghosts. Same radius for both.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| height | `44px` | `--button-height` | Every page button. | .s-btn height | hero/sections.css:91 |
| padding-x | `20px` | `--button-padding-x` | Side padding. | .s-btn padding | hero/sections.css:91 |
| shadow-light | `0 3.5px .5px 0 rgba(46, 74, 14, .1), inset 0 -.5px 0 0 rgba(200, 230, 170, .63), inset 0 -2px 1px 0 #3b5e17` | `--button-shadow-light` | Primary by day: a soft drop, a pale lip, the green lip. | .s-btn box-shadow | hero/sections.css:93 |
| shadow-dark | `inset 0 -2px 1px 0 #3b5e17` | `--button-shadow-dark` | Primary at night: only the green lip. | dark .s-btn box-shadow | hero/sections.css:32 |
| ghost-shadow-light | `0 1.5px 0 0 rgba(255, 255, 255, .6), inset 0 -1px 2px 0 rgba(48, 56, 44, .2)` | `--button-ghost-shadow-light` | Ghost by day. | .s-btn.ghost box-shadow | hero/sections.css:96 |
| ghost-shadow-dark | `inset 0 -1px 1px 0 rgba(0, 0, 0, .2)` | `--button-ghost-shadow-dark` | Ghost at night. | dark .s-btn.ghost box-shadow | hero/sections.css:33 |

<!-- tokens:end -->

## Voice

The friendly half of the brand lives in the mascot, the motion and the paintings, so the words stay straight: plain, concrete, short, in the second person. Humor is the ant's job, not the copy's: jokey taglines were turned down for earnest lines (Elio, 7 Nov). The copy starts from antseed.com's own, kept on purpose (26 Oct), and Pranit owns it: changes go through him.

On the kit's page the title is "Plain words. / The ant does the jokes." (kit copy, to approve).

### How the copy sounds

- Plain and concrete: each sentence says what happens. "Your device finds providers over Mainline DHT, the same network BitTorrent uses, talks to them directly, and pays per request. Nobody sits in the middle." (`hero/sections.html:313`)
- Second person: your agents, your computer, you pay less than the lab.
- Technical ideas through things techies know: "Like BitTorrent, but for AI." (`hero/sections.html:312`); the FAQ compares with OpenRouter and Netflix (`:373`, `:381`).
- Reassurance in a short clause: "but you never have to touch it" (`:152`), "nothing to set up" (`:302`), "or start free" (`:128`).
- Short: a subtitle is one or two sentences, a feature one line, a caption a name and one sentence.
- No jokes or puns in the words. The ant puts on sunglasses when Private is on; the sentence beside it stays straight.

### Patterns

| Pattern | Rule | Example | Source |
|---|---|---|---|
| Two-part headline | A statement, then its completion in gray (`--color-text-grey`). Sentence case. Section titles end with a period; the H1 does not | "An API key / for every agent." | `hero/sections.html:56`, `hero/sections.css:78` |
| H1 | A name, not a sentence; two tones; no period | "The open / intelligence network" | `hero/index.html:424` |
| Eyebrow | The product or the topic, then " ›", in Geist Pixel, green, above the title; links to the matching docs page | "Antseed Gateway ›" | `hero/sections.html:54`, `hero/sections.css:80-83` |
| Feature line | One idea, starting with the verb or the benefit. Sentence case, no period; it breaks where the sense does | "Access to 700+ models at lower prices" | `hero/sections.html:60`, `:130` |
| Caption | A name in the text color, then one sentence with a period, in the body gray | "**Pay per request** Every payment settles in USDC on Base." | `hero/sections.html:323`, `hero/sections.css:416-417` |
| Buttons | A verb, then two or three words. One filled button, then ghosts; the second is "Learn more" or a docs name | "Get Antseed Desktop", "Learn more"; "Become a provider", "Join Colony"; "Read the lightpaper", "Staking docs" | `hero/sections.html:132`, `:243`, `:341` |
| Arrows | → to the docs or a dialog in running text, ↗ to another site, › after an eyebrow | "Gateway docs →", "See all available models ↗" | `hero/index.html:437`, `hero/sections.html:42` |
| Announcement | No launch pattern exists yet. A post about a product reuses its section: eyebrow = the product, title = the section's title, and the section's button in the post's text, never on the image. Never "new", "now available", a version or a price until Pranit approves a launch line | Eyebrow "Antseed Desktop ›", title "Ask anything, / on any model.", the link https://github.com/Antseed/antseed/releases/latest | `hero/sections.html:122-132` |
| Post text | One or two of the site's sentences, then the link. The image's alt text: its title, then what it shows | "Antseed runs on your computer. Your chat, your agents and your apps all go through it." | `hero/sections.html:125` |
| Meta line | A middle dot between the parts | "1.04B cap · weekly epochs · burns", "Kimi K3.1 · in a TEE · signed by 0x7a…3f" | `hero/sections.html:359`, `:115` |

Geist's Latin subset from Google Fonts has no → or ↗: load them on their own, as tokens.css says (`hero/sections.css:5-6`).

### Names

| Name | Write | Never | Source |
|---|---|---|---|
| Antseed | One word, capital A only. The organization is Antseed Foundation | ANTSEED, AntSeed or Ant-Seed in text: the capitals belong to the wordmark | `hero/sections.html:407` |
| Antseed Desktop | Antseed Desktop; "Desktop app" on the hero's tab; "Download Desktop" in the nav | "AI VPN", its name until 9 Nov | commit `9ac30e8`; `hero/index.html:420`, `:430` |
| Antseed Desktop, the facts | As the site states them: on macOS (Apple Silicon and Intel), Windows (x64) and Linux (AppImage, x86_64 and ARM64); "Get Antseed Desktop" links to https://github.com/Antseed/antseed/releases/latest, "Learn more" to https://antseed.com/docs/desktop/. Launch lines (a one-liner, the platforms to name, the call to action): none yet, Pranit owns them | A version, a price, "new" or "now available" | `hero/index.html:447-451`; `hero/sections.html:122`, `:132` |
| Antseed Gateway | The product name in an eyebrow; "Gateway" in the nav and footer; "the gateway", lowercase, in running text. It is a command-line tool | — | `hero/sections.html:54`, `:17` |
| Colony | Colony, "Join Colony"; its copy is a placeholder until Pranit writes it | — | `hero/sections.html:236-243`, `:290` |
| $ANTS, ANTS | $ANTS for the token's name, ANTS for the unit: "10.5M ANTS burned" | — | `hero/sections.html:336-338`, `:355` |
| Private | Capitalized as Antseed Desktop's mode: "Go Private" | — | `hero/sections.html:130` |
| AntSeedStats | As written, with ↗ when it is a link | — | `hero/sections.html:403` |
| USDC, Base, TEE, Mainline DHT, BitTorrent | As written: "USDC on Base", "TEE providers" | — | `hero/sections.html:152`, `:146`, `:313` |
| Model names | As AntSeedStats names them on a price card ("Claude Opus 5.5"); lowercase API ids inside app windows ("kimi-k3.1-pro") | A model, a price or a feature that is not on the network | `hero/models.json`; `hero/sections.html:199` |

### Words

| Say | Not | Why |
|---|---|---|
| network | "market" in the one-liner | The team does not like "market" (Pranit, 6 Nov). "Open market" stays as a caption (`hero/sections.html:322`) |
| Nobody sits in the middle. | hub, center or middleman as a picture | Antseed has no middleman: say what is absent (`hero/sections.html:313`) |
| No crypto needed. | crypto first; "decentralized"; "web3" | Crypto is named only to say you don't need it ("Payments settle in USDC on Base, but you never have to touch it.", `:152`). Neither word appears in the site's copy; the FAQ calls OpenRouter "centralized" |
| peer-to-peer, P2P, onchain (one word), settle, request, provider, buyer, API key, endpoint, open models, TEE, signed responses | — | The site's own words |

Taglines: "The open intelligence network" is the H1 and the name line (`hero/index.html:424`). antseed.com's "The open market for AI inference" is replaced. "Like BitTorrent, but for AI.", "Private by design." and "Nobody sits in the middle." can be reused as they are.

### Numbers

| Case | Write | Example | Source |
|---|---|---|---|
| Thousands | Comma groups (en-US) | 19,252 | `hero/index.html:532`; `hero/count.js:17` |
| Large counts | One decimal and a letter | 742.8B · 141.5M · 10.5M | `hero/index.html:614`; `hero/sections.js:361` |
| In a sentence | Spelled out | "A hard cap of 1.04 billion" | `hero/sections.html:359` |
| Model count in a title | A round number and a plus (the live count is higher) | 700+ | `hero/sections.html:29` |
| Money | Dollar sign; a letter for millions | $2.4M · $20 | `hero/index.html:423`; `hero/sections.html:161` |
| Prices | Two decimals from $0.10 up, two significant digits below, then the unit: /M (a million tokens), /image, /s, /M chars | $0.0031 /M | `hero/sections.js:162-163`; `hero/models.json` |
| Savings | A true minus sign (−, not -) | −98% | `hero/sections.js:166` |
| Token amounts | The number, then the unit | 0.0021 USDC | `hero/sections.html:217` |
| Epochs | The word, then the number | Epoch 30 | `hero/sections.html:356` |
| Addresses, hashes | First and last characters around an ellipsis | 0x7a…3f · sha256 9f2c…e41a | `hero/sections.html:115`, `:188` |
| On screen | Geist Pixel, tabular figures, counting up once when seen; with reduced motion they do not count | — | `hero/index.html:205`; `hero/count.js:1-8` |

### Live figures

Every figure comes from AntSeedStats' API, which is CC BY 4.0: give the date it was read and credit it, for example "Data: AntSeedStats, 12 Nov 2026" (format proposed, to approve). The site reads its figures live and keeps the date of the last read (`hero/models.json`, `"read": "2026-11-12"`; `models-refresh.mjs:1-2`). A figure typed by hand goes stale: read it again before anything ships. Never invent one.

### Spelling and punctuation

- American spelling, as the site's FAQ ("centralized", `hero/sections.html:374`).
- No Oxford comma, unless it prevents a misreading.
- Sentence case everywhere: titles, eyebrows, buttons, feature lines.
- Contractions are fine: can't, you're, don't.
- An ampersand only in a short label: "Models & prices", "Older versions & .deb packages" (`hero/sections.html:402`, `hero/index.html:452`).

### About Antseed (boilerplate, proposal)

Built only from sentences already on the site (`hero/index.html:424`; `hero/sections.html:313`, `:322`, `:323`, `:17`). Pranit to approve.

> Antseed is the open intelligence network. Your device finds independent providers over Mainline DHT, talks to them directly and pays per request in USDC on Base. Nobody sits in the middle. Use the gateway to manage shared access, or Antseed Desktop to connect the tools on your computer.

### Open items

- Spelling: a few newer site lines are British ("specialised", `hero/sections.html:288`; "authorised", "recognised", `:360`; "Summarise", `:114`) while the rule is American.
- The Oxford comma: antseed.com's lines keep it ("agents, apps, and team", `hero/sections.html:16`; "agent, app, or teammate", `:57`), the new ones do not (`:125`).
- "Light paper" in the footer (`hero/sections.html:404`), "lightpaper" on the button (`:341`).
- "Set up gateway" in the nav (`hero/index.html:420`), "Set up AI gateway" on the hero's tab and in the Gateway section (`hero/index.html:431`, `hero/sections.html:64`).
- "Download Desktop" (nav), "Download for macOS" (hero, `hero/index.html:441`), "Get Antseed Desktop" (`hero/sections.html:132`).
- "join the Colony" (`hero/sections.html:242`) and "Join Colony" (`:243`).
- Whether antseed.com's "Run your agents on your terms." comes back as a second line.
- Antseed Desktop's launch lines: none yet. Until Pranit writes them, a Desktop post reuses the Desktop section's lines.
- The mascot has no name yet.
- Lines and figures in the Shader Lab's poster copy that are not on the site are not brand lines until approved.
- Kit copy to approve: the section's title, the wording of these rules, the boilerplate and the credit format.

## Make

Start every post, banner, link preview or deck from a template in `templates/`. Each is a section of the homepage at a platform's exact size, made only of `tokens.css`, `components.css` and the site's own files, filled by URL parameters and exported as a still. Nothing new is drawn, so what comes out traces back to the homepage. When no template fits the format, use the Shader Lab's Poster mode to explore, then hold the result to this guide: the kit is the reference, the lab is not.

### Formats

The formats the team needs, as listed on 12 Nov. The slides take the lab's 16:9 size (lab/shader-lab/poster/layout.js:11).

| Format | Size | Ratio | Start from |
|---|---|---|---|
| X post | 1600 × 900, or 1200 × 675 | 16:9 | `templates/x-post-desktop.html`, `templates/x-post-gateway.html`, `templates/x-post-ants.html`: the one for your product |
| X header | 1500 × 500 | 3:1 | `templates/x-header.html` |
| LinkedIn company cover | 1128 × 191 | 5.9:1 | `templates/linkedin-company.html` |
| LinkedIn personal banner | 1584 × 396 | 4:1 | Not yet |
| Link preview (Open Graph) | 1200 × 630 | 1.91:1 | `templates/og.html` |
| Slides | 1920 × 1080 | 16:9 | `templates/slides.html` |
| Square post | 1080 × 1080 | 1:1 | Shader Lab, Poster |
| Portrait post | 1080 × 1350 | 4:5 | Shader Lab, Poster |
| Story | 1080 × 1920 | 9:16 | Shader Lab, Poster |
| Print poster | A3 portrait, 2480 × 3508 (the lab's size, about 212 dpi at A3; 300 dpi needs 3508 × 4961) | — | Shader Lab, Poster |

Safe zones: only X's is known. X lays the profile picture over the header's bottom left, so type and logo go on the right. The other platforms' safe zones are not measured yet: do not invent them.

### The templates

Each is a page at its exact pixel size. Inside it, a board at a smaller size carries the homepage's section with every size the site's own (the title 48/46, the H1 90/93, the terminal's 11.475 px), and the board is drawn at a scale that fills the format. The words are the site's own lines.

| Template | Size | Board | What | Built from |
|---|---|---|---|---|
| `x-post-desktop.html` | 1600 × 900 | 1024 × 576 at 1.5625× | The Desktop section: the app's capture in a glass window over v02, running off the panel's outer edge by the app's whole sidebar, beside eyebrow "Antseed Desktop ›", title "Ask anything, / on any model." and the sub | v02, desktop-anon; `ak-window`, `ak-title`, `ak-eyebrow`, `ak-sub`, `ak-panel--flush`, `ak-outline--all`; `--glass-day-*`, `--glass-smoked-*`; hero/sections.html:102-127, sections.css:229-233, :277, :311-326 |
| `x-post-gateway.html` | 1600 × 900 | 1024 × 576 at 1.5625× | The Gateway section: eyebrow "Antseed Gateway ›", title "An API key / for every agent.", the terminal's first lines on smoked glass over v01, ending inside the panel | v01; `ak-terminal`, `ak-title`, `ak-eyebrow`, `ak-panel--flush`, `ak-outline--all`; `--glass-smoked-*`, `--type-section-title`, `--type-eyebrow`; hero/sections.html:54-89, sections.css:229-233, :248, :702 (the terminal placed as in the site's narrower panels) |
| `x-post-ants.html` | 1600 × 900, day and night | 1024 × 576 at 1.5625× | The $ANTS section: eyebrow "$ANTS ›", title "$ANTS, / the network's trust layer.", the figure 1.04B labeled "Hard cap", the amazed ant and the green coin over v10 | v10, token-ant (with its two pupils), coin; `ak-figure--large`, `ak-character`, `ak-panel`; `--illustration-coin-shadow`, `--illustration-coin-night-glow`, `--filter-character`; sections.html:336-359, sections.css:545-563 |
| `og.html` | 1200 × 630 | 960 × 504 at 1.25× | The hero: the H1 "The open / intelligence network" in the sky of Whimsical 2, the logo on a paper plate where the nav puts it | hero, logo-lockup; `ak-h1`, `ak-panel`, `ak-logo`; hero/index.html:61, :68-69, :86-99, :424 |
| `x-header.html` | 1500 × 500 | 750 × 250 at 2× | The footer's wide meadow cropped to 3:1, the logo on a paper plate at the right | footer, logo-lockup; `ak-panel--flush`, `ak-logo`; footer.css:9-13 (110 % wide, 2 % off the left so the torn paper edges stay outside, held at 46 % 100 %) |
| `linkedin-company.html` | 1128 × 191 | at 1× | The same, cut to 5.9:1 | footer, logo-lockup |
| `slides.html` | 1920 × 1080 | 1280 × 720 at 1.5× | `?slide=1` title (the hero), `2` duo (Antseed Desktop: the app's capture in a glass window over v02, beside the eyebrow, title, sub and three features), `3` stat (one figure read live, beside v04), `4` closing (the footer: the logo, the meadow fading in through its sky). `?slide=all` shows the four | hero, v02, v04, footer, logo-lockup, icon-blocks, icon-plug, icon-lock, desktop-anon; `ak-h1`, `ak-window`, `ak-features`, `ak-icon`; sections.html:100-130, sections.css:277, :313; hero/index.html:616-618; footer.css:5-13; sections.css:654, :656 |

Every template loads `../tokens.css`, `../components.css`, Geist and Geist Mono from Google Fonts and the site's files at `../../assets/`; nothing else. Open them where the kit is served (`<url>/brand/templates/`); a copy outside it, as in the zip, is a reference to start from. The PNG exports are ready to use; they are downloaded from this page or `<url>/brand/templates/png/`, and the kit zip leaves them out to stay light. Their records, with their exports:

<!-- assets:start kind=template -->

| ID | Kind | Subject | Size | Status | Day / file | Night | Used on | Recipe |
|---|---|---|---|---|---|---|---|---|
| tpl-x-post-gateway | template | X post, Gateway: the eyebrow, the two-tone title and the smoked terminal over v01; the homepage's Gateway section on a 1024 × 576 board at 1.5625× | 1600 × 900 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/x-post-gateway-day.png | templates/png/x-post-gateway-night.png |  |  |
| tpl-x-post-desktop | template | X post, Antseed Desktop: the eyebrow, the two-tone title and the sub beside the app's capture in a glass window over v02; the homepage's Desktop section on a 1024 × 576 board at 1.5625× | 1600 × 900 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/x-post-desktop-day.png | templates/png/x-post-desktop-night.png |  |  |
| tpl-x-post-ants | template | X post, $ANTS, day and night: the two-tone title, the hard cap 1.04B, the amazed ant and the green coin over v10; the homepage's $ANTS section on a 1024 × 576 board at 1.5625× | 1600 × 900 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/x-post-ants-day.png | templates/png/x-post-ants-night.png |  |  |
| tpl-og | template | Link preview (Open Graph): the H1 in the sky of Whimsical 2, the logo on paper; the hero on a 960 × 504 board at 1.25× | 1200 × 630 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/og-day.png | templates/png/og-night.png |  |  |
| tpl-x-header | template | X header: the wide meadow cropped to 3:1, the logo on a paper plate at the right, clear of the profile picture; a 750 × 250 board at 2× | 1500 × 500 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/x-header-day.png | templates/png/x-header-night.png |  |  |
| tpl-linkedin-company | template | LinkedIn company cover: the wide meadow cropped to 5.9:1, the logo on a paper plate at the right; at 1× | 1128 × 191 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/linkedin-company-day.png | templates/png/linkedin-company-night.png |  |  |
| tpl-slides-1 | template | Slide 1, title: the H1 in the sky of Whimsical 2, the logo on paper; the hero on a 1280 × 720 board at 1.5× | 1920 × 1080 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/slides-1-day.png | templates/png/slides-1-night.png |  |  |
| tpl-slides-2 | template | Slide 2, duo: Antseed Desktop, the app's capture in a glass window over v02, then the eyebrow, title, sub and three features | 1920 × 1080 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/slides-2-day.png | templates/png/slides-2-night.png |  |  |
| tpl-slides-3 | template | Slide 3, stat: one figure, read live from AntSeedStats when the slide opens and printed with the day of the read (or the $ANTS hard cap), beside v04 | 1920 × 1080 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/slides-3-day.png | templates/png/slides-3-night.png |  |  |
| tpl-slides-4 | template | Slide 4, closing: the footer; the logo on paper, the wide meadow under it, its sky fading into the paper | 1920 × 1080 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/slides-4-day.png | templates/png/slides-4-night.png |  |  |

<!-- assets:end -->

### Fill a template

Every slot is a URL parameter named as its `data-slot` attribute. `templates/README.md` lists every slot of every template with its default.

- A template is for its own product: an X post template refuses an eyebrow that names another product (a warning in the console, and the default stays).
- Text slots: `eyebrow`, `title` (the first half of the two-tone title), `title2` (the gray second half), `sub`, `label`, and `f1` `f2` `f3` on the duo slide. `%0A` breaks a line; an empty value hides the slot. Keep the site's patterns: a two-part title whose second half completes the first, sentence case, a period at the end of a section title and none on the H1, an eyebrow that names the product or the topic.
- `bg`: a painting's `id` in `assets.json`. The template takes its day and its night file; a retired painting is refused and the default stays.
- `theme`: `light` (the default), `dark` or `system`. Every template has its night, from tokens.css and the painting's night file.
- `still`: the state to export, at the exact size with no motion. Without it the page fits the window and moves as the site does (the coin floats, the pupils tremble, the cursor blinks); with reduced motion it is still.
- `slide`: `1` to `4`, or `all` (slides only; with `all` no text slot is filled).

Example: `templates/x-post-ants.html?title=$ANTS,&title2=the%20network's%0Atrust%20layer.&bg=v10&theme=dark&still`

### Figures

A figure is never typed by hand (the kit's checklist: real numbers, read from AntSeedStats, dated and credited).

- The stat slide reads AntSeedStats' API when it opens, as the site's figure band does (hero/index.html:616-618): `stat=models` (the default; `/api/v1/models?limit=1`, `data.total`) or `stat=providers` (`/api/v1/network/summary`, `data.lifetime.sellers`), formatted as the site formats them (a billion and up as 1.2B, otherwise 19,252). It prints "AntSeedStats · read <day> · CC BY 4.0". If the API does not answer, it shows a dash, never an old number.
- `stat=cap` shows the $ANTS hard cap, 1.04B, as the site writes it (sections.html:354, :359). The $ANTS post shows only that figure.
- Any other figure (`figure=` on the $ANTS post or the stat slide) needs `read=YYYY-MM-DD`, the day it was read, and is credited to `source` (AntSeedStats by default). Without `read` it is ignored.

### Export

The kit ships an exporter, `templates/export.mjs` (Node 22 or later, no dependencies, Google Chrome). It opens each template with `still` at its exact size, waits until the page says it is ready (`data-ready="true"` on `<html>`: its fonts, its painting and its figure are in) and every image has loaded, then writes day and night:

```text
node templates/export.mjs "<url>/brand/templates/" png x-post-desktop
```

The last word picks the files whose name contains it (none: every template). Chrome is found at the macOS default; set `CHROME` to its binary elsewhere. It runs on a throwaway profile and closes Chrome at the end, or after two minutes.

By hand, headless Chrome needs its full path on macOS, its own profile and a time limit, and it does not wait for `data-ready`, so check the result:

```text
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --user-data-dir="$(mktemp -d)" \
  --hide-scrollbars --window-size=1600,900 --virtual-time-budget=10000 --timeout=20000 \
  --screenshot=x-post-ants-night.png "<url>/brand/templates/x-post-ants.html?still&theme=dark"
```

The exports in `templates/png/` were made that way, day and night, on 12 Nov 2026 (the stat slide read 924 models that day); `templates/preview/` holds 960 px WebP copies for the kit's page.

### Slides in Google Slides

Google Slides cannot load the variable Geist Pixel (Pranit, Loom of 11 Nov). In order:

1. Place the exported slides, or the titles, as images. The title maker in Type (#type) exports a title as SVG or PNG.
2. If Slides lists Geist Pixel, use it: same metrics, but the solid shape instead of the dots.
3. Otherwise Doto 600 for titles, eyebrows and figures, 700 on dark slides, set about 15 % smaller.

Geist falls back to Inter, Geist Mono to JetBrains Mono. Not yet checked in Slides.

### A new file outside the kit

Copying `tokens.css` next to a new file breaks its Geist Pixel path without a sign: the titles fall back to Geist and still look like titles. So:

- Link the kit's files where they are served, by their full address: `<url>/brand/tokens.css` and `<url>/brand/components.css`, and the site's images at `<url>/assets/…` (the planned address is https://antseed-home.vercel.app; it may change).
- Never copy `tokens.css` without its font: in the zip, `tokens/tokens.css` points at `../fonts/`, so keep the zip's folders together.
- Before you export, check that the pixel face is in: `document.fonts.check('48px "Geist Pixel Var"')` must be true.

### Posts: what goes with the image

- A template is for its own product. Never put another product's lines, terminal or capture in it: a Desktop post starts from `x-post-desktop`, a Gateway post from `x-post-gateway`. The X post templates refuse an eyebrow that names another product.
- X posts carry no logo (the account's avatar does) and no button: the link goes in the post's text.
- The post's text: one or two of the site's sentences, then the link. The image's alt text: its title, then what it shows.
- No launch copy exists yet. Never write "new", "now available", a version or a price for Antseed Desktop; ask Pranit.

### Shader Lab by AstraOS

An exploration tool; the kit is the reference. It is at `lab/` (it opens `lab/shader-lab/`).

Open the lab, pick Poster and press Generate (or G) until one speaks to you; ← and → step back through the last 50.
Tick Lock on what you want to keep (painting, mascot, colours, text) and generate again, then export as PNG or SVG, or Copy for Figma.

The lab draws from the current brand: Whimsical 2 day and night with its film, the footer meadows, the network map and the vignettes v01 to v11, day and night; the round two-legged ant only (You, Provider, User; walking; the network's reactions; Private and $ANTS, kept small); the site's own lines, with no figures (a poster that needs one takes it from AntSeedStats, typed into Details); the logo in a free corner of the paper, never on the painting (or none when no corner is free).

Three posters to start from, each a share link that reopens the same poster (`lab/#…`): "Nobody sits in the middle." (Lime, round dots, the ant receiving a seed), "The open intelligence network" (Sky, halftone, v07's hills, the Private ant) and "Ask anything, on any model." (Night rail, dither, colony dots, Whimsical 2, the ant sending). The links are on the kit's page, in Make.

For Figma, use the lab's Copy for Figma or its SVG export; the Figma plugin is on request. There is no Figma library in v1: the coded kit, the lab's Copy for Figma and its SVG exports replace it. Hold anything made in the lab to this guide before it ships: the logo on paper, the site's own lines, no figure typed by hand.

### Rules for anything made

- Start from a template or the lab; never from a blank canvas when a template fits.
- The logo sits on paper (the rail's color) or frosted glass, with its clear space, never straight on a painting; it is never redrawn or regenerated.
- The Gateway is always a terminal, never a drawn interface (D59). Product captures go inside a glass window over a landscape (assets.json desktop-anon); the app keeps its own UI and its own night (DECISIONS.md K19).
- A template is for its own product; X posts carry no logo and no button, the link goes in the post's text.
- Titles are Geist Pixel, two tones, the second half gray. The words are the site's own lines or approved new ones: no invented product facts, models or prices.
- Every image has its night: export both.
- The coin is green with the white Antseed mark; no gold anywhere.

### Open items for Make

- Kit copy to approve: the title "Make / anything.", the section's why line and the templates' layouts (new compositions of the site's sections).
- Safe zones for LinkedIn and the other platforms: not measured yet.
- Templates still to build: the Private post, the stat post and the models post (1080 × 1350), the provider post after the archetype pick, the avatar (400 × 400) and the LinkedIn personal banner (1584 × 396). The NFT-launch post waits for its content.
- The Desktop post's composition: the window runs off the panel by the app's whole sidebar (21 % of the capture), not the site's sixth, so no piece of the sidebar is sliced. To approve.
- Antseed Desktop's launch lines (a one-liner, the platforms to name, the call to action): none yet; Pranit owns them.
- The print poster's size: the lab exports A3 at 2480 × 3508, about 212 dpi on the sheet. A print-ready A3 at 300 dpi needs 3508 × 4961; until the lab offers it, check with the printer.
- The templates' paths assume the kit served at `/brand/` beside the site's `/assets/`; in the zip they are references only.

## For your agents

The kit was made so Antseed's own agents can make anything on-brand (DECISIONS.md, D79). One file routes them: AGENTS.md names the file to open for each task, gives the hard rules and ends with the checklist to run before showing anything.

### Starter prompt

Paste it to an agent, with the slot filled:

```text
You are making something for Antseed. First read https://antseed-home.vercel.app/brand/AGENTS.md and follow it exactly; open the other files it names only when the task needs them. Use tokens.css and components.css for anything coded. For any image, follow PROMPTS.md and attach the reference images it names. Make: [what, format, size, day or night]. Before you show me, run the checklist at the end of AGENTS.md and say which half (friendly or technical) this serves.
```

### Review prompt

To check something already made, paste this with the asset:

```text
Here is an asset made for Antseed. Read https://antseed-home.vercel.app/brand/AGENTS.md, then check the asset against its checklist, line by line. List each line it fails and the fix. Do not redesign it.
```

### Where to put it

- Claude Code, Codex, Cursor: unzip the kit into the repository and add one line to the repository's own AGENTS.md or CLAUDE.md: `For anything made for Antseed, read antseed-brand-guidelines/AGENTS.md first.`
- Claude skills: the unzipped folder is a skill named antseed-brand-guidelines. In Claude Code, copy it into the project's `.claude/skills/` folder.
- ChatGPT: paste antseed-chatgpt-instructions.txt into a project's instructions, or antseed-chatgpt-instructions-short.txt into the custom instructions.
- Any other agent: give it the address of AGENTS.md, or of llms.txt.

### The files

Every file sits at https://antseed-home.vercel.app/brand/ followed by its name. It is the planned production address and may change. In the zip, tokens.json, tokens.css, components.css and assets.json sit in tokens/.

| File | For |
|---|---|
| AGENTS.md | Read first. The logic, the hard rules, which file to open for each task, the checklist |
| DESIGN.md | The full guide, in the page's order, every value with its source |
| PROMPTS.md | Image and video recipes, the reference images to attach, post-processing |
| DECISIONS.md | Why it looks like this: every decision, the reversals, the changelog |
| tokens.json | The source of every value. Readable names; the site's names kept as aliases |
| tokens.css | The tokens as CSS variables, light and dark |
| components.css | The pieces of the homepage that travel, written on the tokens |
| assets.json | Every painting, pose, logo, font and icon: its status, use, day and night files and recipe |
| llms.txt | For an agent given only the address |
| antseed-chatgpt-instructions.txt | For a ChatGPT project; the short version, antseed-chatgpt-instructions-short.txt, fits the custom instructions |
| templates/ | The sample collaterals at their exact size, filled by URL parameters |
| reference/ | Every component, variant and state, light and dark |
| lab/ | Shader Lab by AstraOS: posters and exploration. When it differs from the kit, the kit is right |
| files/antseed-brand-kit.zip | All of the above with the fonts, logo, icons and reference images. Also a Claude skill (SKILL.md) |

### The checklist

The same seventeen lines as at the end of AGENTS.md. Run them before showing anything.

1. Name the half it serves, friendly or technical, and check that the other half is still there.
2. The words read without the painting. Titles arrive once at most, fading up from .94, then hold still.
3. Titles: Geist Pixel, two tones with the gray second half, sentence case. A section title (`.ak-title`) ends with a full stop, whatever its tag; the H1 (`.ak-h1`) does not.
4. Only Geist, Geist Mono and Geist Pixel; weights 400 and 500.
5. One filled green button per group, then ghost.
6. Green `#4f7a24` for action. `#98c463` for green text at night. Acid `#c8f53c` only as light on dark, never as text on light.
7. Every dot is round and sits on the 8 px grid, measured on the board before the template's scale; dotted, never dashed. Moving dots behave like ants.
8. Dither and LED only as an arrival, a touch or a transition, made in code or the lab, never asked of an image model.
9. Nothing is drawn around a center.
10. Paintings: suggested, sparse, mostly paper, the subject low or at the edges. No outline on scenery. No ants, people or text in a background. No photography or stock imagery.
11. Every ant is the round mascot or a dot: two legs, the lost look unless the moment needs other eyes. Sunglasses only for Private. Never insectoid. (An app capture shows the app's own ant as it is.)
12. A night version exists, made by editing the day image. Cut-out ants take the night filter. An app capture keeps the app's own night.
13. The logo sits on paper or frosted glass, with its clear space. It is never regenerated. (The logo inside an app capture is the app's own.)
14. Real names and real numbers: figures read from AntSeedStats, dated and credited. No invented models, prices or features.
15. Crypto stays in the background. "Network", not "market". Never "AI VPN".
16. No gold. Seeds are caramel by day and amber at night.
17. With reduced motion, the finished still shows.

### Task routing

| Task | Read | Start from | Use |
|---|---|---|---|
| X or LinkedIn post, banner, OG image | DESIGN.md: Type, Voice, Make | templates/, the sample for the format (listed in DESIGN.md, Make) | assets.json, records with status live |
| Slide deck | DESIGN.md: Type (the Slides fallbacks), Make | templates/, the slides sample | Paintings and mascot from assets.json |
| Poster or exploration | DESIGN.md: The dot | lab/ | Built into the lab |
| New background painting | DESIGN.md: Watercolour; PROMPTS.md, A0 to A3 | PROMPTS.md, A4 (day) and A5 (night) | refs/style-vignette-day and -night, refs/style-scene-day and -night |
| New mascot pose or archetype | DESIGN.md: Mascot; PROMPTS.md, A0 to A3 | PROMPTS.md, A7 (pose) and A8 (walk frame) | refs/mascot-you |
| Site page or section | DESIGN.md: Building blocks; tokens.css; components.css | reference/, every component and state | — |
| Words | DESIGN.md: Voice | The site's own lines | — |
| Why a rule exists | DECISIONS.md | — | — |

When two sources disagree: tokens.json, then DESIGN.md, then the live site, then Figma Board 3, then anything older.

## Decisions

The logic is in Idea, and each section carries its own why. This is the record behind it: what was decided, by whom and when, and what it replaced, so an older file is never taken for the current brand. Every decision, with its date and commits, the calls made for the kit, what is still open and the changelog are in DECISIONS.md.

### Reversals

Decided, then undone. Figma Board 2, antseed-concept/ and v3/ still show the left-hand column: follow the middle one.

| Earlier | Now | See |
|---|---|---|
| Watercolor only as a hidden base, never shown raw (2 Nov) | The painting is the hero (Whimsical 2) | D49 |
| The mascot kept out of the hero (2 Nov) | The mascot in the hero, ants across the page | D19, D29 |
| A blue orb for intelligence | The seed; blue only on the User archetype's bandana | D27, D24 |
| Square pixels (Meadow Square) | Round dots everywhere | D11 |
| Acid green as the one action color, cyan as signal (28 Oct system) | Action green `#4f7a24`; acid `#c8f53c` as light | D40 |
| Instrument Sans display, H1 78 px (28 Oct system) | Geist Pixel display | D37 |
| No pinned sections (28 Oct system) | Private by design holds while its four points scroll (from 900 px wide) | D66 |
| Card radius 16, then 14 | 11, after aside.com | D55 |
| Golden seeds | Caramel by day, amber at night | D28 |
| Sunglasses on the hero mascot at night | None at night; the incognito ant wears them | D26 |
| A marquee of investor logos | One Spark Capital line and the live figures | D17 |
| Colony removed (9 Nov) | Providers and Colony in one section (11 Nov) | D67 |
| Cards walking on their own | Ants carrying the cards | D64 |
| A live routing window | A painted network board, on hold | D68 |
| The H1 holding still from the first frame (11 Nov) | The pill, the H1 and the install block fade up once from .94, then hold still | D80 |

### Fifteen that shape the rest

Each: the decision, why, and what it replaced.

- D03. Friendly and technical; the layout stays clean whatever the illustration does. Sober tech sites are clear but cold; mascot-led sites hide the product; the clean layout also keeps the brand away from the meme-coin look. It replaced mascot-led layouts and a bare B2B look.
- D01. Meadow, "ant and seed", is the direction. Sky read as generic and said little about the product; Pranit wanted the brand's earthy green. It replaced the Sky hero and its blue orb.
- D04. A white rail, dot-matrix margins and dotted outlines, after aside.com. Elio chose aside.com's page language and its dotted separator. It replaced the first system's warm paper with hatches.
- D11. Round dots, never square pixels. Square pixels just look pixelated; the round dot fits the friendly round shapes. It replaced the square mosaic of the first Meadow.
- D33. The LED mosaic is for arrivals and touch only. An interesting interaction on the paintings, without overdoing it. It replaced dithered flower symbols over the washes.
- D37. Geist Pixel is the display face. The type itself is made of the dots, like the background texture. It replaced Instrument Sans and rounded sans faces.
- D40. Two greens, one job each: `#4f7a24` for action, acid `#c8f53c` as light; `#98c463` for green text at night. Both are needed, so they are kept from meeting: the dark hero has one green. It replaced acid as the action color.
- D42. Night is a painting, not an overlay. The filtered night read as an overlay; Amos and Pranit asked for something more native. It replaced a blue wash over the day film.
- D50. Soft, suggested, sparse watercolor, with no outline on scenery. Little detail, so it works with the mascot. It replaced detailed or outlined landscapes.
- D23. One ant for everything: the big round one. Every ant that stands for someone is that ant. It replaced the thin running ant and the crossed-arms ant.
- D22. The lost look: wide eyes, pupils off to the sides. A little dazed and silly; the eyes change only when something is happening in them. It replaced neutral or determined faces.
- D25. New poses are re-rendered, never rigged. Building this ant from parts does not work. It replaced rigged walks and grafted arms.
- D26. Sunglasses mean Private, never night. They belong to the anonymous side. It replaced sunglasses on the hero mascot in dark mode.
- D28. No gold: seeds are caramel by day and amber at night, and the coin is green. Gold turns flat ochre in watercolor and adds a color. It replaced golden seeds and a gold coin.
- D59. The Gateway is a terminal, never a drawn interface. It is a command-line tool. It replaced an app-like Gateway illustration.

### Every decision

DECISIONS.md holds all 80 decisions in eleven groups (direction, the hero, the mascot, motifs, type, color and night, paintings, layout, page structure, motion, process) and the 24 calls made for the kit (K01 to K22 on 12 Nov, K23 and K24 on 13 Nov), each with why, who and when, its commits and what it replaced; then what is still open and the changelog.

## Status and files

Agents copy whatever they find. Every piece of the kit carries a status, so nothing that is still moving or standing in is taken for final. In assets.json the status words are live (on the site, use it), spare (finished, not placed), in-progress (do not extrapolate) and retired (never use).

### Final

- Type: Geist Pixel, Geist and Geist Mono.
- Color and its tokens.
- Logo use: black and near-white.
- You, the mascot.
- The paintings on the site, day and night.
- The voice patterns.
- The 8-frame walk.

### In progress

- The Provider and User picks (provider-4 and user-a-1 are live), and their other poses.
- The network board: on hold, left out of the kit's page.
- The model tabs pattern.
- The footer film; the footer is a still.
- The bandana: lime for You, blue for User, to confirm with Antseed.
- The kit page's section titles: kit copy, to approve.

### Placeholder

- The Colony copy on the site's Providers section (hero/sections.html:236-242, :290).
- The Blog, Media kit and Terms pages, linked from the site's footer (hero/sections.html:404-405).
- The card name "Maya Lin 09/29" in the No crypto needed scene (hero/sections.html:221).

### Retired

- antseed.com's green `#10B981` and clay `#D79627` logo variants.
- Gold, on coins and seeds.
- Instrument Sans and Figtree, folded into Geist.
- The orb, the castes, the slim ant and square pixels.

### Downloads

- files/antseed-brand-kit.zip: the Markdown, tokens, components, fonts, logo, icons, reference images and tools. Also a Claude skill. Its folder is antseed-brand-guidelines/.
- files/antseed-paintings-and-mascot.zip: every painting and mascot pose, day and night, with assets.json and the off-brand examples. The 2K PNG masters on request.
- Single files: AGENTS.md, DESIGN.md, PROMPTS.md, DECISIONS.md, tokens.json, tokens.css, components.css, assets.json, llms.txt.

### Licenses

| Part | License or owner | What it means |
|---|---|---|
| Geist Pixel, Geist, Geist Mono | SIL Open Font License 1.1 | Free to use, embed and share; keep the license with the files |
| Pixel icons (pixelarticons) | MIT, © 2019 Gerrit Halfmann | Keep the LICENSE file with the icons |
| Model makers' marks | SVG files MIT (LobeHub icons); the marks are their makers' trademarks | Only to name the models on offer, unaltered, never to suggest an endorsement |
| Spark Capital and other third-party marks | Their owners' trademarks | Factual use only |
| AntSeedStats data | CC BY 4.0 | Credit AntSeedStats, with the date the figures were read |
| Paintings, mascot, films | Made for Antseed by AstraOS with image and video models | Pending: the transfer to Antseed is to be confirmed by AstraOS |
| Satoshi | Indian Type Foundry, all rights reserved | Not shipped; never use it |

The full list is [LICENSES.md](LICENSES.md), served with the kit and in both zips.

### Colophon

Kit v1, 12 Nov 2026, built from the site at commit ce969b4. Brand, site and kit by AstraOS. Owner at Antseed: Pranit, who owns the copy; changes are requested through AstraOS.

### Tokens

Every token, by tier, generated from tokens.json.

<!-- tokens:start -->

**core** — Use freely. The few colours that carry the brand, the same in both themes.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| green | `#4f7a24` | `--color-green` | The action colour: the fill of every primary button, in both themes; green text, links and icons by day. One filled green button per group. | --fill (and --o by day) | hero/sections.css:15, :12 |
| green-hover-light | `#436a1e` | `--color-green-hover-light` | Primary button hover, light theme. | --fill-hi | hero/sections.css:15 |
| green-hover-dark | `#5b8a2b` | `--color-green-hover-dark` | Primary button hover, dark theme. | --fill-hi (dark) | hero/sections.css:26 |
| green-lip | `#3b5e17` | `--color-green-lip` | The darker lip at the foot of every green button (an inset shadow). At night the button keeps only this lip. | #3b5e17 in .s-btn's box-shadow | hero/sections.css:93, :32 |
| acid | `#c8f53c` | `--color-acid` | Light on dark: LEDs, cursors, the coin's glow at night, the dot-ants. Called lime in conversation. Never text on white (1.27:1). | --acid | hero/sections.css:35 |
| ink | `#0a1a12` | `--color-ink` | The one ink: command lines, text inside product scenes, the darkest text. Kit merge (DECISIONS.md K09): the site also uses #090b0c (hero --ink, index.html:53), #001E12 (favicon mark), #000 (--title) and #1c1c1c (H1); the kit keeps #0a1a12 only. | --ink (sections), --cmd (hero) | hero/sections.css:35; hero/index.html:54 |
| night | `#0f1312` | `--color-night` | The dark page. Night paintings fade their top to exactly this colour. | --page (dark) | hero/sections.css:26; hero/index.html:16 |
| night-surface | `#181d1b` | `--color-night-surface` | The dark rail and dark surfaces; the Private by design section in both themes. | --rail-bg (dark), --priv | hero/sections.css:26, :17 |
| paper | `#ffffff` | `--color-paper` | The light rail, the white of paper, button text. | --rail-bg | hero/sections.css:15 |
| page | `#fcfcfc` | `--color-page` | The light margins around the rail, under the dot matrix: a shade darker than the white inside. | --page | hero/sections.css:15 |

**theme** — Use for UI. The same names in both themes; tokens.css swaps them under [data-theme="dark"] and prefers-color-scheme.

| Token | Light | Dark | CSS | Use | Site name | Source |
|---|---|---|---|---|---|---|
| page | `#fcfcfc` | `#0f1312` | `--color-page-bg` | Margins around the rail, under the dot matrix. | --page | hero/sections.css:15; hero/sections.css:26 |
| rail | `#ffffff` | `#181d1b` | `--color-rail` | The content column (the rail) and every surface on it. | --rail-bg | hero/sections.css:15; hero/sections.css:26 |
| text | `#30382c` | `#eceee9` | `--color-text` | Text and the first half of every title (12.15:1 on white). Kit merge: titles are #30382c; the site's #000 product titles are folded in. | --t (and --title) | hero/sections.css:12; hero/sections.css:25, :26 |
| text-grey | `#929292` | `#9ba49e` | `--color-text-grey` | The grey second half of every two-tone title; feature icons. 3.11:1 on white, so large text only. | --g | hero/sections.css:12; hero/sections.css:25 |
| h1-second | `#595959` | `#9ba49e` | `--color-h1-second` | The H1's second line, as on the site: 4.48:1 on white at the H1's opacity .82, where the title grey would give 2.43:1. Section titles keep the title grey. | --title-2 (hero) | hero/index.html:53, :99; hero/index.html:309 |
| text-body | `#56656f` | `#9ba49e` | `--color-text-body` | Body copy under titles, captions' second line (6.02:1 on white). | --b | hero/sections.css:12; hero/sections.css:25 |
| text-small | `#66746b` | `#9ba49e` | `--color-text-small` | Small print, units, provider counts (4.91:1 on white). | --m | hero/sections.css:12; hero/sections.css:25 |
| green-text | `#4f7a24` | `#98c463` | `--color-green-text` | Green text, links and eyebrows (5.07:1 on white). | --o | hero/sections.css:12; hero/sections.css:25 |
| dot | `#e2e2e2` | `#3d4340` | `--color-dot` | The margin dot matrix and every dotted outline. | --dot | hero/sections.css:12; hero/sections.css:25 |
| dot-off | `#e6eadc` | `#29302c` | `--color-dot-off` | A dot bar's unlit dots. | --empty | hero/sections.css:12; hero/sections.css:25 |
| tile | `rgba(214, 219, 211, .2)` | `rgba(255, 255, 255, .06)` | `--color-tile` | The ghost button's fill and the model card's tile. | --tile | hero/sections.css:16; hero/sections.css:27 |
| tile-hover | `rgba(214, 219, 211, .4)` | `rgba(255, 255, 255, .1)` | `--color-tile-hover` | Ghost button hover. | --tile-hi | hero/sections.css:16; hero/sections.css:27 |
| tile-line | `rgba(64, 76, 66, .1)` | `rgba(255, 255, 255, .1)` | `--color-tile-line` | The ghost button's hairline. | --tile-line | hero/sections.css:16; hero/sections.css:27 |
| control-ring | `#e4dfd2` | `rgba(236, 238, 233, .14)` | `--color-control-ring` | The warm hairline under tabs and round controls. | --seg-ring | hero/sections.css:141; hero/sections.css:144 |
| focus | `#4f7a24` | `#98c463` | `--color-focus` | Focus ring, 2px solid. Kit merge (DECISIONS.md K09): the focus ring is the green; the hero's #789f00 is folded in. | --o in :focus-visible (hero: #789f00) | hero/sections.css:152, :668; hero/index.html:121; hero/sections.css:152; hero/index.html:310, :327 |
| button-fill | `#4f7a24` | `#4f7a24` | `--color-button-fill` | Primary button fill: the same green in both themes. | --fill | hero/sections.css:15; hero/sections.css:23 |
| button-fill-hover | `#436a1e` | `#5b8a2b` | `--color-button-fill-hover` | Primary button hover. | --fill-hi | hero/sections.css:15; hero/sections.css:26 |
| button-text | `#ffffff` | `#ffffff` | `--color-button-text` | Primary button text. Kit merge: the nav's #fafafa is folded into #fff. | #fff in .s-btn | hero/sections.css:91 |
| button-shadow | `0 3.5px .5px 0 rgba(46, 74, 14, .1), inset 0 -.5px 0 0 rgba(200, 230, 170, .63), inset 0 -2px 1px 0 #3b5e17` | `inset 0 -2px 1px 0 #3b5e17` | `--button-shadow` | Primary button depth: a soft drop, a pale lip and the green lip. | .s-btn box-shadow | hero/sections.css:93; hero/sections.css:32 |
| button-ghost-shadow | `0 1.5px 0 0 rgba(255, 255, 255, .6), inset 0 -1px 2px 0 rgba(48, 56, 44, .2)` | `inset 0 -1px 1px 0 rgba(0, 0, 0, .2)` | `--button-ghost-shadow` | Ghost button depth. | .s-btn.ghost box-shadow | hero/sections.css:96; hero/sections.css:33 |
| wash | `#f6f3ea` | `#39403d` | `--color-wash` | A landscape panel's own colour while its painting has not arrived yet. | .wash background-color | hero/sections.css:107; hero/sections.css:110 |
| logo-filter | `none` | `invert(.93)` | `--filter-logo` | The black logo as it is. | --logo | hero/sections.css:18; hero/sections.css:29; hero/index.html:313 |
| character-filter | `none` | `brightness(.84) saturate(.83) contrast(1.12)` | `--filter-character` | Cut-out ants as painted. | (none by day) | hero/index.html:198; hero/index.html:198; hero/sections.css:218, :562, :622 |

**type** — Use for UI. Three families, weights 400 and 500 only, sentence case, tabular figures. Negative tracking only on the pixel display sizes and the lede.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| font.sans | `"Geist", system-ui, sans-serif` | `--font-sans` | Geist: body, ledes, buttons, labels. Google Fonts, OFL 1.1. Load: https://fonts.googleapis.com/css2?family=Geist:wght@400;500&display=block, plus the arrows subset family=Geist:wght@400;500&text=%E2%86%92%E2%86%97 (Google's latin subset leaves out the arrows). Kit merge: Instrument Sans and Figtree, site leftovers, are folded into Geist. | Geist | hero/sections.css:40, :6; hero/index.html:47 |
| font.mono | `"Geist Mono", ui-monospace, monospace` | `--font-mono` | Geist Mono: commands, prices, the terminal, technical captions. Google Fonts, OFL 1.1. Load: https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&display=block | Geist Mono | hero/sections.css:4, :87 |
| font.pixel | `"Geist Pixel Var", "Geist", sans-serif` | `--font-pixel` | Geist Pixel, variable on its ELSH axis (element shape, 0 to 100), self-hosted from GeistPixel-VariableFont_ELSH.ttf under the family name "Geist Pixel Var" (tokens.css declares it). Titles, eyebrows, figures. OFL 1.1. Google Fonts' plain family=Geist+Pixel request serves only the solid shape. | "Geist Pixel Var" | hero/index.html:50; hero/sections.css:75 |
| weight.regular | `400` | `--weight-regular` | Text, titles, figures. | 400 | hero/sections.css:79 |
| weight.medium | `500` | `--weight-medium` | Buttons, names, links. The only other weight: nothing is loaded at 600 or 700, so a <b> would be a synthetic bold. | 500 | hero/sections.css:91, :611 |
| elsh.square | `1` | `--elsh-square` | Geist Pixel's Square instance: solid pixels. Not used on the page; the smaller a figure, the nearer this end it sits. | Square | GeistPixel-VariableFont_ELSH.ttf fvar; hero/sections.css:402-404 |
| elsh.h1 | `11` | `--elsh-h1` | The H1's shape: square pixels with softened corners. | "ELSH" 11 | hero/index.html:97 |
| elsh.circle | `20` | `--elsh-circle` | Round dots: eyebrows and key figures. | --eb-elsh, --fig-elsh | hero/sections.css:82; hero/index.html:205 |
| elsh.grid | `40` | `--elsh-grid` | Small separated dots: section titles. | "ELSH" 40 | hero/sections.css:75 |
| h1 | `400 90px/93px "Geist Pixel Var", "Geist", sans-serif, tracking -0.08em, ELSH 11, opacity 0.82; (max-width: 1023px) and (min-width: 761px): 8.4vw/1.04; (max-width: 760px): 46px/50px` | `--type-h1` | The display title: Geist Pixel ELSH 11, two tones (the text color, then the H1 grey #595959, #9ba49e at night), centered, opacity .82, no full stop. Tablet 8.4vw/1.04, phone 46/50. | h1 | hero/index.html:97-99, :100, :211 |
| section-title | `400 48px/46px "Geist Pixel Var", "Geist", sans-serif, tracking -2px, ELSH 40; (max-width: 760px): 34px/36px, tracking -1.4px` | `--type-section-title` | Section title: Geist Pixel ELSH 40, two halves, the second in text-grey, ending with a full stop. Phones 34/36, -1.4px. | .s-h2, .s-h3 | hero/sections.css:75, :78, :758 |
| eyebrow | `400 18px/27px "Geist Pixel Var", "Geist", sans-serif, ELSH 20` | `--type-eyebrow` | Eyebrow over a title: Geist Pixel ELSH 20 (16px × 1.125, line 1.5), green text, then a non-breaking space and ›. A link, usually to the docs. | .s-eyebrow | hero/sections.css:80-83 |
| figure | `400 30px/30px "Geist Pixel Var", "Geist", sans-serif, ELSH 20, tabular-nums; (max-width: 760px): 26px/26px` | `--type-figure` | A key figure under its label: Geist Pixel ELSH 20, tabular. Phones 26/26. Read live before use. | .backers b | hero/index.html:205, :213 |
| figure-large | `400 40px/44px "Geist Pixel Var", "Geist", sans-serif, ELSH 20, tabular-nums; (max-width: 899px): 32px/36px` | `--type-figure-large` | A large figure ($ANTS): Geist Pixel ELSH 20, tabular. 32/36 at 899px and below. | .s-ants.figs b | hero/sections.css:571-572, :724, :787 |
| figure-name | `400 24px/28px "Geist Pixel Var", "Geist", sans-serif, ELSH 20` | `--type-figure-name` | A point's name in pixel type ($ANTS points): ELSH 20. | .s-ants b | hero/sections.css:571 |
| lede | `400 26px/36px "Geist", system-ui, sans-serif, tracking -0.01em; (max-width: 760px): 20px/28px` | `--type-lede` | The lede: Geist 400, the only text size with negative tracking. Phones 20/28. | .s-lede | hero/sections.css:128, :763 |
| sub | `400 18px/27px "Geist", system-ui, sans-serif; (max-width: 760px): 16px/24px` | `--type-sub` | The line under a title, in text-body. Phones 16/24. | .s-sub | hero/sections.css:79, :760 |
| body | `400 16px/24px "Geist", system-ui, sans-serif` | `--type-body` | Body, feature lines, captions. | .s-feats li, .s-cap | hero/sections.css:237, :416 |
| body-strong | `500 16px/24px "Geist", system-ui, sans-serif` | `--type-body-strong` | A name at the start of a caption, in the text colour. | .s-cap b | hero/sections.css:417 |
| link | `500 16px/24px "Geist", system-ui, sans-serif` | `--type-link` | A standalone link in green text: → to the docs and the page, ↗ to other sites. | .s-link | hero/sections.css:80 |
| button | `500 15px/20px "Geist", system-ui, sans-serif` | `--type-button` | Button label, sentence case. | .s-btn | hero/sections.css:91-92 |
| card-name | `500 15px/20px "Geist", system-ui, sans-serif; (max-width: 760px): 14px/18px` | `--type-card-name` | A model's name on its price card, two lines at most. Phones 14/18. | .s-mcard b | hero/sections.css:176, :767 |
| footer | `400 14px/20px "Geist", system-ui, sans-serif` | `--type-footer` | Footer links and legal line. | .s-foot .col | hero/sections.css:657 |
| label | `400 13px/16px "Geist", system-ui, sans-serif` | `--type-label` | A figure's label, over its value. | .backers p | hero/index.html:204 |
| small | `400 12px/16px "Geist", system-ui, sans-serif, tabular-nums` | `--type-small` | Small print and counts, tabular. | .s-mcard .prov | hero/sections.css:180 |
| pill | `400 12px/16px "Geist", system-ui, sans-serif` | `--type-pill` | The announcement pill. The site sets it in Figtree 12/16; kit merge: Geist. | .pill (Figtree) | hero/index.html:91 |
| mono-price | `400 12.5px/16px "Geist Mono", ui-monospace, monospace` | `--type-mono-price` | A price; its unit in text-small. | .s-mcard code | hero/sections.css:178-179 |
| mono-saving | `500 14px/20px "Geist Mono", ui-monospace, monospace` | `--type-mono-saving` | A saving on a price card, in green text. | .s-mcard em | hero/sections.css:175 |
| mono-caption | `400 12.5px/18px "Geist Mono", ui-monospace, monospace` | `--type-mono-caption` | A technical caption, lowercase, in green text. | .s-ants .cap | hero/sections.css:573 |
| terminal | `400 11.475px/20.06px "Geist Mono", ui-monospace, monospace` | `--type-terminal` | Terminal text. | .term | hero/sections.css:250 |
| terminal-title | `400 10.2px/17.85px "Geist Mono", ui-monospace, monospace, tracking .2px` | `--type-terminal-title` | The terminal's window title. | .t-title | hero/sections.css:256 |
| terminal-tag | `400 9.35px/16.4px "Geist Mono", ui-monospace, monospace, tracking .56px` | `--type-terminal-tag` | A pane's tag, top right. | .t-tag | hero/sections.css:259 |

**space** — Use for UI. One 8px rhythm; the rail and its margins are clamps measured on Figma's 1504-wide frame.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| grid | `8px` | `--space-grid` | The grid: the dot pitch, and every section's height snaps to a multiple of it so section tops land on the dots. | 8px | hero/sections.css:41-43; hero/sections.js:61-64 |
| body-gutter | `16px` | `--space-body-gutter` | The hero card floats 16px from the screen's edges. | body padding | hero/index.html:58 |
| gutter | `clamp(16px, 6.4vw, 96px)` | `--space-gutter` | The dotted margin on each side of the rail (96 at 1504). | --gut | hero/sections.css:36 |
| rail-max | `1312px` | `--space-rail-max` | The rail's widest. | 1312px in --rail | hero/sections.css:37 |
| rail | `min(1312px, 100% - 2 * clamp(16px, 6.4vw, 96px))` | `--space-rail` | The rail's width; rounded down to a multiple of 16 where round() is supported (components.css .ak-rail), so its edges land on the dots. | --rail | hero/sections.css:37, :45 |
| pad | `clamp(20px, 9.64vw, 145px)` | `--space-pad` | The rail's inner margin (145 at 1504). | --pad | hero/sections.css:38 |
| section | `120px; (max-width: 760px): 72px` | `--space-section` | A section's top and bottom padding; 72px at 760px and below. | .s-pad | hero/sections.css:69, :745 |
| head-gap | `20px` | `--space-head-gap` | Between eyebrow, title and sub in a section head. | .s-head gap | hero/sections.css:84 |
| head-gap-tight | `16px` | `--space-head-gap-tight` | The same in a product half or the prices head. | .s-duo-head gap | hero/sections.css:133, :231 |
| head-to-content | `64px; (max-width: 760px): 40px` | `--space-head-to-content` | From a section head to its panel or cards; 40px at 760px and below. | margin-top 64px | hero/sections.css:412, :446, :782 |
| actions-row | `12px` | `--space-actions-row` | Row gap in a row of buttons. | .s-actions gap | hero/sections.css:90 |
| actions-column | `20px` | `--space-actions-column` | Column gap in a row of buttons (12 in a product half). | .s-actions gap | hero/sections.css:90, :233 |
| duo-pad | `64px` | `--space-duo-pad` | Padding of a product half's text. | .s-duo-text padding | hero/sections.css:230 |
| duo-gap | `36px` | `--space-duo-gap` | Between head, list and buttons in a product half. | .s-duo-text gap | hero/sections.css:230 |
| card-gap | `24px` | `--space-card-gap` | Between cards. | .s-cards gap | hero/sections.css:410 |
| feature-row | `8px` | `--space-feature-row` | A feature line's top and bottom padding. | .s-feats li padding | hero/sections.css:237 |
| icon-gap | `12px` | `--space-icon-gap` | From a feature icon to its text. | .s-feats li gap | hero/sections.css:237 |
| icon | `24px` | `--space-icon` | A pixel icon: 24px, so each of its pixels is a whole 2px. | .f-ic | hero/sections.css:244 |
| phone | `760px` | `--space-bp-phone` | Breakpoint: phones at this width and below (one column, 72px sections, smaller titles). Media queries cannot read variables: write the number. | @media (max-width: 760px) | hero/sections.css:744 |
| stack | `899px` | `--space-bp-stack` | Breakpoint: product halves and points stack at this width and below. | @media (max-width: 899px) | hero/sections.css:697 |
| tight | `1199px` | `--space-bp-tight` | Breakpoint: section grids tighten at this width and below. | @media (max-width: 1199px) | hero/sections.css:688 |

**radius** — Use for UI. Nested from the card (aside.com's scale, Elio's reference): what sits inside takes the next one down; where a box shares a corner with its parent, the outer radius less the inset, 2 at least. Buttons 10. Kit merge: the site's 12 and 14 leftovers are folded into this scale.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| card | `11px` | `--radius-card` | Cards, card panels, model cards, the $ANTS and Private panels, the tooltip. | --r-card | hero/sections.css:21 |
| window | `8px` | `--radius-window` | A window in a card; the Gateway terminal; the Desktop window. | --r-win | hero/v6.css:23; hero/sections.css:248 |
| popover | `6px` | `--radius-popover` | Popovers and menus. | --r-pop | hero/v6.css:23 |
| control | `5px` | `--radius-control` | Fields, buttons and rows inside a window. | --r-ctl | hero/v6.css:23 |
| tile | `3px` | `--radius-tile` | Small tiles, checkboxes. | --r-sm | hero/v6.css:23 |
| min | `2px` | `--radius-min` | The floor where a box shares a corner with the one holding it. | --r-min | hero/v6.css:23 |
| button | `10px` | `--radius-button` | Every page button, primary and ghost. | border-radius: 10px on .s-btn, .cta | hero/sections.css:91; hero/index.html:74 |
| pill | `999px` | `--radius-pill` | The announcement pill. | .pill | hero/index.html:89 |

**dots** — Use for UI and effects. The dot is the ant: round, never square; dotted, never dashed; on the 8px grid. Effects made of dots (LED reveal, hover mosaic, dither) are drawn in code or the lab, never asked of an image model.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| pitch | `8px` | `--dots-pitch` | One dot every 8px, everywhere. | 8px | hero/sections.css:43; hero/unveil.js:10 |
| matrix | `radial-gradient(circle at 4px 4px, #e2e2e2 .85px, #0000 1.25px) 50% -4px / 8px 8px` | `--dots-matrix` | The margin matrix (Figma's "Trame"): a 2px round dot every 8px, one on the page's centre line and one on its top edge. Set it as a background over the page colour. | .s-page background | hero/sections.css:41-43 |
| outline | `radial-gradient(circle at 1px 1px, #e2e2e2 .85px, #0000 1.25px)` | `--dots-outline` | One dot of a dotted outline: laid in strips 8px apart on each side that is switched on (components.css .ak-outline). | --d | hero/sections.css:56-66 |
| led-dot | `0.42` | `--dots-led-dot` | LED matrix (the painting's arrival and the hover mosaic): a dot's radius, times the 8px pitch. | DOT | hero/unveil.js:11; hero/card-unveil.js:16 |
| hover-reach | `88px` | `--dots-hover-reach` | The hover mosaic's reach around the pointer. Mouse only, never on touch. | RADIUS | hero/wash-led.js:19 |
| hover-half-life | `300ms` | `--dots-hover-half-life` | How fast the hover mosaic's trail fades. | HALF_LIFE | hero/wash-led.js:20 |
| sky-cell | `2px` | `--dots-sky-cell` | The hero sky's dither: 2px cells, ordered by an R2 sequence, not a Bayer matrix (which draws little crosses). | HERO_CELL | hero/dither.js:9-11 |
| ant-radius | `1.9px` | `--dots-ant-radius` | A dot-ant: a round acid dot that walks the grid a cell at a time. | ANT_R | hero/dither.js:156 |
| ant-ink | `#c8f53c` | `--dots-ant-ink` | The dot-ants' colour, with a glow rgba(200, 245, 60, .55) blurred 6px. | ANT_INK | hero/dither.js:157, :255 |
| mosaic-pitch | `15.45px` | `--dots-mosaic-pitch` | The Private by design mosaic's step; its dots 2.4px in radius. | PRIV_STEP | hero/dither.js:156 |

**motion** — Use for UI. Three curves do most of the work; four duration bands. Words first and still; arrive once; with reduced motion the finished still shows.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| ease-arrive | `cubic-bezier(0.2, 0.7, 0.2, 1)` | `--ease-arrive` | Arrivals: blocks rising into view, menus and rows coming in. | --rv-ease | hero/sections.css:680 |
| ease-slide | `cubic-bezier(0.65, 0, 0.35, 1)` | `--ease-slide` | State changes: tab lines and thumbs sliding, panels swapping. | cubic-bezier(.65, 0, .35, 1) | hero/sections.css:147 |
| ease-pop | `cubic-bezier(0.3, 1.6, 0.5, 1)` | `--ease-pop` | Small confirmations only: a check, a badge (strong overshoot). | cubic-bezier(.3, 1.6, .5, 1) | hero/micro.css:95 |
| ease-window | `cubic-bezier(0.2, 0.9, 0.25, 1.12)` | `--ease-window` | A window popping in on its landscape (scale .9 to 1, slight overshoot). | cubic-bezier(.2, .9, .25, 1.12) | hero/sections.css:117 |
| dur-feedback | `150ms` | `--dur-feedback` | Feedback band, 150 to 250ms: hovers, taps. | .15s | hero/sections.css:92 |
| dur-control | `350ms` | `--dur-control` | Controls band, 350 to 450ms: tabs, toggles, menus. | .35s | hero/sections.css:147 |
| dur-block | `600ms` | `--dur-block` | Blocks band, 500 to 900ms: sections rising, the page's theme crossfade. | .6s | hero/sections.css:681; hero/index.html:349 |
| dur-painting | `1500ms` | `--dur-painting` | Paintings band, 1.2 to 2.2s: the LED arrival of a painting, the night coming down. | DURATION | hero/unveil.js:14; hero/card-unveil.js:19 |
| dur-count | `2200ms` | `--dur-count` | A figure counting up to its live value once, exponential ease-out (1 - 2^-10k). | MS | hero/count.js:7-8 |
| stagger | `50ms` | `--motion-stagger` | Between blocks arriving together. | calc(var(--i) * 50ms) | hero/sections.css:681 |
| rise | `20px` | `--motion-rise` | How far a block rises as it comes into view (panels 24px from scale .98). | translateY(20px) | hero/sections.css:682, :684 |

**glass** — Use for UI over paintings. By day the light window glass; at night every screen over a landscape is the smoked green glass. The Gateway terminal is smoked green in both themes.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| day | `background: rgba(255, 255, 255, .62); border: .5px solid #fff; shadow: 0 14px 40px 0 rgba(20, 51, 89, .14); backdrop: blur(10px)` | `--glass-day` | Day window glass over a landscape. | .v6c-win | hero/v6.css:45-46 |
| smoked | `background: rgba(14, 33, 23, .64); border: .5px solid rgba(150, 200, 145, .42); shadow: 0 12px 32px 0 rgba(8, 26, 14, .26), inset 0 .5px 0 0 rgba(190, 228, 170, .16); backdrop: blur(10px) saturate(1.3)` | `--glass-smoked` | Smoked green glass: the Gateway terminal in both themes, and every window over a landscape at night. | .term; night .v6c-win | hero/sections.css:248-250; hero/v6.css:388-391 |
| smoked-text | `text: #cbd8d0; strong: #ecf3ee; chrome: #d5ddd9; prompt: #ddf988; url: #d3f5e3; json: #e6f0ea; cursor: #c8f53c; dot: rgba(150, 196, 150, .22); bar: rgba(150, 200, 145, .06)` | `--glass-smoked` | Colours on smoked glass (the terminal): body text, commands, window chrome, the prompt, URLs, JSON, the caret, its dotted lines and its title bar. Tuned for 4.5:1 over a bright sky. | .term, .t-bar, .term .c/.u/.j/.cur | hero/sections.css:248-265 |
| smoked-thin | `background: rgba(14, 33, 23, .3); border: .5px solid rgba(150, 200, 145, .42); shadow: 0 12px 32px 0 rgba(8, 26, 14, .22), inset 0 .5px 0 0 rgba(190, 228, 170, .16); backdrop: blur(10px) saturate(1.6) brightness(.72); backdrop-night: blur(10px) saturate(1.5) brightness(.95)` | `--glass-smoked-thin` | Thinner smoked glass (Private by design's windows, both themes): more painting shows; the frost dims what is under it so light text still reads. | --pv-glass, --pv-frost | hero/v6.css:268-275 |
| popover | `background: rgba(255, 255, 255, .96); border: .5px solid rgba(10, 26, 18, .08); shadow: 0 10px 28px 0 rgba(20, 51, 89, .2); backdrop: blur(6px)` | `--glass-popover` | A menu or popover by day. | .v6c-menu | hero/v6.css:52-53 |
| popover-night | `background: rgba(16, 38, 26, .94); border: .5px solid rgba(150, 200, 145, .34); shadow: 0 10px 28px 0 rgba(0, 0, 0, .34)` | `--glass-popover-night` | A menu or popover at night: the same green, denser. | night .v6c-menu | hero/v6.css:392-393 |
| pill | `background: #fff; ring: inset 0 0 0 1px #fff; backdrop: blur(2px)` | `--glass-pill` | The announcement pill by day, as on the live hero (Whimsical 2). | .whimsical .pill | hero/index.html:273 |
| pill-acid | `background: #c8f53c; ring: inset 0 0 0 1px rgba(9, 11, 12, .06), inset 0 0 0 1px rgba(255, 255, 255, .75); backdrop: blur(7px)` | `--glass-pill-acid` | The acid pill of the hero's other versions, ink text. By day only. | .pill | hero/index.html:89-91 |
| pill-night | `background: rgba(24, 29, 27, .78); ring: inset 0 0 0 .5px rgba(236, 238, 233, .16); backdrop: blur(6px)` | `--glass-pill-night` | At night the pill is neutral glass, so the hero's only green is its button. | dark .pill | hero/index.html:315 |

**button** — Use for UI. One filled green button per group, then ghosts. Same radius for both.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| height | `44px` | `--button-height` | Every page button. | .s-btn height | hero/sections.css:91 |
| padding-x | `20px` | `--button-padding-x` | Side padding. | .s-btn padding | hero/sections.css:91 |
| shadow-light | `0 3.5px .5px 0 rgba(46, 74, 14, .1), inset 0 -.5px 0 0 rgba(200, 230, 170, .63), inset 0 -2px 1px 0 #3b5e17` | `--button-shadow-light` | Primary by day: a soft drop, a pale lip, the green lip. | .s-btn box-shadow | hero/sections.css:93 |
| shadow-dark | `inset 0 -2px 1px 0 #3b5e17` | `--button-shadow-dark` | Primary at night: only the green lip. | dark .s-btn box-shadow | hero/sections.css:32 |
| ghost-shadow-light | `0 1.5px 0 0 rgba(255, 255, 255, .6), inset 0 -1px 2px 0 rgba(48, 56, 44, .2)` | `--button-ghost-shadow-light` | Ghost by day. | .s-btn.ghost box-shadow | hero/sections.css:96 |
| ghost-shadow-dark | `inset 0 -1px 1px 0 rgba(0, 0, 0, .2)` | `--button-ghost-shadow-dark` | Ghost at night. | dark .s-btn.ghost box-shadow | hero/sections.css:33 |

**illustration** — Drawings and code effects only, never UI.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| night-character | `brightness(.84) saturate(.83) contrast(1.12)` | `--illustration-night-character` | Every cut-out ant at night: a little darker, cooler, less saturated, as the painting behind it. Also the night reference for assets made off the site (DECISIONS.md K20). | filter on the mascot at night | hero/index.html:198; hero/sections.css:218, :562, :622 |
| seed-night-glow | `drop-shadow(0 0 6px rgba(255, 200, 100, .85)) drop-shadow(0 0 22px rgba(255, 150, 50, .62)) drop-shadow(0 0 56px rgba(255, 128, 32, .4))` | `--illustration-seed-night-glow` | A seed glowing amber at night. | dark .cursor img filter | hero/index.html:187 |
| coin-shadow | `drop-shadow(0 12px 14px rgba(40, 60, 20, .18))` | `--illustration-coin-shadow` | The $ANTS coin floating, by day. | .s-tk-coin filter | hero/sections.css:559 |
| coin-night-glow | `drop-shadow(0 0 18px rgba(200, 245, 60, .3))` | `--illustration-coin-night-glow` | The $ANTS coin at night: an acid glow. | dark .s-tk-coin filter | hero/sections.css:563 |
| fireflies | `#d8f070, #a6e05a, #ffb347` | `--illustration-fireflies` | The hero's night fireflies, drawn in code (never painted). | INKS | hero/index.html:393 |

**local** — Never outside their scene. Kept so nobody mistakes them for brand colours.

| Token | Value | CSS | Use | Site name | Source |
|---|---|---|---|---|---|
| network | `link: #1f6bff; link-night: #4d94ff; other: rgba(10, 26, 18, .28); other-night: rgba(255, 255, 255, .3); base: #f4efdc; base-night: #24332f; base-edge: #b9b08c; base-edge-night: #121b19; provider-base: #bedc62; provider-base-night: #5d8a26; provider-edge: #6f8f2a; provider-edge-night: #2a4010` | `--local-network` | The network board only (in progress, left out of the kit's page): your links in electric blue, others' links faint, cream bases for people, green for providers. | --nd-* | hero/sections.css:462-465 |
| window-lights | `#ff5f57, #febc2e, #28c840` | `--local-window-lights` | macOS traffic lights on the terminal and app windows. | .t-lights i | hero/sections.css:253-255 |
| desktop-app | `ink: #16181d; muted: #6b6f7a; ink-night: #eef0f7; muted-night: #9aa1ba; check-night: #c6f06a; reply-night: rgba(14, 20, 44, .62)` | `--local-desktop-app` | Antseed Desktop's own app colours, drawn over its captures. The app's navy night differs from the site's green-black on purpose (DECISIONS.md K19). | .app .typed, .me, .ai, .sig | hero/sections.css:290-304 |

<!-- tokens:end -->

### Assets

Every asset with its status, generated from assets.json.

<!-- assets:start -->

| ID | Kind | Subject | Size | Status | Day / file | Night | Used on | Recipe |
|---|---|---|---|---|---|---|---|---|
| hero | painting | Whimsical 2: the village meadow under a wide sky, the hero's scene | 1376 × 768 | live: The hero scene. The page plays its film (hero-film) over a 1280 × 714 poster; this still is the source of the night edits | ../assets/hero/whimsical-2.webp | ../assets/hero/night/whimsical-2-night-b.webp | ../hero/ |  |
| hero-film | film | Whimsical 2's film: the clouds drifting over the meadow, drawn at 12 a second, a muted loop | 1280 × 714 | live: Plays over its poster by day; paused at night; the poster alone with reduced motion | ../assets/hero/video/whimsical-2.mp4 |  | ../hero/ |  |
| hero-night-a | painting | The hero at night, a full moon top left | 1376 × 768 | spare: A night variant (?night=a); the crescent moon (night b) was picked | archive only | ../assets/hero/night/whimsical-2-night-a.webp | ../hero/?night=a | PROMPTS.md#hero-night-a |
| hero-night-c | painting | The hero at night, no moon | 1376 × 768 | spare: A night variant (?night=c); night b was picked | archive only | ../assets/hero/night/whimsical-2-night-c.webp | ../hero/?night=c | PROMPTS.md#hero-night-c |
| hero-night-loop | film | A seamless loop over the night still: the moon's glow, the grass moving | 1920 × 1072 | live: Only at night, only on screen, never with reduced motion | ../assets/hero/night/whimsical-2-night-b-loop.mp4 |  | ../hero/ | PROMPTS.md#hero-night-loop |
| footer | painting | The wide meadow down to a river, three mascots resting on caramel seeds; the footer | 2752 × 1276 | live: The footer, full bleed, its sky fading into the page. Documented as a still: its film is off | ../assets/home/footer/meadow-wide.webp | ../assets/home/footer/meadow-wide-night.webp | ../hero/ | PROMPTS.md#footer |
| footer-1k | painting | The footer meadow before its middle hill was cut out, 1K | 1376 × 768 | spare: Replaced on the site by the wide footer; still one of the lab's paintings | ../assets/home/footer/meadow.webp | ../assets/home/footer/meadow-night.webp |  | PROMPTS.md#footer |
| footer-hd | painting | The same footer meadow at twice the size | 2752 × 1536 | spare: Not loaded since the wide footer came in | ../assets/home/footer/meadow-2x.webp | ../assets/home/footer/meadow-night-2x.webp |  | PROMPTS.md#footer |
| v01 | painting | Golden wheat, close up: the approved style reference | 2400 × 1792 | live: The Gateway panel, behind the terminal. Elio's reference: suggested, sparse, lots of white paper, a close crop | ../assets/home/vignettes/v01-day.webp | ../assets/home/vignettes/v01-night.webp | ../hero/#gateway | PROMPTS.md#v01 |
| v02 | painting | Tall grass and two clover heads, low | 1200 × 896 | live: The Antseed Desktop panel, behind the app window. Still at 1K | ../assets/home/vignettes/v02-day.webp | ../assets/home/vignettes/v02-night.webp | ../hero/#desktop | PROMPTS.md#v02 |
| v03 | painting | A forest edge, birch trunks on both sides | 2400 × 1792 | live: Providers, first card (models to serve) | ../assets/home/vignettes/v03-day.webp | ../assets/home/vignettes/v03-night.webp | ../hero/#providers | PROMPTS.md#v03 |
| v04 | painting | A sea shore: dunes and beach grass | 2400 × 1792 | live: Providers, second card (incoming request), and Private by design, fourth point (no crypto needed) | ../assets/home/vignettes/v04-day.webp | ../assets/home/vignettes/v04-night.webp | ../hero/#providers | PROMPTS.md#v04 |
| v05 | painting | Ferns and broad leaves in the lower corners | 2400 × 1792 | live: Providers, third card (Antseed Colony) | ../assets/home/vignettes/v05-day.webp | ../assets/home/vignettes/v05-night.webp | ../hero/#providers | PROMPTS.md#v05 |
| v06 | painting | A river bend seen from above | 2400 × 1792 | spare: Finished pair, not placed: it was the network panel's before the board | ../assets/home/vignettes/v06-day.webp | ../assets/home/vignettes/v06-night.webp |  | PROMPTS.md#v06 |
| v07 | painting | Hills, hedgerows and patchwork fields | 2400 × 1792 | live: Private by design, first point (no account) | ../assets/home/vignettes/v07-day.webp | ../assets/home/vignettes/v07-night.webp | ../hero/#privacy | PROMPTS.md#v07 |
| v08 | painting | Poppies and daisies before soft hills | 2400 × 1792 | live: Private by design, second point (signed responses) | ../assets/home/vignettes/v08-day.webp | ../assets/home/vignettes/v08-night.webp | ../hero/#privacy | PROMPTS.md#v08 |
| v09 | painting | A pond, reeds and lily pads | 2400 × 1792 | live: Private by design, third point (TEE providers) | ../assets/home/vignettes/v09-day.webp | ../assets/home/vignettes/v09-night.webp | ../hero/#privacy | PROMPTS.md#v09 |
| v10 | painting | A warm field at golden hour, haystacks far off | 2400 × 1792 | live: The $ANTS panel, behind the coin and the amazed ant | ../assets/home/vignettes/v10-day.webp | ../assets/home/vignettes/v10-night.webp | ../hero/#token | PROMPTS.md#v10 |
| v11 | painting | A calm horizon band | 1584 × 672 | spare: Made for an earlier version of the network panel; unused since the board | ../assets/home/vignettes/v11-day.webp | ../assets/home/vignettes/v11-night.webp |  | PROMPTS.md#v11 |
| map-2 | painting | Isometric fields seen from above: 15 clearings, a river and a bridge; the network board | 2112 × 896 | in-progress: The network board is on hold and left out of the kit's page; do not extrapolate from it | ../assets/home/net/map-2-day.webp | ../assets/home/net/map-2-night.webp | ../hero/#network | PROMPTS.md#map-2 |
| map-3 | painting | An alternative board: 17 clearings | 2112 × 896 | spare: Ready but not placed; its night is provisional | ../assets/home/net/map-3-day.webp | ../assets/home/net/map-3-night.webp |  | PROMPTS.md#map-3 |
| seed | object | The seed: almond-shaped, caramel by day, glowing amber at night. The request, the thing the network passes along | 470 × 651 | live: The hero's cursor and the seed on its ground | ../assets/hero/seed-day.webp | ../assets/hero/seed-night.webp | ../hero/ | PROMPTS.md#seed |
| seed-small | object | The seed small, day and glowing | 92 × 128 | in-progress: Drawn on the network board, which is on hold | ../assets/home/net/seed-day.webp | ../assets/home/net/seed-glow.webp | ../hero/#network | PROMPTS.md#seed |
| coin | object | The $ANTS coin: green watercolor coin, tilted, the Antseed mark raised in white. The token's image; gold is retired | 557 × 603 | live: Floats over the amazed ant in $ANTS; at night it takes an acid glow in CSS | ../assets/home/ants-coin-cut.webp |  | ../hero/#token | PROMPTS.md#coin |
| coin-plate | object | The same green coin on its own pale wash, square | 1024 × 1024 | spare: Replaced by the cut-out, which can move on its own | ../assets/home/ants-coin.webp |  |  | PROMPTS.md#coin |
| you | pose | You: the mascot standing, warm brown, lime bandana, the lost look | 207 × 320 | live: Final. The board's piece for you | ../assets/home/net/ant-you-idle-day.webp | ../assets/home/net/ant-you-idle-night.webp | ../hero/#network | PROMPTS.md#you |
| you-render | pose | You at full size, cut from the render the board's You comes from: standing in three-quarter view, two legs, the lost look. The kit's model sheet is drawn on it | 641 × 992 | live: Final. The reference to attach to every prompt for a new pose or archetype. Cut out of its white by the site's own cut (make-sprites.py); the white stays under the transparent pixels, so a tool that drops transparency still sees it on white | files/mascot/you-1.webp |  |  | PROMPTS.md#you |
| provider | pose | Provider: the same ant as a geek, big round black-rimmed glasses, a charcoal hoodie instead of the bandana | 217 × 320 | in-progress: provider-4 is live on the board; the final pick is pending | ../assets/home/net/ant-prov-idle-day.webp | ../assets/home/net/ant-prov-idle-night.webp | ../hero/#network | PROMPTS.md#provider |
| user | pose | User: a golden-amber ant with a sky-blue bandana | 207 × 320 | in-progress: user-a-1 is live on the board; the final pick is pending; the blue bandana is to confirm with Antseed | ../assets/home/net/ant-user-idle-day.webp | ../assets/home/net/ant-user-idle-night.webp | ../hero/#network | PROMPTS.md#user |
| pose-idle | pose | The mascot standing, the board's resting pose | 207 × 320 | in-progress: A network board reaction (the board is on hold). Three or four feet: a documented exception to the two-leg rule | ../assets/home/net/ant-idle-day.webp | ../assets/home/net/ant-idle-night.webp | ../hero/#network | PROMPTS.md#pose-idle |
| pose-receive | pose | Receive: hugging a seed, eyes closed in two happy arcs | 194 × 320 | in-progress: A network board reaction (the board is on hold). Three or four feet: a documented exception to the two-leg rule | ../assets/home/net/ant-receive-day.webp | ../assets/home/net/ant-receive-night.webp | ../hero/#network | PROMPTS.md#pose-receive |
| pose-cheer | pose | Cheer: arms up, mouth open | 206 × 320 | in-progress: A network board reaction (the board is on hold). Three or four feet: a documented exception to the two-leg rule | ../assets/home/net/ant-cheer-day.webp | ../assets/home/net/ant-cheer-night.webp | ../hero/#network | PROMPTS.md#pose-cheer |
| pose-send | pose | Send: a toss, one arm out | 224 × 320 | in-progress: A network board reaction (the board is on hold). Three or four feet: a documented exception to the two-leg rule | ../assets/home/net/ant-send-day.webp | ../assets/home/net/ant-send-night.webp | ../hero/#network | PROMPTS.md#pose-send |
| pose-look | pose | Look: eyes up at something flying over | 206 × 320 | in-progress: A network board reaction (the board is on hold). Three or four feet: a documented exception to the two-leg rule | ../assets/home/net/ant-look-day.webp | ../assets/home/net/ant-look-night.webp | ../hero/#network | PROMPTS.md#pose-look |
| incognito | pose | The incognito ant: small black round sunglasses, a faint knowing smile, sitting with its legs over an edge | 360 × 557 | live: Private by design, sitting on the panel's top edge. Sunglasses mean Private, never night | ../assets/home/ant-incognito.webp |  | ../hero/#privacy | PROMPTS.md#incognito |
| token-ant | pose | The amazed ant: arms up, looking up, mouth open; its pupils are separate layers that tremble in awe | 544 × 769 | live: $ANTS, under the floating coin | ../assets/home/ants-token-ant.webp |  | ../hero/#token | PROMPTS.md#token-ant |
| carry | sprite | The carrying ant: an 8-frame walk, a run, stand, look and hop, in two layers (the ant behind the card, its near hand over it) | 984 × 260 | live: Hauls each model card in the models' lanes. The 8-frame walk is final | ../assets/home/carry/ant.webp |  | ../hero/#prices | PROMPTS.md#carry |
| hero-rig | pose | The hero's mascot in parts: the body with its arms painted out, the back arm, the front arm, and a neutral fallback | 1024 × 1024 | live: The hero only: a rig whose eyes follow the pointer and arms reach for the seed. The one approved exception to never puppet the ant; never build a new pose this way. Three or four feet: a documented exception | ../assets/hero/ant-rig/ant-body.png |  | ../hero/ | PROMPTS.md#hero-rig |
| footer-ants | pose | Three mascots painted into the footer: one leaning on a seed, one asleep on one, one sitting with its chin on its hand |  | live: Part of the footer painting, not cut-outs | archive only |  | ../hero/ | PROMPTS.md#footer |
| logo-lockup | logo | The lockup: the ant mark made of nodes, then ANTSEED. Black on paper, near-white #eceee9 at night | 91 × 27 | live: Nav and footer. Clean files cut from the site's ../assets/hero/logo.svg (a Figma export with preserveAspectRatio="none"): the same 26 shapes, centered in a 91 × 27 box; PNG at 1×, 2× and 4×. On a coded page the black file takes --filter-logo at night (class ak-logo); everywhere else use the near-white file | files/logo/antseed-lockup-black.svg | files/logo/antseed-lockup-near-white.svg | ../hero/ |  |
| logo-mark | logo | The mark alone: the ant made of nodes. Black on paper, near-white #eceee9 at night | 27 × 27 | live: Cut from the lockup, so mark and lockup always match, centered in a 27 × 27 square; PNG at 1×, 2× and 4×. The site's favicon, ../assets/home/icons/ant-mark.svg, is the same drawing at 92 % in antseed.com's ink #001E12: favicon.svg replaces it | files/logo/antseed-mark-black.svg | files/logo/antseed-mark-near-white.svg | ../hero/ |  |
| logo-green | logo | antseed.com's green mark, #10B981 |  | retired: The logo is black and near-white only (decided 12 Nov); pending Antseed's agreement | archive only |  |  |  |
| logo-clay | logo | antseed.com's clay mark, #D79627, once kept for $ANTS and fees |  | retired: The logo is black and near-white only (decided 12 Nov); pending Antseed's agreement | archive only |  |  |  |
| logo-favicon | logo | Favicons: the mark as SVG (black, near-white when the system is dark), a 32 px PNG on transparent, the 180 px Apple touch icon and a 512 px icon, both on paper |  | spare: Made for the kit, not on the site yet: the site's favicon is still ../assets/home/icons/ant-mark.svg (index.html:32). In the icons on paper the mark is 60 % of the square's height | files/logo/favicon.svg |  |  |  |
| logo-avatar | logo | Profile picture: the white mark on the action green #4f7a24 | 400 × 400 | in-progress: Proposal, to approve. For social profiles; the mark is 60 % of the square's height, so a round crop keeps every node | files/logo/antseed-avatar-400.png |  |  |  |
| font-geist-pixel | font | Geist Pixel, variable on its ELSH axis (element shape, 0 to 100): titles, eyebrows, figures |  | live: Self-hosted: Google Fonts' plain request serves only the solid shape | ../assets/fonts/GeistPixel-VariableFont_ELSH.ttf |  | ../hero/ |  |
| font-geist-pixel-ofl | licence | The SIL Open Font License 1.1 for Geist Pixel, with its copyright line: ship it with the font |  | live: The license text Google Fonts ships with Geist Pixel; the font's own name table carries the same license (name IDs 0, 13, 14) | files/fonts/OFL.txt |  |  |  |
| font-geist | font | Geist, weights 400 and 500: everything that is not a title, a figure or code |  | live: From Google Fonts | https://fonts.google.com/specimen/Geist |  |  |  |
| font-geist-mono | font | Geist Mono, weights 400 and 500: commands, prices, the terminal |  | live: From Google Fonts | https://fonts.google.com/specimen/Geist+Mono |  |  |  |
| font-instrument-sans | font | Instrument Sans: still on the site's hero buttons, install block and media tabs |  | retired: A site leftover from an earlier direction, being folded into Geist (DECISIONS.md K09) | archive only |  |  |  |
| font-figtree | font | Figtree: still on the site's announcement pill |  | retired: A site leftover, being folded into Geist (DECISIONS.md K09) | archive only |  |  |  |
| font-satoshi | font | Satoshi, the old H1 face |  | retired: Replaced by Geist Pixel; "All rights reserved": never shipped | archive only |  |  |  |
| icon-blocks | icon | pixelarticons blocks: a feature line's icon |  | live: Gateway and Antseed Desktop feature lists | ../assets/home/icons/pixel/blocks.svg |  | ../hero/#gateway |  |
| icon-sliders-horizontal | icon | pixelarticons sliders-horizontal |  | live: Gateway feature list | ../assets/home/icons/pixel/sliders-horizontal.svg |  | ../hero/#gateway |  |
| icon-analytics | icon | pixelarticons analytics |  | live: Gateway feature list | ../assets/home/icons/pixel/analytics.svg |  | ../hero/#gateway |  |
| icon-plug | icon | pixelarticons plug |  | live: Antseed Desktop feature list | ../assets/home/icons/pixel/plug.svg |  | ../hero/#desktop |  |
| icon-lock | icon | pixelarticons lock |  | live: Antseed Desktop feature list | ../assets/home/icons/pixel/lock.svg |  | ../hero/#desktop |  |
| icons-pixel-spare | icon | pixelarticons code, earth and directions |  | spare: In the folder, unused on the page | archive only |  |  |  |
| pixelarticons-licence | licence | The pixelarticons MIT licence: ship it with the icons |  | live: Required by the licence | ../assets/home/icons/pixel/LICENSE |  |  |  |
| icon-nodes | icon | The network's nodes: a model card's provider count |  | live: Model price cards, 12px in the text color | ../assets/home/v6/net-bt-nodes.svg |  | ../hero/#prices |  |
| maker-marks | icon | Model makers' marks: monochrome (drawn in the text color) and, where one exists, the maker's color mark |  | live: Model price cards. Factual use only, unaltered, never to suggest endorsement | archive only |  | ../hero/#prices |  |
| tool-derp-eyes | tool | derp-eyes.py: gives a painted ant the lost look by moving its pupils, without a new render |  | live: Post-processing for every new pose | ../assets/home/derp-eyes.py |  |  |  |
| tool-make-sprites | tool | make-sprites.py: cuts a render out of its white, crops it and grades its night |  | live: Post-processing for poses on white. The kit ships a copy of the site's assets/home/net/make-sprites.py whose comments were cleaned (local paths, a tool name); the code is the same | pack/tools/make-sprites.py |  |  |  |
| not-v02-first | not-this | The first v02: a zoomed-out crop with fine detail everywhere | 1200 × 896 | retired: Too busy: 61 % near-white where the approved ones are 49 to 85 %; detail distracts from the content | files/not-this/v02-first-day.webp |  |  |  |
| not-v05-day-alt | not-this | v05's day alternative: the frame full of leaves |  | retired: Too full: 41 % near-white. Mostly paper, few elements | archive only |  |  |  |
| not-v07-night-alt | not-this | v07's night alternative: a pale night |  | retired: Not night enough: mean luminance 188. Nights are deep blue-green | archive only |  |  |  |
| not-soil-strata | not-this | A 2 Nov wash: soil strata and roots under a meadow | 800 × 600 | retired: The superseded 2 Nov style: a cross-section, heavier, more saturated, outlined | ../assets/home/washes/prov-strata.webp |  |  |  |
| not-lavis | not-this | A plain abstract wash used as a section ground | 796 × 736 | retired: Replaced on 12 Nov by landscape vignettes: a wash says nothing of the ant's world | ../assets/home/lavis/gateway.webp |  |  |  |
| not-dither-overlay | not-this | Dithered daisy, sprig and leaf symbols laid over the paintings |  | retired: They don't work (Elio, 12 Nov). Effects on paintings are the LED arrival and the hover mosaic only. Drawn in code, removed; no file | archive only |  |  |  |
| not-gold-coin | not-this | The first $ANTS coins: gold, with a drawn ant | 1024 × 1024 | retired: No gold anywhere: the coin is green with the Antseed mark | files/not-this/gold-coin.webp |  |  |  |
| not-slim-ant | not-this | The earlier slim ant: long thin limbs, crossed arms, a smirk | 1448 × 2158 | retired: One ant only, the big round one. Never determined, cool or heroic by default | ../assets/hero/ant-standing/ant-standing.webp |  |  |  |
| not-orb-ant | not-this | The orb era: the round ant on four legs with a blue orb on its head | 467 × 800 | retired: Two legs, two arms; the seed replaced the orb | ../assets/hero/ant-walk.png |  |  |  |
| not-specimen | not-this | A realistic field-guide ant |  | retired: Never insectoid: no mandibles, no segmented legs, no six legs | archive only |  |  |  |
| not-castes | not-this | The four castes of 2 Nov: forager, leafcutter, scout, honeypot |  | retired: One body; a role is told by props (the archetypes), never by castes or color codes | archive only |  |  |  |
| not-sunglasses-night | not-this | The mascot in sunglasses as a night costume |  | retired: Sunglasses mean Private, never night. At night the ant takes the night's light, it does not change costume | archive only |  |  |  |
| not-jointed-legs | not-this | An ant with jointed insect legs |  | retired: Stubby, boneless limbs only; two legs | archive only |  |  |  |
| desktop-anon | capture | Antseed Desktop, captured from the app: the chat screen, Anonymous or Private to pick, the app's own ant in the corner | 1400 × 1095 | live: The one capture for a Desktop asset: in a glass window (ak-window) over a landscape. Its UI, logo, mascot and navy night are the app's own and exempt (DECISIONS.md K19). frost-mask.webp frosts its sidebar and top bar as on the site | ../assets/home/desktop/day-1-anon.webp | ../assets/home/desktop/night-1-anon.webp | ../hero/#desktop |  |
| desktop-states | capture | Antseed Desktop's other states: the model menu open, a model picked, Private on, a reply | 1400 × 1095 | spare: States of the site's Desktop animation; on the site the typing, the messages and the cursor are drawn over them in code, so alone they look unfinished. Use desktop-anon | archive only |  | ../hero/#desktop |  |
| tpl-x-post-gateway | template | X post, Gateway: the eyebrow, the two-tone title and the smoked terminal over v01; the homepage's Gateway section on a 1024 × 576 board at 1.5625× | 1600 × 900 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/x-post-gateway-day.png | templates/png/x-post-gateway-night.png |  |  |
| tpl-x-post-desktop | template | X post, Antseed Desktop: the eyebrow, the two-tone title and the sub beside the app's capture in a glass window over v02; the homepage's Desktop section on a 1024 × 576 board at 1.5625× | 1600 × 900 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/x-post-desktop-day.png | templates/png/x-post-desktop-night.png |  |  |
| tpl-x-post-ants | template | X post, $ANTS, day and night: the two-tone title, the hard cap 1.04B, the amazed ant and the green coin over v10; the homepage's $ANTS section on a 1024 × 576 board at 1.5625× | 1600 × 900 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/x-post-ants-day.png | templates/png/x-post-ants-night.png |  |  |
| tpl-og | template | Link preview (Open Graph): the H1 in the sky of Whimsical 2, the logo on paper; the hero on a 960 × 504 board at 1.25× | 1200 × 630 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/og-day.png | templates/png/og-night.png |  |  |
| tpl-x-header | template | X header: the wide meadow cropped to 3:1, the logo on a paper plate at the right, clear of the profile picture; a 750 × 250 board at 2× | 1500 × 500 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/x-header-day.png | templates/png/x-header-night.png |  |  |
| tpl-linkedin-company | template | LinkedIn company cover: the wide meadow cropped to 5.9:1, the logo on a paper plate at the right; at 1× | 1128 × 191 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/linkedin-company-day.png | templates/png/linkedin-company-night.png |  |  |
| tpl-slides-1 | template | Slide 1, title: the H1 in the sky of Whimsical 2, the logo on paper; the hero on a 1280 × 720 board at 1.5× | 1920 × 1080 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/slides-1-day.png | templates/png/slides-1-night.png |  |  |
| tpl-slides-2 | template | Slide 2, duo: Antseed Desktop, the app's capture in a glass window over v02, then the eyebrow, title, sub and three features | 1920 × 1080 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/slides-2-day.png | templates/png/slides-2-night.png |  |  |
| tpl-slides-3 | template | Slide 3, stat: one figure, read live from AntSeedStats when the slide opens and printed with the day of the read (or the $ANTS hard cap), beside v04 | 1920 × 1080 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/slides-3-day.png | templates/png/slides-3-night.png |  |  |
| tpl-slides-4 | template | Slide 4, closing: the footer; the logo on paper, the wide meadow under it, its sky fading into the paper | 1920 × 1080 | live: v1 template of the kit, built only from the system: use it. Its layout is new kit work, to approve | templates/png/slides-4-day.png | templates/png/slides-4-night.png |  |  |

<!-- assets:end -->

## Superseded, do not copy

Old files still show earlier states of the brand. Never learn from them:
- antseed-concept/ (28 Oct: acid as the action color, Instrument Sans, hatches), v3/, homepage-ant-farm/ and Figma Board 2.
- antseed.com's green `#10B981`, its clay `#D79627` and General Sans.
- The orb, the castes, the slim ant, square pixels, the gold coin, the soil and lavis washes.
- Instrument Sans and Figtree: site leftovers, folded into Geist.
- When the Shader Lab and the kit differ, the kit is right: the lab is for exploring.

The reversals, with what each one replaced, are in Decisions above (### Reversals) and in DECISIONS.md. The site's dead code is listed on the reference page, /brand/reference/#dead ("Dead code, do not copy").

## Open items: not decided, do not invent

- Kit copy to approve: every new line of copy on the kit's page and in this guide (section titles, boilerplate) is listed here until it is approved.
- Spelling: the section names Colour and Watercolour (and their anchors) are British, while the copy rule is American spelling, as the site's. To settle before the kit ships.
- Kit copy to approve, the cover: the title "Antseed / brand kit", the buttons "Download the kit", "Agent guide" and "Shader Lab", and the line "Using an agent? Point it at /brand/AGENTS.md."
- Kit copy to approve, Idea: the title "Friendly / and technical.", the lead under it and the proof captions.
- Kit copy to approve, Logo: the title "An ant / made of nodes."; the clear space, the minimum sizes and the avatar are proposals.
- Kit copy to approve, The dot: the title "The dot / is the ant."
- Kit copy to approve, Type: the title "Set in Geist. / Made of dots."
- A merge to approve, Type: the kit's H1 keeps the site's own gray for its second line, `#595959` (`#9ba49e` at night), while the section titles take `#929292`. The title gray at the H1's opacity .82 would read 2.43:1 on white, under the 3:1 floor for large text.
- Kit copy to approve, Colour: the title "Two greens, / one job each."
- Kit copy to approve, Watercolour: the title "Soft, sparse, / mostly paper." and the section's copy.
- Kit copy to approve, Mascot: the title "One ant. / A bit lost." and its sub-heads.
- Kit copy to approve, Building blocks: the title "Built from / the homepage."; on the reference page, the titles "Every component, every state.", "The 22 components, top to bottom.", "Shared parts, used everywhere.", "Breakpoints, by width.", "Motion, effect by effect.", "At night, part by part.", "Site only, not for reuse." and "Dead code, do not copy."
- Kit copy to approve, Voice: the title "Plain words. / The ant does the jokes.", the wording of the rules, the boilerplate (Pranit to approve) and the credit format "Data: AntSeedStats, 12 Nov 2026".
- Kit copy to approve, Make: the title "Make / anything.", the section's why line and the templates' layouts (new compositions of the site's sections).
- Kit copy to approve, For your agents: the title "Point your agent here first."; the starter and review prompts.
- Kit copy to approve, Decisions: the title "Why it looks like this."; the neutral wording of DECISIONS.md (Elio reviews it before it ships).
- Kit copy to approve, Status and files: the title "Check the status before you copy."

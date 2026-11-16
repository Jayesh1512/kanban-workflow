Made by AstraOS for Antseed — v1, 12 Nov 2026

# Antseed: read this first

You are making something for Antseed: a post, a banner, a slide, a page, an image or words. This file routes you. It gives the logic, the hard rules, which file to open for your task and the checklist to run before you show anything. Open the other files only when the task needs them.

- Version 1, 12 Nov 2026, built from the live site at commit ce969b4. Owner at Antseed: Pranit, who owns the copy. Changes are requested through AstraOS.
- Every file sits at https://antseed-home.vercel.app/brand/ (the planned production address, which may change). File names below are relative to it. In the zip, tokens.json, tokens.css, components.css and assets.json sit in tokens/.
- The black AstraOS bar and colophon are the maker's frame, not the Antseed brand. Copy nothing from them.
- Never read or copy the site's source CSS; use tokens.css and components.css.

## What Antseed is

In the site's own words. Quote them; never add claims of your own.

- "The open intelligence network" (the H1, no full stop).
- "Give your agents, apps, and team access to 700+ AI models at lower prices, with built-in privacy and full control."
- "Your device finds providers over Mainline DHT, the same network BitTorrent uses, talks to them directly, and pays per request. Nobody sits in the middle."

## The logic

The first test, always: name the half your work serves, friendly or technical, and check that the other half is still there.

1. Friendly and technical, for prosumers. Do: a clean layout that says what Antseed sells, with the paintings, round shapes and the ant around it. Never: let the painting or the mascot bury the product; never a cold, bare B2B look.
2. The dot is the ant. Do: round dots on the 8 px grid; when dots move, they walk, queue, gather and carry like ants. Never: square pixels, dashes, blinking clusters.
3. Dither and the LED mosaic make it modern and technical. Do: use them as an arrival, a touch response or a transition, made in code or the lab. Never: as wallpaper; never ask an image model for them.
4. Soft watercolor is the naive side, and it suits the mascot. Do: suggested, sparse, mostly paper. Never: dense detail; an ink outline on scenery.
5. The mascot has Rabbids energy. Do: one round ant, deadpan, a bit lost; it carries things and gets amazed. Never: scary, insectoid, determined or cool by default; never write "Rabbids" in a prompt: describe the energy in words.
6. Nothing has a center. Do: spread things out; say what is absent ("Nobody sits in the middle"). Never: a hub in a diagram, layout or composition.
7. The seed is what gets passed along. Do: the seed is the request, the cursor, what the ants carry. Never: the blue orb.
8. Day and night are two paintings. Do: give every image a night, made by editing the day image. Never: a dark filter or overlay on the day image as its night.

## Hard rules

Layout and dots
- Margins carry the dot matrix (a 2 px dot every 8 px) around a white rail; dotted outlines run on the rail only.
- Every dot is round and sits on the 8 px grid, measured on the board before a template's scale (an X post drawn at 1.5625× shows it at 12.5 px). Dotted, never dashed. Sections are a multiple of 8 px high.
- Radii nest: card 11, window 8, popover 6, control 5, tile 3, never under 2; buttons 10.

Paintings
- Watercolor on white paper: suggested, sparse, mostly paper, few elements, cropped close; the subject low or at the side edges, never in the middle.
- No outline on scenery (a subject such as the ant or the coin keeps a thin dark-brown line). No ants, people or text inside a background.
- No photography, no stock imagery, no glossy 3D, no vector flats, no airbrush gradients, no pixel art inside a painting.
- Nights are deep blue-green; warmth comes only from seeds, one window or fireflies, and fireflies are drawn in code, never painted.
- Edit, don't re-describe: a night, a higher resolution or a change is an edit of the approved image. Recipes in PROMPTS.md.

The ant
- One character, the round mascot: a big round head, huge white eyes with tiny pupils, a small straight mouth, ball-tipped antennae, a lime bandana (You), two arms, exactly two legs.
- The lost look by default, pupils off to the sides. Other eyes only when the moment needs them: the hero ant with the seed, the amazed $ANTS ant, the incognito ant.
- Roles are props on the same body, never color codes: Provider wears round glasses and a charcoal hoodie; User is amber with a blue bandana. Both are in progress.
- Sunglasses mean Private, never night. The seed is the request. The green coin with the Antseed mark is $ANTS.
- New poses are re-rendered, never rigged or assembled from parts.
- At night a cut-out ant takes `filter: brightness(.84) saturate(.83) contrast(1.12)` (`--filter-character` in tokens.css).

Logo
- Black on light, near-white on dark (the black file inverted, `invert(.93)`). No other color, no gradient, outline or effect; never stretched, rotated or recolored.
- On paper or frosted glass, never straight on a painting or a dither. Clear space at least the height of the ANTSEED capitals; the lockup never under 66 px wide with the kit's files (the drawing 19 px high; 24 px high in the site's padded 95 × 33 file); the mark alone never under 24 px (all proposed, to confirm with Antseed).
- Never redrawn or regenerated by an image model; never given a face; never at the center of a network. The mark may be a pattern in posters only, never behind the logo.

Type
- Geist Pixel for titles, eyebrows and figures; Geist for text; Geist Mono for code, prices and small UI. Weights 400 and 500 only.
- Titles in two tones, the second half gray. The H1 role (`.ak-h1`, the display title) has no full stop; a section title (`.ak-title`) ends with one, whatever its HTML tag. Sentence case.
- Negative tracking only on the pixel display sizes and the lede. Tabular figures.

Color
- Green `#4f7a24` is action: the button fill in both themes, and green text by day. Green text at night is `#98c463`.
- Acid `#c8f53c` is light on dark (LEDs, cursors, the coin's glow, the dot-ants), never text on a light ground.
- Text `#30382c`; the gray second half of section titles `#929292`, for large text only; the H1's second line `#595959` (`--color-h1-second`); body `#56656f`. At night: page `#0f1312`, rail `#181d1b`, every gray `#9ba49e`.
- No gold anywhere. Seeds are caramel by day and amber at night.

Words
- Plain, concrete, second person. The ant does the jokes, not the words. American spelling; no Oxford comma unless it is needed for clarity.
- "Network", not "market", in the one-liner. Never "AI VPN": the product is Antseed Desktop. No "decentralized", no "web3". Crypto only to say you don't need it.
- Names: Antseed, Antseed Desktop, Antseed Gateway (and "the gateway" in running text), Colony, $ANTS for the token and ANTS for the unit, AntSeedStats.

Facts
- Never invent a model, a price, a figure or a feature. Figures come from AntSeedStats, with the date they were read and a CC BY 4.0 credit.
- The Gateway is a terminal, never a drawn interface.
- Antseed Desktop, as the site states it: on macOS (Apple Silicon and Intel), Windows (x64) and Linux (AppImage, x86_64 and ARM64); "Get Antseed Desktop" links to https://github.com/Antseed/antseed/releases/latest, "Learn more" to https://antseed.com/docs/desktop/. No launch copy exists yet: never write "new", "now available", a version or a price for it; ask Pranit.
- A product capture shows the app as it is: its UI, fonts, logo, mascot and its own navy night are exempt (DECISIONS.md K19). The rules and the checklist apply to everything around it.

Motion
- Words first: they arrive before the painting, never from a blank start, never assembled from dots. The pill, the H1 and the install block may fade up once from .94 (opacity .55s ease-out, scale .9s on `--ease-window`), then they hold still. Effects arrive once, when seen or touched. Hover is for a mouse only.
- With reduced motion, the finished still shows.

## Which file wins

AGENTS.md and DESIGN.md are written to agree; where they do not, tokens.json wins, then DESIGN.md. Then the live site, then Figma Board 3, then anything older. Board 3 lags the site.

## Superseded: never learn from

- antseed-concept/ (28 Oct: acid as the action color, Instrument Sans, hatches), v3/, homepage-ant-farm/ and Figma Board 2.
- antseed.com's green `#10B981`, its clay `#D79627` and General Sans.
- The orb, the castes, the slim ant, square pixels, the gold coin, the soil and lavis washes.
- Instrument Sans and Figtree: site leftovers, folded into Geist.
- When the Shader Lab and the kit differ, the kit is right: the lab is for exploring.

## Task routing

| Task | Read | Start from | Use |
|---|---|---|---|
| X or LinkedIn post, banner, OG image | DESIGN.md: Type, Voice, Make | templates/, the sample for your format and product (listed in DESIGN.md, Make): x-post-desktop, x-post-gateway, x-post-ants | assets.json, records with status live (or spare) |
| Slide deck | DESIGN.md: Type (the Slides fallbacks), Make | templates/, the slides sample | paintings and mascot from assets.json |
| Poster or exploration | DESIGN.md: The dot | lab/ | built into the lab |
| New background painting | DESIGN.md: Watercolour; PROMPTS.md, A0 to A3 | PROMPTS.md, A4 (day) and A5 (night) | refs/style-vignette-day and -night, refs/style-scene-day and -night |
| New mascot pose or archetype | DESIGN.md: Mascot; PROMPTS.md, A0 to A3 | PROMPTS.md, A7 (pose) and A8 (walk frame) | refs/mascot-you |
| Site page or section | DESIGN.md: Building blocks; tokens.css; components.css | reference/, every component and state | — |
| Words | DESIGN.md: Voice | the site's own lines | — |
| Why a rule exists | DECISIONS.md | — | — |

Images: attach files by their address (assets.json gives each one, day and night) or from refs/ in the zip. Use only records with status live (or spare); in-progress means do not extrapolate, retired means never.

Posts: a template is for its own product; never put another product's lines, terminal or capture in it. X posts carry no logo (the account's avatar does) and at most the section's one filled button; the link goes in the post's text. The post's text is one or two of the site's sentences plus the link; the image's alt text is its title plus what it shows.

## Still moving: do not extrapolate

- The Provider and User archetypes (provider-4 and user-a-1 are live; the picks are pending) and their other poses.
- The network board, its map and its colors: on hold, left out of the kit.
- The model tabs pattern.
- The bandana: lime for You and blue for User, to confirm with Antseed.
- Legs on the hero rig and the five network reactions (three or four feet, a documented exception; every new render has two).
- The footer film: the footer is a still.
- The token mark: $ANTS has no official mark; the green coin carries the Antseed mark.
- Placeholders on the site: the Colony copy, the Blog, Media kit and Terms pages, the card name "Maya Lin 09/29".

## Review prompt

To check something already made, paste this to an agent with the asset:

> Here is an asset made for Antseed. Read https://antseed-home.vercel.app/brand/AGENTS.md, then check the asset against its checklist, line by line. List each line it fails and the fix. Do not redesign it.

## Checklist

Run it before you show anything. Say which half, friendly or technical, the work serves.

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

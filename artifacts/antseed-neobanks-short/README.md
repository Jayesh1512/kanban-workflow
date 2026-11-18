# AI agents inside your neobank

An eight-slide HTML version of the supplied 15-page Antseed partner brief and Solid case study. Its styling is measured directly from the supplied PDF: the same type sizes and tracking, page frame, content gutters, artwork placements, pricing cards, smoked terminal and four-card launch layout. The eight-slide storyline is retained.

Open `index.html` with `assets/` and `brand/` alongside it, or use the standalone `Antseed-Neobanks-Short.html` for a fully offline copy. No build step or account is needed.

Controls: left/right arrows or Page Up/Page Down, Home/End, visible slide selector, horizontal swipe, T for theme and F for fullscreen. Mobile layouts reflow for reading. Print styling includes all eight slides. External call, documentation and statistics links require internet access.

## Story coverage

| Slide | Story | PDF pages |
| --- | --- | --- |
| 1 | AI agents, inside your neobank | 1, 15 |
| 2 | Existing AI spend and the bank opportunity | 2, 4 |
| 3 | Model access, network pricing, bank rewards and conditional Antseed Points | 3, 6 |
| 4 | Price examples and 50% cashback economics | 5 |
| 5 | P2P provider network and per-customer Gateway integration | 7, 8 |
| 6 | Network scale and usage snapshot | 9 |
| 7 | Solid’s launch, Rewards placement, tiers and follow-up | 10, 11 |
| 8 | Solid’s playbook and the four-step partner rollout | 13, 14, 15 |

`story-map.json` records full coverage, source SHA-256, pricing arithmetic, qualifications and editorial decisions. `pdf-style-map.json` records the measured type and composition specifications used for visual fidelity. The draft testimonial on PDF page 12 is explicitly pending approval and is not presented as an approved endorsement. Repeated setup and closing copy have been merged. Broader Solid APY/Visa marketing and lowest-listing model cards were omitted as secondary context, not as separate story stages.

## Source framing

Prices and network figures retain the PDF’s **13 November 2026** snapshot. These are historical examples, not today’s readings. Prices are USD per million input tokens, with a 50% partner cashback assumption; network pricing is the median of healthy paid listings. Displayed discounts are calculated from the shown prices. AntSeedStats data is credited under CC BY 4.0.

The Solid launch date, six-model public list, Opus retail price and cashback caps were cross-checked against Solid’s public launch post on 17 November 2026; other offer details are reproduced from the supplied brief. Antseed Points determine a share of weekly ANTS rewards only for eligible usage and under program terms. No fixed token value, investment return, guaranteed retention outcome or blanket verification proof is asserted.

## Files and assets

`brand/tokens.css` and `brand/components.css` carry the shared Antseed system; `brand/core.css` carries presentation controls and `brand/partner.css` lays out this shortened deck. Font licensing is in `assets/fonts/OFL.txt`. Asset origins are in `assets/provenance.json` and per-image sidecars. The artwork is reused, not newly generated. The original PDF is not redistributed.

This is a separate artifact. The existing intro presentation and older neobank deck have not been overwritten.

## PDF styling

The 960 × 540pt source maps to a 1280 × 720 CSS canvas. Cover type is 46/50 with ELSH 11 and −0.08em tracking; section type is 34/36 with ELSH 40 and −0.04em tracking; body copy is 16/24. The paper frame is inset 16px, with an 80px content gutter. Original PDF artwork and extracted icons/model marks replace approximate equivalents. Pricing uses the source’s bars and three compact model cards; rollout uses its four horizontal cards.

The default appearance follows the PDF’s white slides and fixed dark technical chapters. The optional global night theme remains available. Merged content, short-deck page numbers, navigation outside the slide canvas and mobile reflow are adaptations; the eight-slide text is not represented as a pixel-identical copy of all fifteen source pages.

## 17 November factual review

Growing network snapshots carry a trailing +; their original read dates are retained. The neobank decks use 920+/269+/24,610+/825.8B+ (13 November); creators uses 942+/274+/28,254+/905.05B+ (16 November). These are dated snapshots, not new readings.

Solid’s six-model list, cashback caps and data handling were checked against https://solid.xyz/post/ai-agents-antseed. Opus’s $1.68/$0.84 example is explicitly a historical network median, distinct from Solid retail $0.21/$0.105. GPT-6.1 Sol is no longer a renamed old price: its card uses the public Solid table ($2.00 list, $0.089 retail, $0.0445 after cashback per million input tokens; table dated 4 November; rounded saving 98%). Kimi and DeepSeek remain labeled historical network examples. Cashback is capped at $50/$100/$200 monthly for Core/Prime/Ultra.

Rewards use conditional Antseed Points language, with a variable share of weekly ANTS rewards under program terms, not a fixed conversion or guaranteed bank revenue. Public mechanics: https://antseedpoints.com/. Provider processing, billing retention and variation in provider practices are disclosed. Model verification is evidence, not cryptographic proof. No draft CEO testimonial is presented as an endorsement.

## Live stats, 18 November 2026

The stats slide now refreshes from AntSeedStats once per minute while the page is visible.
It combines the public API with the homepage totals omitted from that API.
The slide shows the fetch time and keeps saved figures when a request fails.
PDF exports keep a dated snapshot.
This replaces the historical network snapshot described above.
Pricing and case-study figures keep their original dates.
See [live stats notes](../../scripts/ANTSEED-LIVE-STATS.md) for sources and deployment steps.

Use **Download as PDF** below any slide to download the full deck.
The download includes a dated stats snapshot.

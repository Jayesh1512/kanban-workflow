# Antseed creators pitch: brand and reference audit

Checked 16 November 2026; Value Prop slide added 17 November 2026. Checked against the live [agent guide](https://antseed-home.vercel.app/brand/AGENTS.md), [building blocks](https://antseed-home.vercel.app/brand/#blocks), DESIGN.md, tokens.json, tokens.css, components.css and assets.json. Guide version: v1, 12 November 2026. Reference: the supplied **Antseed - Creators Pitch.pdf**, seven pages, 960 × 540pt, plus its native PPTX and font bundle. Shared layout, eyebrow, card and type patterns were checked against the supplied **Antseed - AI agents for neobanks (Solid case study).pdf**, 15 pages.

The presentation serves the **friendly** half: creator language, watercolor scenes and the supplied round ants. The technical half remains visible through selectable pricing, the single-request failover example, Gateway access and dated network figures.

The visual system is aligned with both references. The compact PDF type scale is retained, while the Solid case study supplies the shared eyebrow, section-title, card and closing patterns. This is an edited eight-slide deck, not a pixel-for-pixel copy of either source. Explicit user choices below remain exceptions to literal guide/template defaults.

## Corrections made

- Replaced inherited green/body/night colors with current kit tokens: action #4f7a24, body #56656f, night gray #9ba49e and night green #98c463.
- Bundled and used the current tokens and components. The only edit to the kit token file is its relative font URL for local use.
- Rebuilt the white/dark rails and margin matrix with round 2px dots at an 8px pitch. Replaced browser-spaced dotted rules with the kit dot pattern.
- Corrected card/window/button radii, primary and ghost button styling, and cover logo clear space.
- Kept the Geist families and measured PDF type scale. Corrected cover punctuation/tracking and line-height; used round Pixel figures, tabular page numbers and Geist 13/18 story labels with the kit's green dot.
- Applied the Solid reference's teaching components: ELSH40 section titles at -.04em, ELSH20 card titles, gray eyebrow labels with the green dot, and the closing three-step card pattern.
- Applied the prescribed night character filter to the two separate ant cutouts. No dark overlay is applied to day paintings.
- Replaced raster feature icons with the kit's 24px pixelarticons masks and included their MIT license.
- Preserved the original watercolor/mascot assets, three model cards, plain dark workflow, 2am deadline, 35+ image models, four price examples, stats snapshot and three closing actions.
- Enlarged navigation dot targets to 24px, fixed Space on focused navigation controls and verified focus restoration. At 320px the optional fullscreen control is hidden to prevent overflow.
- Rebalanced the cover against the Solid reference: 80px copy top, 50px H1 line-height, 123 × 59 logo tile and 20px pill/lede spacing. Mobile uses a 104px copy top and 112 × 56 logo tile.
- Converted the closing plan to three 168px cards, restored the gray second title tone, and changed the label/CTA to sentence-case **Your turn** and **Book a call**.

## Guide checklist

| # | Guide requirement | Finding after corrections |
|---|---|---|
| 1 | Friendly and technical | Both present; friendly leads. |
| 2 | Words read without painting; restrained title arrival | Native text, independent layers. Static titles; no repeated animation. |
| 3 | Pixel titles, two tones, sentence case, punctuation | Passed. Section titles use ELSH40 with -.04em; the closing title has both tones; cover has no periods. Story eyebrows use Geist gray with the kit green dot, matching the Solid reference. |
| 4 | Only Geist families; weights 400/500 | Verified in font files, computed styles and PDF resources. Pixel Grid/Round are static instances from the provided Geist Pixel file. |
| 5 | One filled green button per group, then ghosts | One primary on Gateway and closing slides. Stats uses a ghost action. |
| 6 | Exact action/night colors; acid restrictions | Token colors verified in computed styles. No acid text on light. |
| 7 | Round dots at 8px pitch; dotted, never dashed | Margin/rail/section dot strips use the kit's radial-gradient pattern. The reference's local layout geometry is retained. |
| 8 | Dither/LED effects only as restrained code effects | No dither wallpaper or generated pixel art. No extra effect is needed in this static deck. |
| 9 | No central network hub | No Antseed server or network hub is drawn. The diagram depicts one request failing at Provider A and rerouting to compatible Provider B, not network topology. |
| 10 | Sparse watercolor and clear copy area | Supplied PDF artwork retained; native text stays separate. Original composite source illustrations are reused without generating new scenery/mascots. |
| 11 | Approved round mascot, correct meaning | Source mascots retained; no new pose, caste, sunglasses or token imagery introduced. |
| 12 | Proper night paintings and character lighting | Authored night illustration retained; separate cutouts receive brightness(.84) saturate(.83) contrast(1.12). This deck has authored day/night chapters, not a full alternate-theme version. |
| 13 | Original logo on paper with clear space | Original black SVG, unstretched, on a larger white plate with clear space. |
| 14 | Real dated and credited facts | Approved snapshot and the historical source-price examples preserved. Snapshot date stays visible. The stats slide now shows **Source: AntSeedStats · CC BY 4.0 · 16 November 2026 · 13:30 UTC**; full attribution and definitions remain in HTML/PDF metadata and source records. |
| 15 | Plain product names; crypto in the background | Antseed and Antseed Gateway names retained. No retired AI VPN/web3 copy. Conditional Antseed Points remain a Value Prop cell; the closing reward card is removed. |
| 16 | No gold; caramel/amber seeds | Supplied caramel seeds retained. No gold token or new palette introduced. |
| 17 | Reduced motion shows the finished still | Offline reduced-motion checks passed; no content depends on an animation. |

## Reference correspondence

| Current slide | Reference / approved adaptation |
|---|---|
| Cover | Requested vision-deck meadow cover, current general title and original logo/ants. |
| Problem | Reference page 1 split illustration, measured 34/36px section type and 80px left rail. Four approved bottlenecks and new headline. |
| Model access | Reference page 2's three illustrated Video/Image/Voice cards. Taller cards carry four selected historic rates; 35+ image models retained. Takeaway and visible pricing/availability notes removed at the user’s request; source qualifications retained in the ledger. |
| Provider rerouting | Reference page 4's dark technical treatment, icons and laptop ant. Watercolor removed as requested. The native four-node failover flow describes minutes-to-deliver pressure, replacing the numeric clock. The requested provider-dependency statement replaces the illustrative-flow caption. The visible failover compatibility/capacity footnote is also removed per the user’s request; qualifications remain in the source ledger. |
| One-key access | Reference page 6's three-column / team-strip composition, with requested Gateway copy and button. |
| Value Prop | Solid page-4 benefit hierarchy in a 3x2 grid: green 24px pixel icons, dotted row rules, 18/24px benefit headings, 15/22px body copy and one mascot at the upper right. Privacy and conditional Antseed Points are the final cells. It sits before the stats evidence and uses the Value Prop eyebrow. |
| Network figures | User-supplied stats composition, native figures and approved 16 November snapshot. |
| Your turn | Reference page 14's card layout and page 15's seed-carrying ant crop, adapted to three steps. Single Book a call filled button; closing step 2 now reads Pilot using Antseed. |

## Verification

- Eight widths: 320, 356, 390, 760, 820, 1280, 1366 and 1920px; **64 slide checks**. No horizontal overflow or missing images.
- Offline HTML: zero HTTP requests; no browser console/page errors or failed fonts. Checked with reduced motion and an OS dark preference; authored slide colors stay stable.
- Home/End/arrows, first/last boundaries, focused-button Space behavior, inactive-slide semantics and focus restoration passed.
- On 320px and 390px screens, the Value Prop slide stacks to one column and scrolls through all six benefit cells; the reroute caption and Gateway/stats/booking actions remain accessible above the controls.
- Final HTML/PDF render: all eight pages are 960 × 540pt, selectable text, links and embedded fonts remain intact, and every page was visually inspected after the compliance pass.
- Sixteen automated text-height warnings are the known Pixel-font line-metric findings. Full-size visual review found no clipped title ink; they are recorded rather than hidden.
- Stats credit/definitions retained in the PDF Subject and HTML dc.rights metadata. The stats slide shows one compact visible credit; the three original footer lines remain absent.

The model prices remain historical source-pitch examples, not current quotes. General lower-price wording follows the official homepage. The privacy point is scoped to Antseed prompt storage, following the official privacy policy; it does not claim that independent providers cannot see requests. The stats are the explicitly dated approved snapshot; this styling audit did not claim a new data refresh. Source hashes, font inventory and machine-readable checks are in [audit-evidence/](audit-evidence/).

## 17 November factual review

Growing network snapshots carry a trailing +; their original read dates are retained. The neobank decks use 920+/269+/24,610+/825.8B+ (13 November); creators uses 942+/274+/28,254+/905.05B+ (16 November). These are dated snapshots, not new readings.

Solid’s six-model list, cashback caps and data handling were checked against https://solid.xyz/post/ai-agents-antseed. Opus’s $1.68/$0.84 example is explicitly a historical network median, distinct from Solid retail $0.21/$0.105. GPT-6.1 Sol is no longer a renamed old price: its card uses the public Solid table ($2.00 list, $0.089 retail, $0.0445 after cashback per million input tokens; table dated 4 November; rounded saving 98%). Kimi and DeepSeek remain labeled historical network examples. Cashback is capped at $50/$100/$200 monthly for Core/Prime/Ultra.

Rewards use conditional Antseed Points language, with a variable share of weekly ANTS rewards under program terms, not a fixed conversion or guaranteed bank revenue. Public mechanics: https://antseedpoints.com/. Provider processing, billing retention and variation in provider practices are disclosed. Model verification is evidence, not cryptographic proof. No draft CEO testimonial is presented as an endorsement.


## Studio audience revision — 18 November 2026

The current deck serves the technical half.
The approved watercolor art and mascot keep the friendly half.
The eight masters, source typefaces, colors and artwork remain.
Studio costs and integration replace individual editing deadlines.
Gateway keys, budgets and usage replace editor login examples.
The closing pilot measures output, latency, failures and cost.
No Higgsfield customer or partnership claim appears.
Live stats and the PDF download remain.
Visible stats credits and usage footnotes remain removed.
Source attribution and qualifications remain in metadata and records.
The current QA appears in `studio-review-2026-11-18.json`.
Previous sections record historical reviews.

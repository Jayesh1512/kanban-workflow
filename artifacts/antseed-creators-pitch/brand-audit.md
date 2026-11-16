# Antseed creators pitch: brand and reference audit

Checked 16 November 2026 against the live [agent guide](https://antseed-home.vercel.app/brand/AGENTS.md), [building blocks](https://antseed-home.vercel.app/brand/#blocks), DESIGN.md, tokens.json, tokens.css, components.css and assets.json. Guide version: v1, 12 November 2026. Reference: the supplied **Antseed - Creators Pitch.pdf**, seven pages, 960 × 540pt, plus its native PPTX and font bundle.

The presentation serves the **friendly** half: creator language, watercolor scenes and the supplied round ants. The technical half remains visible through selectable pricing, the single-request failover example, Gateway access and dated network figures.

The visual system is aligned. The PDF's compact type scale and compositions are retained. This is an edited seven-slide deck, not a pixel-for-pixel copy of the old wording. Explicit user choices below remain exceptions to literal guide/template defaults.

## Corrections made

- Replaced inherited green/body/night colors with current kit tokens: action #4f7a24, body #56656f, night gray #9ba49e and night green #98c463.
- Bundled and used the current tokens and components. The only edit to the kit token file is its relative font URL for local use.
- Rebuilt the white/dark rails and margin matrix with round 2px dots at an 8px pitch. Replaced browser-spaced dotted rules with the kit dot pattern.
- Corrected card/window/button radii, primary and ghost button styling, and cover logo clear space.
- Kept the Geist families and measured PDF type scale. Corrected the cover's punctuation and tracking; used round Pixel figures, tabular numbers and Pixel storyline labels.
- Applied the prescribed night character filter to the two separate ant cutouts. No dark overlay is applied to day paintings.
- Replaced raster feature icons with the kit's 24px pixelarticons masks and included their MIT license.
- Preserved the original watercolor/mascot assets, three model cards, plain dark workflow, 2am deadline, 35+ image models, four price examples, stats snapshot and three closing actions.
- Enlarged navigation dot targets to 24px, fixed Space on focused navigation controls and verified focus restoration. At 320px the optional fullscreen control is hidden to prevent overflow.

## Guide checklist

| # | Guide requirement | Finding after corrections |
|---|---|---|
| 1 | Friendly and technical | Both present; friendly leads. |
| 2 | Words read without painting; restrained title arrival | Native text, independent layers. Static titles; no repeated animation. |
| 3 | Pixel titles, two tones, sentence case, punctuation | Passed. Section titles end with periods; cover has no periods. Compact PDF sizes and non-link story labels are deliberate adaptations. |
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
| 14 | Real dated and credited facts | Approved snapshot and historical source-price examples preserved. Snapshot date stays visible. Attribution and definitions are in HTML/PDF metadata and source records; **the visible credit remains removed at the user's explicit request**. |
| 15 | Plain product names; crypto in the background | Antseed and Antseed Gateway names retained. No retired AI VPN/web3 copy. Rewards remain a small supporting card. |
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
| Network figures | User-supplied stats composition, native figures and approved 16 November snapshot. |
| Action | Reference page 7's three actions and seed-carrying ant crop. Requested small rewards card and single Book a Call button. |

## Verification

- Eight widths: 320, 356, 390, 760, 820, 1280, 1366 and 1920px; **56 slide checks**. No horizontal overflow or missing images.
- Offline HTML: zero HTTP requests; no browser console/page errors or failed fonts. Checked with reduced motion and an OS dark preference; authored slide colors stay stable.
- Home/End/arrows, first/last boundaries, focused-button Space behavior, inactive-slide semantics and focus restoration passed.
- On 320px and 390px screens, the reroute caption and Gateway/stats/booking actions remain accessible above the controls.
- Final PDF reopened: all seven pages are 960 × 540pt, contain selectable text, retain links and embedded font resources, and render without blank/duplicate pages. Every page rendered and visually inspected.
- Fourteen automated text-height warnings are the known Pixel-font line-metric findings. Full-size visual review found no clipped title ink; they are recorded rather than hidden.
- Stats credit/definitions retained in the PDF Subject and HTML dc.rights metadata. The three requested visible footer lines remain absent.

The model prices remain historical source-pitch examples, not current quotes. General lower-price wording follows the official homepage. The privacy point is scoped to Antseed prompt storage, following the official privacy policy; it does not claim that independent providers cannot see requests. The stats are the explicitly dated approved snapshot; this styling audit did not claim a new data refresh. Source hashes, font inventory and machine-readable checks are in [audit-evidence/](audit-evidence/).

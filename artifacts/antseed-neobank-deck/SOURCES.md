# Sources — neobank offering deck (HTML)

Working notes for claims made in this deck. Every claim carries a source and a status. Content fixed/verified 16 Nov 2026; revised 17 Nov 2026.

| Claim in deck | Source | Date | Status |
|---|---|---|---|
| 920+ models through one API | AntSeedStats (https://antseedstats.com), read 13 Nov 2026, CC BY 4.0; also Amos's brief | 13 Nov 2026 | verified as of read date (growing snapshot; `+` marks growth) |
| 269+ providers (all time) | AntSeedStats, read 13 Nov 2026 | 13 Nov 2026 | verified as of read date |
| 24,610+ total active users | AntSeedStats, read 13 Nov 2026; active-user window undefined | 13 Nov 2026 | verified as of read date; window not defined — footnoted |
| 825.8B+ tokens consumed | AntSeedStats, read 13 Nov 2026 | 13 Nov 2026 | verified as of read date |
| Opus 5.5 $4.00 list / $1.68 network median / $0.84 after 50% back; −79% | AntSeedStats (OpenRouter list price), 13 Nov 2026; Solid retail cross-check from solid.xyz/post/ai-agents-antseed, 8 Nov 2026 | 13 Nov 2026 | arithmetic checks out (0.84/4.00). $1.68 is the network median for a healthy paid listing, not Solid's $0.21 retail; Solid retail and caps are disclosed on the slide |
| Kimi K3 $3.75 list / $0.72 after 50% back; −81% | Amos's brief p5; AntSeedStats (Venice for Kimi) | 13 Nov 2026 | arithmetic checks out (0.72/3.75) |
| DeepSeek V4.1 Flash $0.30 list / $0.014 after 50% back; −95% | Amos's brief p5; AntSeedStats | 13 Nov 2026 | arithmetic checks out (0.014/0.30) |
| Top models on one key: 6 | Solid launch post (Claude Opus 5.5, Claude Sonnet 5.5, GPT-6.1 Sol, DeepSeek V4.1 Flash, Kimi K3, GLM 5.3) | 8 Nov 2026 | verified public; replaces the "five model families" claim |
| "New on Solid: AI agents, powered by @AntSeed…" | @SolidYield post, 8 Nov 2026 (solid.xyz/post/ai-agents-antseed) | 8 Nov 2026 | verified public |
| "Cashback in two ways… 50% back, for everyone" | @SolidYield follow-up, 12 Nov 2026 | 12 Nov 2026 | verified public |
| Solid launch date 8 Nov 2026 | solid.xyz blog | Nov 2026 | verified |
| Solid Opus retail $0.21/M input ($0.105/M after cashback) | solid.xyz/post/ai-agents-antseed | 8 Nov 2026 | verified public; disclosed to distinguish retail from network median |
| 6% APY, $0 monthly fees, 20%/10% subscription cashback, 50% agents cashback | solid.xyz (blog + product pages) | 12 Nov 2026 | verified public |
| Cashback caps $50/mo (Core), $100/mo (Prime), $200/mo (Ultra) | Solid's published terms (solid.xyz) | 12 Nov 2026 | verified; footnoted on the case-study slide |
| Signed responses / model fingerprint verification | antseed.com/docs | Nov 2026 | official claim; deck footnotes it as strong evidence, not cryptographic proof |
| Prompts not stored; only usage counts for billing | Solid's published description of its implementation (solid.xyz, 12 Nov 2026) | 12 Nov 2026 | partner-published claim; footnoted as "as Solid describes its implementation"; other providers may differ |
| Mainline DHT / "BitTorrent for AI" | antseed.com homepage | Nov 2026 | official claim |
| Gateway: per-customer API keys, provider/budget control, usage console | antseed.com/docs/gateway/ | Nov 2026 | official claim |
| Antseed Points on eligible usage; each Thursday Points determine a share of weekly ANTS rewards | Amos's brief p6; Solid public reward framing | 16 Nov 2026 | conditional public wording only; public weekly mechanics verified on antseedpoints.com; allocation varies, no fixed conversion asserted; deck says "eligible" and "under program terms" |

## Known limitations

- Network-stats numbers are a 13 Nov 2026 AntSeedStats snapshot; the deck cites the read date and adds `+` to growing metrics.
- Pricing examples are historical (13 Nov 2026), labeled as such on the slide.
- Antseed Points are not presented as guaranteed bank revenue. Paid buyer usage accrues Points under the public program; no 1:1 conversion is asserted.
- Solid's private traction figures (users, keys, requests, tokens) are intentionally NOT in this deck — partner-reported, not approved for marketing.
- The internal-case-study-strategy.md document is internal-only and was not used as deck content.

## Corrections history

- The original review flagged "−78% should be −79%". Geometry check of the source PDF proved −78% belongs to the GPT card (2.23/10.00) and is correct. Reverted in the Slides deck and never applied here. The Opus block in the PDF carries no percentage; this deck shows −79% for Opus computed from its own figures (0.84/4.00), consistent with the deck's "$4.00 to $0.84" line.
- "Five model families" was replaced with "Top models on one key: 6" after verifying the six-model public launch list. The older family count was internally defensible but confused the partner-facing claim.
- `$ANTS` revenue wording was replaced with conditional Antseed Points language after the public facts showed points determining a weekly ANTS reward share, not a guaranteed second revenue line.
- The $1.68 example was relabeled as a network median after confirming Solid retails Opus at $0.21/M input; the slide now discloses the difference rather than implying it is Solid's retail price.
## 17 November factual review

Growing network snapshots carry a trailing +; their original read dates are retained. The neobank decks use 920+/269+/24,610+/825.8B+ (13 November); creators uses 942+/274+/28,254+/905.05B+ (16 November). These are dated snapshots, not new readings.

Solid’s six-model list, cashback caps and data handling were checked against https://solid.xyz/post/ai-agents-antseed. Opus’s $1.68/$0.84 example is explicitly a historical network median, distinct from Solid retail $0.21/$0.105. GPT-6.1 Sol is no longer a renamed old price: its card uses the public Solid table ($2.00 list, $0.089 retail, $0.0445 after cashback per million input tokens; table dated 4 November; rounded saving 98%). Kimi and DeepSeek remain labeled historical network examples. Cashback is capped at $50/$100/$200 monthly for Core/Prime/Ultra.

Rewards use conditional Antseed Points language, with a variable share of weekly ANTS rewards under program terms, not a fixed conversion or guaranteed bank revenue. Public mechanics: https://antseedpoints.com/. Provider processing, billing retention and variation in provider practices are disclosed. Model verification is evidence, not cryptographic proof. No draft CEO testimonial is presented as an endorsement.

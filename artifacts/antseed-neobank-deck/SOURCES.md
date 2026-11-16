# Sources — neobank offering deck (HTML)

Working notes for claims made in this deck. Every claim carries a source and a status. Content fixed/verified 16 Nov 2026.

| Claim in deck | Source | Date | Status |
|---|---|---|---|
| 920 models through one API | AntSeedStats (https://antseedstats.com), read 13 Nov 2026, CC BY 4.0; also Amos's brief | 13 Nov 2026 | verified as of read date (snapshot; grows over time) |
| 269 providers (all time) | AntSeedStats, read 13 Nov 2026 | 13 Nov 2026 | verified as of read date |
| 24,610 total active users | AntSeedStats, read 13 Nov 2026; active-user window undefined | 13 Nov 2026 | verified as of read date; window not defined — footnoted |
| 825.8B tokens consumed | AntSeedStats, read 13 Nov 2026 | 13 Nov 2026 | verified as of read date |
| Opus 5.5 $4.00 list / $1.68 on Antseed / $0.84 after 50% back; −79% | Amos's brief p5; AntSeedStats (OpenRouter list price) | 13 Nov 2026 | arithmetic checks out (0.84/4.00); −79% not in the PDF, added in the HTML for the Opus block (the PDF's −78% label belongs to the GPT card) |
| GPT-6.1 Sol $10.00 list / $2.23 after 50% back; −78% | Amos's brief p5 (renamed from the PDF's "GPT-6 Astra"); AntSeedStats (OpenRouter list price) | 13 Nov 2026 | −78% verified correct (2.23/10.00); naming per Ravi's fix decision |
| Kimi K3 $3.75 list / $0.72 after 50% back; −81% | Amos's brief p5; AntSeedStats (Venice for Kimi) | 13 Nov 2026 | arithmetic checks out (0.72/3.75) |
| DeepSeek V4.1 Flash $0.30 list / $0.014 after 50% back; −95% | Amos's brief p5; AntSeedStats | 13 Nov 2026 | arithmetic checks out (0.014/0.30) |
| "New on Solid: AI agents, powered by @AntSeed…" | @SolidYield post, 8 Nov 2026 (solid.xyz/post/ai-agents-antseed) | 8 Nov 2026 | verified public |
| "Cashback in two ways… 50% back, for everyone" | @SolidYield follow-up, 12 Nov 2026 | 12 Nov 2026 | verified public |
| Solid launch date 8 Nov 2026 | solid.xyz blog | Nov 2026 | verified |
| 6% APY, $0 monthly fees, 20%/10% subscription cashback, 50% agents cashback | solid.xyz (blog + product pages) | 12 Nov 2026 | verified public |
| Cashback caps $50/mo (Core), $100/mo (Prime), $200/mo (Ultra) | Solid's published terms (solid.xyz) | 12 Nov 2026 | verified; footnoted on the case-study slide |
| Signed responses / model fingerprint verification | antseed.com/docs | Nov 2026 | official claim; deck footnotes it as strong evidence, not cryptographic proof |
| Prompts not stored; only usage counts for billing | Solid's published description of its implementation (solid.xyz, 12 Nov 2026) | 12 Nov 2026 | partner-published claim; footnoted as "as Solid describes its implementation" |
| Mainline DHT / "BitTorrent for AI" | antseed.com homepage | Nov 2026 | official claim |
| Gateway: per-customer API keys, provider/budget control, usage console | antseed.com/docs/gateway/ | Nov 2026 | official claim |
| $ANTS rewards on usage | Amos's brief p6 | 16 Nov 2026 | as written in the brief; **pending Amos's confirmation of mechanics** — deck footnotes that allocations are defined by Antseed's program terms |

## Known limitations

- Network-stats numbers are a 13 Nov 2026 AntSeedStats snapshot; the deck cites the read date.
- Pricing examples are historical (13 Nov 2026), labeled as such on the slide.
- $ANTS: keep as Amos wrote it, per Ravi (16 Nov). Do not pitch as bank revenue until Amos confirms.
- Solid's private traction figures (users, keys, requests, tokens) are intentionally NOT in this deck — partner-reported, not approved for marketing.
- The internal-case-study-strategy.md document is internal-only and was not used as deck content.

## Corrections history

- The original review flagged "−78% should be −79%". Geometry check of the source PDF proved −78% belongs to the GPT card (2.23/10.00) and is correct. Reverted in the Slides deck and never applied here. The Opus block in the PDF carries no percentage; this deck shows −79% for Opus computed from its own figures (0.84/4.00), consistent with the deck's "$4.00 to $0.84" line.
- "Five model families" was flagged vs "six top models" — not an error: 5 families (Claude, GPT, DeepSeek, Kimi, GLM), 6 models (Opus + Sonnet both Claude). Kept.

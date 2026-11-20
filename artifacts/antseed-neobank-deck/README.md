# Main neobank presentation

Restored to the exact 13-slide HTML version at https://antseed-neobanks-presentation.vercel.app/ on 17 November 2026, at the user’s request.

Live main deck: https://antseed-neobanks-offering.vercel.app/

The HTML matches the reference byte for byte. Original PDF pages 11 and 12 are omitted; the three bottom points from page 11 appear on slide 10. Copy, historical pricing, stats, source dates, artwork, typography, mobile reading mode and controls are restored with the reference.

Open `index.html` directly; fonts and artwork are embedded. Print includes all 13 landscape slides. The source/design maps come from `antseed-neobanks-presentation/`. The previous 14-slide revision remains in Git history. Existing legacy asset/style files are unused by this standalone version.

## User update

User-authored edits from commit 49f424f are included in the latest deployment. This HTML now differs from the original reference; the 13-slide layout is retained.

## Deploy GitHub edits

After Commit & Push in the browser editor, run:

```sh
bash /Users/jys/orca/workspaces/kanban-workflow/antseed-decks-publish/scripts/deploy-antseed-neobank.sh
```

This pulls the latest main branch, builds a fresh PDF using local Chrome, copies the current HTML and PDF into isolated deployment folders and publishes both main-deck Vercel projects. It verifies the live files against the published source. Vercel CLI, Git, Python 3 and Google Chrome must be installed and Vercel must be signed in. Deployment cache defaults to ~/.cache/antseed-vercel; ANTSEED_DEPLOY_ROOT and ANTSEED_CHROME can override the paths.

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

Footer credits and usage notes no longer appear on slides.
Source details remain in the metadata and source records.

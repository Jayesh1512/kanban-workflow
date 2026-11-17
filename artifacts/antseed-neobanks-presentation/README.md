# Antseed neobanks presentation

[Live presentation](https://antseed-neobanks-presentation.vercel.app/)

13-slide HTML conversion of **Antseed - AI agents for neobanks (Solid case study).pdf**. Original pages 11 and 12 are omitted. The three bottom points from page 11 are preserved on slide 10: **Rewards tab**, **Everyone**, **On top of tiers**. The remaining pages retain their order and historical pricing, stats and source dates.

Open `index.html` in a browser. This is one offline HTML file with bundled fonts and artwork, selectable text, arrow-key and button navigation, a slide menu, fullscreen, touch navigation and a mobile reading layout. Browser Print includes all 13 landscape slides. No build step or dependency installation is required.

`story-map.json` records source-page mapping and provenance. `design-map.json` records the reference measurements and typography. Artwork and non-text chart shapes are embedded images; slide copy is native SVG text on desktop and HTML text on mobile.

## Deploy

This folder is a standalone static Vercel project. Deploy only this directory, using its local `vercel.json`:

```sh
vercel --cwd artifacts/antseed-neobanks-presentation --project antseed-neobanks-presentation --scope jayesh1512s-projects --prod --yes
```

The repository-root Vercel configuration belongs to the CRM application.

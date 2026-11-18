# Antseed for creator studios

Eight-slide pitch for AI creator studios and creative platforms.
The audience includes product, engineering and business teams.
Higgsfield provides audience context only.
The deck makes no customer or partnership claim about Higgsfield.

1. Your creative platform: model access behind the studio.
2. Studio problems: generation costs, provider failures, integrations and account costs.
3. Model access: video, image and voice through one integration.
4. Reliability: retry through compatible providers when capacity is available.
5. Gateway: keys, budgets and usage per customer or workspace.
6. Studio benefits: costs, model choice, dependencies, account controls, prompt handling and conditional Points.
7. Network figures: the existing snapshot and live refresh.
8. Pilot: compare one workflow before planning a rollout.

[Live deck](https://antseed-creators-pitch.vercel.app/)

Open the packaged standalone HTML for offline use.
Use arrow keys, Home, End, slide dots or F for fullscreen.
The mobile layout provides a reading area above the controls.
Download as PDF includes all eight slides.

Run `python3 package.py` to rebuild the standalone HTML and source ZIP.
Rebuild the PDF from that HTML before deployment.
The PDF uses the bundled dated network snapshot.
The live page keeps its one-minute stats refresh.
The deployed `/api/stats` handler must remain available to the other Antseed decks.
See `../../scripts/ANTSEED-LIVE-STATS.md` for deployment details.

The four model-price examples retain their source dates and units.
They are examples, not current studio quotes or promised savings.
Provider availability, compatibility, capacity and limits apply.
Gateway records support cost allocation, not a complete consumer billing product.
Your selected provider processes prompts under its data policy.
Points and ANTS rewards remain subject to program terms.

The source outline records the original individual-creator brief.
The current audience and evidence appear in `story-map.json`.
The design changes appear in `design-map.json`.
The original brand audit remains historical.
The studio review records the current checks.
Stats credits and usage footnotes remain absent from slide footers.
Attribution, dates and definitions remain in metadata and source records.

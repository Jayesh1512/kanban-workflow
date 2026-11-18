# Live deck stats

All three deck stats slides refresh once per minute while the page is visible.
They refresh on load and after navigation when the previous request is old.
Each deck keeps its saved figures if the network fails.
The status shows `Live`, `Saved`, or `Snapshot` with the fetch time in UTC.
PDF files keep a dated snapshot.

The browser reads `https://antseed-creators-pitch.vercel.app/api/stats`.
The endpoint allows cross-origin reads and caches successful responses for 60 seconds.
It requires no key.

The endpoint combines these sources:

- `/api/v1/models?limit=1&view=all`: canonical model count.
- `/api/v1/network/summary`: lifetime settling provider count.
- The homepage: its published participant count and lifetime paid/free token total.

The public API omits the last two homepage totals.
Do not substitute paid buyers or paid tokens for those figures.
Participant roles can overlap.
Token totals use the homepage's displayed precision.

The adapter rejects missing fields and invalid values.
The endpoint returns HTTP 502 if any source fails.
The browser then keeps the last complete snapshot.
It marks responses older than three minutes as saved.

Run `node scripts/refresh-antseed-stats.cjs` to update all saved snapshots.
Pass one deck folder name to update only that deck.
Then run both `package.py` scripts and rebuild the PDFs.
The main neobank deploy helper refreshes its snapshot before export.

For the creators Vercel project, keep these files beside `public/`:

```text
api/stats.js                  <- scripts/lib/antseed-stats-api.cjs
lib/antseed-stats.cjs          <- scripts/lib/antseed-stats.cjs
```

Keep `outputDirectory` set to `public` and `framework` set to `null`.
The neobank projects remain static.
They use the shared creators endpoint.

Run `python3 scripts/prepare-antseed-deploys.py` after the exports pass review.
It prepares four isolated deployment folders under `~/.cache/antseed-vercel`.
It also adjusts the deployed handler's library path.
Link each folder to its matching project before the first deployment.

Source: https://antseedstats.com/developers
Data license: AntSeedStats, CC BY 4.0.

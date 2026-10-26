# AntSeed · real-platform two-minute demo

**Final deliverable:** `out/antseed-real-platform-demo-2min.mp4`, with matching `.srt`. 1920×1080, 30 fps, 120 seconds. Narration and burned-in captions. Every scene uses actual screen recordings; the final cut contains no synthetic-company footage or illustrated product screens.

## What the final cut shows

- **Running work board and Phala card:** fresh recordings from the actual service at localhost19281 on 26 October IST. Loading and connection waits are omitted. Contact phone/email values are masked in the recorded card presentation, without changing stored data.
- **Real CRM dashboard:** the previously built read-only outreach dashboard, containing 29 pipeline relationships. It is explicitly a saved snapshot of 23 October Telegram-derived board evidence and the 25 October raviAntBot email report. Native work lanes and the five CRM stages remain different concepts.
- **Actual dashboard interactions:** expanding context, Phala search, email source filter, and CSV download. No email inbox was newly queried, and display classifications are not falsely presented as accepted native board moves.
- **Live operations page:** recorded connection status and connected Telegram control-group settings. No new group, approval, external message, live deal movement or model call was initiated for this film.
- Hermes/MCP is described as an existing capability; no fresh Hermes/model execution is claimed. AI extraction validation remains degraded and integrated CRM rollout is pending.

An isolated copy of an actual 23 October Vikunja backup was temporarily used while the live service was stalling. **Those fallback clips are not in the final cut.** Both labeled temporary containers and their network were removed. Final work-board/card footage was subsequently captured from the running production instance. A scoped restart of only the existing personal Vikunja container was performed during recovery; its data and session volumes were preserved.

## Preview and edit

The project reuses existing Remotion4.0.534 dependencies via a local symlink. It does not alter the backend package or lockfile. Homebrew's default Node binary currently has a missing system library, so commands use the installed Node22 binary.

```sh
cd artifacts/product-demo-2min
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run studio
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run render
```

Preview: http://localhost:19394/AntSeedRealPlatformDemo

`src/RealDemo.tsx` is the editable eight-chapter timeline. `prepare-real.py` creates macOS Samantha narration, captions and normalized source clips. `evidence/real-timeline.json` holds the exact script/timing; the source manifest records cuts and evidence limits.

Raw recordings and report downloads contain private business context, are ignored by Git, and have restricted local permissions. Login credentials and JWTs are never rendered or printed. Authentication was performed before capture using the existing private runtime configuration; temporary login bridges have been stopped.

The earlier synthetic draft is preserved as `out/superseded-synthetic-draft.mp4`; it is not the requested final deliverable.

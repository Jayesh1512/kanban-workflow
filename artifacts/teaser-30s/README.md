# AntSeed Kanban — 30-second teaser

Editable Remotion motion-design teaser, 1920×1080, 30 fps, exactly 900 frames.

## Preview

```sh
cd artifacts/teaser-30s
npm install
npm run studio
```

Current local Studio: http://localhost:19390/AntSeedTeaser

The current checkout reuses an existing, matching local Remotion 4.0.534 dependency directory through an ignored node_modules symlink. For a standalone clone, install this package normally. When replacing that existing local symlink, unlink it before installing so its external target stays unchanged. No changes were made to the application package or services.

## Scenes

| Time | Story |
| --- | --- |
| 0–5 s | The next step gets lost in chats. |
| 5–11 s | An outbound enquiry becomes an identifiable prospect and follow-up. |
| 11–18 s | Company, next action, contacts, ownership and deadlines become clear. |
| 18–25 s | AI suggests a lane change; a Telegram approval precedes the movement. |
| 25–30 s | AntSeed Kanban: Less chasing. More progress. |

All UI is authored illustration using synthetic Cedar Labs / Northstar examples. It is **not a recording of a live account, model inference, or approval**. No personal data, secrets or private UI are used. The card layout is simplified for video readability. This is promotional explanation, not additional live integration evidence.

## Editing and export

Each scene has its own composition and file; the main editable timeline is src/Root.tsx. All animation is frame-driven. All assets are local. The original synthesized soundtrack has no third-party music or sample dependency. DM Sans is distributed under the included OFL license.

```sh
npm run typecheck
npm run render
```

The render script exports out/antseed-teaser-30s.mp4 (H.264). The finished MP4 and its export-validation.json are included in Git; temporary review images are ignored. The Studio also offers its own Render interface.

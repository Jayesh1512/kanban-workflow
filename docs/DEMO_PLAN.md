# AntSeed final demo recording

Owner: PM, with QA supplying verified fixtures and evidence. Record after the final
implementation and acceptance run. This plan does not claim that live Telegram,
successful Jev inference, or actual Hermes acceptance has passed.

## Recording gate

- Identify the exact release-candidate commit, image and isolated Compose project.
- Close reproduced code P0/P1 defects and complete the integrated regression run.
- Use synthetic companies and contacts; capture no private chat lists, credentials,
  login codes, passwords, personal messages, session paths or provider headers.
- Finish any real account onboarding before recording. Use only the designated
  test/control chats for live demonstrations.
- Record evidence for each integration separately. A synthetic Telegram event or
  authored model result must be labelled on screen for its whole segment.
- Successful live Jev remains blocked by the recorded Vercel entitlement error
  until access changes. Show a truthful pause/replay path if it remains blocked;
  never present a synthetic classification as successful live Jev inference.
- Run the installed Nous Hermes CLI. A generic MCP client or a staged terminal
  animation is insufficient. A displayed capture of its actual transcript should
  be labelled as a recorded transcript.

## Storyboard: approximately three minutes

| Time | Actual action | Visible result |
| --- | --- | --- |
| 0:00–0:20 | Open the running AntSeed board | Six exact lanes; independent workstream labels; one synthetic company chat per ticket. |
| 0:20–0:45 | Show connection state and chat inclusion | Explain included-by-default discovery and one exclusion; show verified live state or an explicit synthetic-source label. |
| 0:45–1:10 | Open a company ticket and its context | Shared company/contact directory, sourced roles, the latest conversation and AntSeed's next action/date. |
| 1:10–1:40 | Process a verified test conversation | A supported lane-change proposal appears; show its evidence and the unchanged board lane before approval. |
| 1:40–2:10 | Reply to the operational proposal | Actual approval correlation and remote readback; the ticket moves once to its approved lane. |
| 2:10–2:45 | Ask actual Hermes for today's priorities | Evidence-backed action/date briefing; show proposal-only movement through the available MCP tools. |
| 2:45–3:00 | Return to board/status | Summarize the observed outcome and any still-blocked live integration plainly. |

Use one continuous synthetic company story, such as Cedar Relay, rather than
unrelated fixtures between cuts. Select the final wording and actors from the
accepted QA dataset. If a live prerequisite is unavailable, revise the storyboard
around demonstrated behavior and keep the boundary explicit.

## Capture and edit

- Prefer 1920×1080, 30 fps, readable zoom and steady framing. Keep all six lanes
  legible, using deliberate close-ups for contact details and evidence.
- Use T3 collaborative preview recording for browser footage. Capture actual
  terminal execution separately when needed; preserve its sanitized evidence.
- Hold each important result long enough to read. Cut idle waits without hiding
  failed steps or implying an unverified causal transition.
- Add concise captions explaining the user's action and result. Use simple title
  cards and clean cuts; narration is optional, music unnecessary.
- Verify the final MP4 with ffprobe, inspect representative frames and watch the
  complete export for readability, incorrect labels and accidental private data.

## Delivery artifacts

- `artifacts/demo/antseed-kanban-demo.mp4`
- Matching captions (`.vtt` or `.srt`).
- Sanitized evidence manifest: commit/image, recording time, isolated project,
  segment boundaries, actual versus synthetic integrations and test references.

Record once the product is ready; do not substitute this storyboard or an animated
mockup for the requested working-project video.

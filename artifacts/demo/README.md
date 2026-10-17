# AntSeed working-project demo

[Watch the narrated demo](antseed-kanban-demo.mp4) · [captions](antseed-kanban-demo.srt)
· [independent final review](QA_REVIEW.md)

The export is 2:49, 1920×1080 at 30fps, H.264/AAC. The MP4 is generated locally
and excluded from Git; it is present in this workspace. `evidence-manifest.json`
records its hash, runtime image, boundaries and verification details.

The recording shows the actual Vikunja UI, company contacts and evidence,
chat-policy controls, a pending proposal, explicit operator HTTP approval,
canonical-worker movement/readback and priorities. It uses synthetic Telegram
messages and authored extraction/Jev decisions, labelled throughout. The Hermes
card is a separate **recorded independent verification** of the actual installed
agent, not a new model invocation or a staged terminal animation.

The before/after records are `cedar-pending-readback.json` and
`cedar-applied-readback.json`. The latter verifies Work in progress, stage1,
approved/applied and one committed journal. No task reset was used. An idle
Vikunja refresh in the original approval capture is cut to a later genuine
capture of the same applied task; `timeline.json` records both source cuts.

Live Telegram login/import/control delivery is still unverified. Successful Jev
inference through Vercel remains blocked by the previously observed Gateway
credit restriction. The demo makes neither claim. Its operator approval is HTTP;
it does not pretend a live Telegram reply was sent.

`capture-sources.json` and `final-board-capture.json` reference the native T3
browser recordings kept in local attachments. The renderer adds typography,
captions and local macOS Samantha narration; it does not invent browser states.
Recreate the edit on this Mac with `python3 artifacts/demo/render-demo.py`
(Pillow, ffmpeg/ffprobe and macOS `say` are editing dependencies only).

The recording starts after private synthetic-service login. No provider key,
password, login code or private Telegram history is included. A private value
comparison against supplied AI and generated service credentials found zero
matches in the generated artifacts. Source clips and representative export
frames were inspected; the complete export decodes without errors.

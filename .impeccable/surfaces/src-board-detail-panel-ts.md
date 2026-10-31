---
version: 1
slug: "src-board-detail-panel-ts"
primary_target: "src/board/detail-panel.ts"
related_targets: ["src/board/ticket-details.ts", "src/board/page.ts", "src/outreach/page.ts"]
---

# Shared ticket detail panel

Mode: Operate. A scoped extension of the native workspace's neutral/green visual system. The user selected a large panel and explicitly retained Jayesh as Viewer.

## Direction contract

THESIS: Inspect a ticket's context and provenance in one large shared panel, with direct moves available only to authorized people.
OWN-WORLD: Inherit the existing native workspace tokens, system sans, flat separators, 12px corners, 42px controls, and visible focus. No new brand world or decorative imagery.
STORY: Open a card from Overview, Work, or CRM; inspect the current record, its sources and activity; make an authorized change; return to the refreshed board.
FIRST VIEWPORT: Sticky ticket title and type/current placement, visible Close, then the lane or stage and either direct-move controls or explicit read-only status, followed by record details.
FORM: A bounded native modal dialog on desktop and a full-viewport panel on mobile. Secondary source groups, record identifiers, edits, and proposal history use inline disclosure within the panel.
FINISH: Source, captured previews, browser-checks.json, detector advisories, and documentation review live in `.impeccable/review/ticket-details/`.

## Built surface

The desktop panel is at most 960px wide and 90dvh tall, with a sticky header and scrollable content. At 700px and below it fills the viewport with 16px side insets and two-column metadata. The heading can shrink and wrap while Close keeps its width. These dimensions belong to the panel only.

Personal tasks expose details and activity; only a non-viewer owner can edit, delete, or move them. CRM Work adds company, contacts, blockers, parent relationship, facts, evidence, and paginated stored messages. CRM relationships add next actions/deadlines, linked Work, conversation sources, and activity. Missing data stays explicitly unknown. Shared CRM/Work moves require Admin or CRM manager authorization. Pending proposal detail remains private to reviewers. Human moves save immediately; approval behavior is preserved.

The source uses a native dialog labelled by its heading, initial Close focus, Escape behavior, body-scroll locking, opener-focus restoration, status/error announcements, and retry/reload affordances. Captures and the checked browser report provide synthetic preview evidence; they do not establish production sign-in, production volume, or real account changes.

## System boundary

The local modal scrim and 16px/21px panel heading steps are documented as surface values. Existing `DESIGN.md`, its sidecar, the historical snapshot, and the earlier workspace surface record remain unchanged. No product raster assets were added.

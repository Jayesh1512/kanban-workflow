# AntSeed outreach workflow

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

AntSeed's team manages company and contact relationships through Telegram, Vikunja and Nous Research Hermes. This dashboard is for the team's private outreach review.

## Product Purpose

Show the pipeline stages first, then make the underlying conversations, contacts, next actions and sourced dates easy to inspect. This ordering was explicitly confirmed on 25 October 2026.

## Operating Context

The backend and Vikunja use Supabase PostgreSQL. Telegram supplies conversation evidence. Hermes can query the existing AntSeed MCP integration. The user requested an email-insights inquiry to raviAntBot through Hermes.

## Capabilities and Constraints

- Native workflow lanes: To be started, Work in progress, Integrations, Blocked, Archived, Completed.
- This outreach dashboard uses the user-selected CRM stages: Lead / Prospect, Qualification, Negotiation, Deal Won, Archived. These are evidence-derived display classifications and do not rename or move native workflow lanes.
- Workstreams: Buyer, Provider, Integration, Others.
- A ticket represents a chat; companies and contacts can span multiple tickets. Board cards, companies, messages and verified outbound conversations are different counts.
- Unknown companies remain contact prospects. Internal and unclassified chats can appear on the board and must not automatically be called sales leads.
- Preserve these chats in a separate context-review section. Historical and research-only leads remain labelled and are excluded from verified sent-email totals.
- Proposals and actual lane placements have separate states. The dashboard reads records; it does not approve, send outreach or move cards.
- Missing dates and unavailable email counts remain unknown. Completed does not establish revenue or a deal won.
- The dashboard uses a clearly dated verified snapshot when current sources cannot be read. Coverage must remain visible.

## Evidence on Hand

The card-format validation retained 38 visible native Vikunja cards and six soft-deleted cards in a verified 23 October 2026 snapshot. Live MCP and direct database reads timed out during the dashboard collection on 25 October. An inquiry to @raviAntBot was delivered through Hermes to the existing Partner–Antseed group. The user supplied the bot's two-part report: a 47-message/31-thread mailbox scope with eight sent emails across seven companies. The dashboard attributes this report rather than claiming an independent mailbox query. No installed skill named Vikunja Kanban was found.

## Product Principles

- Put pipeline stage before next-action detail.
- Preserve source identity, timestamps and uncertainty.
- Keep every board record inspectable while distinguishing company-linked cards from unclassified conversations.
- Missing information must not become a zero or a successful outcome.
- Preserve existing operational data and approval behavior.

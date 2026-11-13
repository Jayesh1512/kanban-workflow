# Company directory: the primary data source

**The `companies` and `contacts` tables are the primary source of truth for every
company we track and every person (employee, founder, contact) at those companies.**
Boards, the CRM, outreach and the `/directory` page all read from them. Nothing
else holds an authoritative list of companies or their people.

## Tables

`companies` (one row per company; `id` is a UUID)

| Column | Meaning |
| --- | --- |
| `canonical_name`, `aliases[]`, `domains[]`, `summary` | Identity. Names, aliases and domains are deliberately not unique, so collisions surface as ambiguity instead of silently merging. |
| `source` | Where we found the company, kept verbatim from the Hitlist sheet (`openrouter_apps`, `w3base_companies`, `near_ecosystem_research`, `surplus_buyer_research`, `vercel_ai_sdk_showcase`, `vercel_customer_stories`, `dappradar_ai_narrative`). Null for companies that came from Telegram chats. No CHECK constraint, so new sources need no migration. |
| `source_url`, `listing_url` | Evidence and listing links for that source. |
| `funding`, `employees`, `location` | Enrichment. Text, because the sheet has no normalised values (`$4.5M`, `13-15`, `Bootstrapped`). |
| `category`, `status`, `evidence_level`, `usage_metric` | Sheet classification (`status` is `collected` or `candidate`). |
| `outreach_tier`, `outreach_score`, `customer_potential_score` | Outreach prioritisation from the sheet (for example `A — target now`). |
| `insights`, `notes`, `retrieved_at` | Company research notes. Unattributed emails and Telegram/Discord links are appended to `notes`. |

`contacts` (one row per person)

| Column | Meaning |
| --- | --- |
| `company_id` | **Foreign key to `companies(id)`.** The person's company. Nullable: our own team and people not yet tied to a company have none. |
| `names[]`, `usernames[]`, `emails[]`, `phones[]` | Identity and contact details. |
| `title` | Their role, for example `Co-Founder & CTO`. |
| `linkedin`, `x_account`, `telegram`, `discord` | Profiles. |
| `contact_type`, `contact_confidence`, `notes` | How reliable the route to this person is. |
| `affiliation` | `internal`, `external` or `unknown`. Internal people are listed on `/antseed-team`, never in the directory. |

`contact_company_roles` stays as the many-to-many history of roles. `contacts.company_id`
is the person's primary company.

Schema: `db/migrations/001_initial.sql` plus
`db/migrations/202611120002_directory_sheet_fields.sql`.

## What reads it

- **`GET /api/board/directory`** and the **`/directory`** page list every row of
  `companies`, whether or not we have a conversation with it, with its people
  (`contacts.company_id`, plus people linked by a recorded role or by evidence in an
  approved chat). Companies are ordered by `outreach_score`. Conversations are
  secondary detail: only approved company chats are shown.
- Tickets, chats, outreach relationships, mapping history and meeting links all
  reference `companies(id)`.

## Loading and changing data

- The initial load came from the "Antseed - Hitlist" Google Sheet: 230 rows merged to
  204 companies and 176 people. Duplicates were merged by website (else name). The
  best-ranked row supplies the scalar fields.
- Existing companies were matched by domain or name and **only empty fields were
  filled**; existing names and summaries were never overwritten.
- New sources: add rows, set `source` to the new label, and keep `contacts.company_id`
  set. There is no separate import table.
- Do not add a second list of companies elsewhere. Extend these tables.

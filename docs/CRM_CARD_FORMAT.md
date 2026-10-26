# CRM card format

Every native CRM card uses the same evidence-first structure. The goal is to make a sales opportunity understandable without opening the source chat, while preventing the board from inventing commercial facts.

## Required sections

1. **Opportunity summary** — account or person, relationship type, workstream, lead source, last sourced activity and source freshness.
2. **Pipeline stage** — accepted stage, a plain-language definition, and the evidence threshold for leaving that stage.
3. **Next step** — the next AntSeed action, owner and any sourced deadline.
4. **Qualification (BANT)** — Budget, Authority, Need and Timeline, with each term defined on the card.
5. **Commercial terms** — estimated value, currency, pricing, payment, procurement and contract evidence, expected close date, decision process and forecast probability.
6. **Stakeholders and contacts** — known names, roles, affiliations and visible contact details.
7. **Customer need and proposed solution** — business problem, technical/delivery scope, proposed AntSeed solution, success criteria and alternatives.
8. **Risks, blockers and open questions** — unresolved questions and evidence-backed obstacles.
9. **Approved conversation evidence** — attributed Telegram or email-report excerpts and source links when present.
10. **Record controls** — projection markers and the rules used to distinguish approved facts from unknowns.

## Evidence rules

- Missing commercial data is rendered as **Not established from approved evidence**.
- Stage alone never supplies a probability, amount, close date, authority or purchase process.
- Silence never implies rejection, qualification or a deadline.
- Review-only cards do not expose unapproved conversation claims.
- A card update changes its wording and details without changing its approved sales stage.

## Pipeline meanings

| Stage | Meaning | Exit criterion |
| --- | --- | --- |
| Lead / Prospect | Identified or contacted, without a qualified two-way evaluation. | Confirmed interest and an active fit/need conversation. |
| Qualification | Both parties are evaluating need, fit and the buying or partnership process. | Concrete commercial, pricing, contract or approval terms are being agreed. |
| Negotiation | Commercial, contract, procurement, security or final-scope terms are under active agreement. | Evidenced purchase, agreement or commercial commitment. |
| Deal Won | The commercial relationship has an evidenced won outcome. | Remains won unless an explicit reviewed decision reopens it. |
| Archived | Explicitly closed, declined, disqualified, duplicated or intentionally removed. | New evidence plus a reviewed reopening decision. |

## Field-model basis

The format combines standard opportunity fields (account, amount, close date, lead source, next step, probability and stage), BANT qualification, buying-process and stakeholder context, and deal ownership/description. Product links are retained here so maintainers can review the field basis:

- Salesforce Opportunity Fields: <https://help.salesforce.com/s/articleView?id=sf.opp_fields.htm&language=en_US&type=5>
- Microsoft Dynamics opportunity stages: <https://learn.microsoft.com/en-us/dynamics365/sales/move-opportunity-stages>
- Microsoft sales qualification concepts (BANT): <https://learn.microsoft.com/en-us/dynamics365/sales/sales-qualification-agent-concepts>
- HubSpot default deal properties: <https://knowledge.hubspot.com/properties/hubspots-default-deal-properties>

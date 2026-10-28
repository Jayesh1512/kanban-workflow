-- A user may explicitly approve or reject a preserved chat through the local
-- operator workflow. Keep this provenance distinct from a correlated Telegram
-- control reply; never fabricate Telegram message IDs for an operator action.

ALTER TABLE chat_intake_requests
  ADD COLUMN decision_origin text NOT NULL DEFAULT 'telegram'
    CHECK(decision_origin IN ('telegram','operator')),
  ADD COLUMN operator_reason text;

ALTER TABLE chat_intake_requests
  ADD CONSTRAINT chat_intake_operator_audit_check CHECK (
    decision_origin <> 'operator' OR (
      decision IN ('approved','rejected')
      AND decided_at IS NOT NULL
      AND operator_reason IS NOT NULL
      AND length(btrim(operator_reason)) > 0
    )
  );

-- A CRM card can start without an imported conversation: a person records a
-- company they already talk to elsewhere, and puts it at a stage themselves.
-- The card stays honest: it is marked manual, it carries the operator's reason,
-- and it has no enrolled source. Sourced cards keep the default 'pipeline'.
ALTER TABLE outreach_relationships
  ADD COLUMN IF NOT EXISTS creation_origin text NOT NULL DEFAULT 'pipeline'
    CHECK (creation_origin IN ('pipeline','manual')),
  ADD COLUMN IF NOT EXISTS creation_key text,
  ADD COLUMN IF NOT EXISTS creation_note text;
CREATE UNIQUE INDEX IF NOT EXISTS outreach_relationships_creation_key
  ON outreach_relationships(creation_key) WHERE creation_key IS NOT NULL;

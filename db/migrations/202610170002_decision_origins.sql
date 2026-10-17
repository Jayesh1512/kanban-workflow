-- Preserve historical Jev origins while attributing new native OpenAI decisions.
ALTER TABLE proposals DROP CONSTRAINT proposals_origin_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_origin_check
  CHECK (origin IN ('jev','openai','hermes','manual'));

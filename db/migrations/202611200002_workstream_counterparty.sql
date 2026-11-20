-- Workstream states the direction of trade with the external counterparty:
-- Buyer means AntSeed sells to them; Provider means they supply AntSeed.
-- The earlier acceptance test required a 90% top probability and a 20-point
-- margin. That is the identity bar, not a bar for a five-way descriptive label,
-- so most real verdicts were thrown away and the column fell back to a false
-- "Others". Recompute the stored distributions once with the current rule in
-- src/intelligence/jev.ts (acceptedWorkstream), then fill company and
-- relationship rows that are unclassified.
--
-- A sourced AntSeed sales enquiry is itself direction of trade: AntSeed offers
-- its own services, so the addressed counterparty buys. Use that only when the
-- model abstained, never to override a stated class.
WITH answers AS (
  SELECT chat_id, answers, decision, updated_at, id
  FROM (
    SELECT j.chat_id,
      coalesce(j.jev_diagnostics -> 'answers', j.decision -> 'diagnostics' -> 'answers') AS answers,
      j.decision, j.updated_at, j.id
    FROM analysis_jobs j
    WHERE coalesce(j.jev_diagnostics -> 'answers' -> 'workstream',
                   j.decision -> 'diagnostics' -> 'answers' -> 'workstream') IS NOT NULL
  ) candidate
), latest AS (
  SELECT DISTINCT ON (chat_id) chat_id, answers, decision, updated_at, id
  FROM answers
  ORDER BY chat_id, updated_at DESC, id DESC
), scored AS (
  SELECT chat_id, decision, updated_at, id,
    answer -> 'workstream' ->> 'choice' AS choice,
    (answer -> 'workstream' -> 'confidence')::numeric AS confidence,
    (answer -> 'workstream' -> 'probabilities' ->> (answer -> 'workstream' ->> 'choice'))::numeric AS support,
    (answer -> 'workstream' -> 'probabilities' ->> 'uncertain')::numeric AS uncertain,
    (SELECT max(value::numeric) FROM jsonb_each_text(answer -> 'workstream' -> 'probabilities')) AS top
  FROM latest, LATERAL (SELECT answers AS answer) q
), decided AS (
  SELECT chat_id, updated_at, id, CASE
    WHEN choice IN ('Buyer','Provider','Integration','Others')
      AND coalesce(confidence, 0) >= 0.5
      AND coalesce(support, 0) >= 0.6
      AND coalesce(support, 0) >= coalesce(uncertain, 0) + 0.15
      AND coalesce(support, 0) >= coalesce(top, 0) - 0.000001
      THEN choice
    WHEN decision -> 'outreach' ->> 'outcome' = 'enquiry' THEN 'Buyer'
  END AS workstream
  FROM scored
), company_direction AS (
  SELECT DISTINCT ON (ch.company_id) ch.company_id AS id, d.workstream
  FROM decided d JOIN chats ch ON ch.id = d.chat_id
  WHERE ch.company_id IS NOT NULL AND d.workstream IS NOT NULL
  ORDER BY ch.company_id, d.updated_at DESC, d.id DESC
)
UPDATE companies c SET workstream = d.workstream, version = c.version + 1, updated_at = now()
FROM company_direction d
WHERE c.id = d.id
  AND (c.workstream IS NULL OR (c.workstream = 'Others' AND d.workstream <> 'Others'));

-- A relationship can exist before the source-link migration, so only backfill
-- when the enrollment table is present in this schema.
DO $$
BEGIN
  IF to_regclass(quote_ident(current_schema()) || '.outreach_relationship_sources') IS NULL THEN
    RETURN;
  END IF;

  WITH answers AS (
    SELECT chat_id, answers, decision, updated_at, id
    FROM (
      SELECT j.chat_id,
        coalesce(j.jev_diagnostics -> 'answers', j.decision -> 'diagnostics' -> 'answers') AS answers,
        j.decision, j.updated_at, j.id
      FROM analysis_jobs j
      WHERE coalesce(j.jev_diagnostics -> 'answers' -> 'workstream',
                     j.decision -> 'diagnostics' -> 'answers' -> 'workstream') IS NOT NULL
    ) candidate
  ), latest AS (
    SELECT DISTINCT ON (chat_id) chat_id, answers, decision, updated_at, id
    FROM answers
    ORDER BY chat_id, updated_at DESC, id DESC
  ), scored AS (
    SELECT chat_id, decision, updated_at, id,
      answer -> 'workstream' ->> 'choice' AS choice,
      (answer -> 'workstream' -> 'confidence')::numeric AS confidence,
      (answer -> 'workstream' -> 'probabilities' ->> (answer -> 'workstream' ->> 'choice'))::numeric AS support,
      (answer -> 'workstream' -> 'probabilities' ->> 'uncertain')::numeric AS uncertain,
      (SELECT max(value::numeric) FROM jsonb_each_text(answer -> 'workstream' -> 'probabilities')) AS top
    FROM latest, LATERAL (SELECT answers AS answer) q
  ), decided AS (
    SELECT chat_id, updated_at, id, CASE
      WHEN choice IN ('Buyer','Provider','Integration','Others')
        AND coalesce(confidence, 0) >= 0.5
        AND coalesce(support, 0) >= 0.6
        AND coalesce(support, 0) >= coalesce(uncertain, 0) + 0.15
        AND coalesce(support, 0) >= coalesce(top, 0) - 0.000001
        THEN choice
      WHEN decision -> 'outreach' ->> 'outcome' = 'enquiry' THEN 'Buyer'
    END AS workstream
    FROM scored
  ), relationship_direction AS (
    SELECT DISTINCT ON (r.id) r.id, d.workstream
    FROM decided d
    JOIN outreach_source_threads s ON s.chat_id = d.chat_id AND s.kind = 'telegram'
    JOIN outreach_relationship_sources rs ON rs.source_thread_id = s.id
    JOIN outreach_relationships r ON r.id = rs.relationship_id
    WHERE d.workstream IS NOT NULL
    ORDER BY r.id, d.updated_at DESC, d.id DESC
  )
  UPDATE outreach_relationships r SET workstream = d.workstream, updated_at = now()
  FROM relationship_direction d
  WHERE r.id = d.id
    AND (r.workstream IS NULL OR (r.workstream = 'Others' AND d.workstream <> 'Others'));
END
$$;

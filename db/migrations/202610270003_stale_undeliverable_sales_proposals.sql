-- A source revision can invalidate a proposal between creation and Telegram
-- delivery. Such a proposal is no longer actionable and must not remain in the
-- pending count after its delivery intent has been cancelled.
UPDATE outreach_sales_proposals proposal
SET state='stale'
WHERE proposal.state='pending'
  AND EXISTS (
    SELECT 1 FROM outreach_control_outbox outbox
    WHERE outbox.proposal_id=proposal.id AND outbox.state='cancelled'
  );

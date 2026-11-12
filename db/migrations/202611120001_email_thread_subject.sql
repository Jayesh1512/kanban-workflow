-- The chat title of an email thread is now its counterparty (the card name, as for a Telegram
-- direct chat); the subject is kept here so intake approvals still show what the mail is about.
-- Additive and nullable: existing threads keep their subject-as-title and show it unchanged.
ALTER TABLE email_threads ADD COLUMN subject text;

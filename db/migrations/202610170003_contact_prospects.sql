ALTER TABLE tickets ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE tickets ADD COLUMN kind text NOT NULL DEFAULT 'company';
ALTER TABLE tickets ADD CONSTRAINT tickets_kind_company_check CHECK (
  (kind = 'company' AND company_id IS NOT NULL) OR
  (kind = 'contact_prospect' AND company_id IS NULL)
);

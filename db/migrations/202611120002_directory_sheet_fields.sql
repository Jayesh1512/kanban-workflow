-- Directory fields from the "Antseed - Hitlist" sheet. Additive and nullable: existing rows are untouched.
-- Sheet column -> here: company->canonical_name, website->domains, description->summary (all already exist).
-- Funding/employees/location live inside the sheet's enriched_company_record_json; promoted to real columns.
-- Funding stays text ("$4.5M", "$500K"): the sheet has no normalised number. ponytail: add funding_usd numeric if we need to sort/filter on it.
ALTER TABLE companies
  ADD COLUMN source text,              -- verbatim sheet value, e.g. openrouter_apps, near_ecosystem_research; deliberately no CHECK
  ADD COLUMN source_url text,
  ADD COLUMN listing_url text,
  ADD COLUMN category text,
  ADD COLUMN funding text,
  ADD COLUMN employees text,           -- sheet mixes "9", "13-15", "7"
  ADD COLUMN location text,
  ADD COLUMN status text,              -- sheet: collected | candidate
  ADD COLUMN evidence_level text,
  ADD COLUMN usage_metric text,
  ADD COLUMN outreach_tier text,       -- adjusted_outreach_tier, e.g. "A — target now"
  ADD COLUMN outreach_score integer,   -- adjusted_outreach_score
  ADD COLUMN customer_potential_score integer,
  ADD COLUMN insights text,            -- "Company insights & Antseed target points"
  ADD COLUMN notes text,
  ADD COLUMN retrieved_at timestamptz;
CREATE INDEX companies_source_idx ON companies (source);

-- A contact belongs to at most one company here. Nullable: our own team and company-less contacts have none.
-- contact_company_roles stays as the many-to-many history; this is the directory's primary company.
ALTER TABLE contacts
  ADD COLUMN company_id uuid REFERENCES companies(id),
  ADD COLUMN title text,               -- from founder_or_team, e.g. "Co-Founder & CTO"
  ADD COLUMN linkedin text,
  ADD COLUMN x_account text,
  ADD COLUMN telegram text,
  ADD COLUMN discord text,
  ADD COLUMN contact_type text,
  ADD COLUMN contact_confidence text,
  ADD COLUMN notes text;
CREATE INDEX contacts_company_id_idx ON contacts (company_id);

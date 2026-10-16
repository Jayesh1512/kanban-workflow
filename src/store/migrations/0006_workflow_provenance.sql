ALTER TABLE workflow_field_source ADD COLUMN source_unknown INTEGER NOT NULL DEFAULT 0 CHECK (source_unknown IN (0,1));

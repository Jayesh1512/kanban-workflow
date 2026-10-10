-- Strengthen the existing exact-erasure contract without changing either frozen migration.
CREATE TRIGGER action_log_redaction_shape BEFORE UPDATE ON action_log
  WHEN NOT (NEW.before IS NULL AND NEW.after IS NULL AND NEW.reason = '' AND NEW.message_ids = '[]'
            AND NEW.decision_id IS OLD.decision_id AND NEW.corrects_id IS OLD.corrects_id
            AND NEW.follows_human_override = OLD.follows_human_override)
  BEGIN SELECT RAISE(ABORT, 'action_log redaction must erase content'); END;

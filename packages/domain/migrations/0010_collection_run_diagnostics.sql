ALTER TABLE collection_runs
  ADD COLUMN error_code VARCHAR(100) NULL AFTER stop_reason,
  ADD COLUMN error_message TEXT NULL AFTER error_code;

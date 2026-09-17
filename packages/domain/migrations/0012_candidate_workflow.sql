ALTER TABLE outreach_records
  ADD COLUMN next_action VARCHAR(500) NULL AFTER next_follow_up_at;

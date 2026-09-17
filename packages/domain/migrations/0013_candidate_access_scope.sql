ALTER TABLE outreach_records
  ADD COLUMN owner_assigned_at TIMESTAMP(3) NULL AFTER owner_user_id;

-- statement-breakpoint
UPDATE outreach_records
SET owner_assigned_at = created_at
WHERE owner_user_id IS NOT NULL AND owner_assigned_at IS NULL;

-- statement-breakpoint
ALTER TABLE outreach_records
  ADD KEY idx_outreach_records_owner_assigned
    (workspace_id, owner_user_id, owner_assigned_at, candidate_id);

-- statement-breakpoint
ALTER TABLE run_creator_sources
  ADD KEY idx_run_creator_sources_creator_device_first
    (workspace_id, creator_id, device_id, first_observed_at);

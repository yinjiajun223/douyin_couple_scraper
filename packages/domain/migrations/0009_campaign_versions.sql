ALTER TABLE campaign_templates
  ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 1 AFTER is_system,
  ADD CONSTRAINT chk_campaign_templates_version CHECK (version > 0);

-- statement-breakpoint
ALTER TABLE campaigns
  ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 1 AFTER status,
  ADD CONSTRAINT chk_campaigns_version CHECK (version > 0);

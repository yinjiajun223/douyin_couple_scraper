CREATE TABLE campaign_templates (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT NULL,
  rule_schema_version INT UNSIGNED NOT NULL,
  rules_json JSON NOT NULL,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at TIMESTAMP(3) NULL,
  created_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_campaign_templates_workspace_name (workspace_id, name),
  UNIQUE KEY uq_campaign_templates_workspace_id (workspace_id, id),
  KEY idx_campaign_templates_active (workspace_id, archived_at, updated_at DESC),
  CONSTRAINT fk_campaign_templates_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_campaign_templates_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
CREATE TABLE campaigns (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_template_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  name VARCHAR(200) NOT NULL,
  recommendation_profile_description TEXT NULL,
  rule_schema_version INT UNSIGNED NOT NULL,
  rules_json JSON NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  archived_at TIMESTAMP(3) NULL,
  created_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_campaigns_workspace_id (workspace_id, id),
  KEY idx_campaigns_workspace_status (workspace_id, status, updated_at DESC),
  KEY idx_campaigns_source_template (workspace_id, source_template_id),
  CONSTRAINT fk_campaigns_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_campaigns_template FOREIGN KEY (workspace_id, source_template_id) REFERENCES campaign_templates (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_campaigns_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_campaigns_status CHECK (status IN ('active', 'archived'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
CREATE TABLE campaign_rule_versions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  campaign_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version INT UNSIGNED NOT NULL,
  rule_schema_version INT UNSIGNED NOT NULL,
  rules_json JSON NOT NULL,
  created_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_campaign_rule_versions_number (campaign_id, version),
  UNIQUE KEY uq_campaign_rule_versions_workspace_id (workspace_id, id),
  UNIQUE KEY uq_campaign_rule_versions_campaign_id (campaign_id, id),
  CONSTRAINT fk_campaign_rule_versions_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_campaign_rule_versions_campaign FOREIGN KEY (workspace_id, campaign_id) REFERENCES campaigns (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_campaign_rule_versions_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
CREATE TRIGGER campaign_rule_versions_no_update
BEFORE UPDATE ON campaign_rule_versions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'campaign rule versions are immutable';

-- statement-breakpoint
CREATE TRIGGER campaign_rule_versions_no_delete
BEFORE DELETE ON campaign_rule_versions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'campaign rule versions are immutable';

-- statement-breakpoint
CREATE TABLE collection_runs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  campaign_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  rule_version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ready',
  stop_reason VARCHAR(100) NULL,
  progress_json JSON NOT NULL,
  created_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  claimed_at TIMESTAMP(3) NULL,
  started_at TIMESTAMP(3) NULL,
  ended_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_collection_runs_workspace_id (workspace_id, id),
  KEY idx_collection_runs_campaign_created (campaign_id, created_at DESC),
  KEY idx_collection_runs_ready (workspace_id, status, created_at),
  CONSTRAINT fk_collection_runs_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_collection_runs_campaign FOREIGN KEY (workspace_id, campaign_id) REFERENCES campaigns (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_collection_runs_rule_version FOREIGN KEY (campaign_id, rule_version_id) REFERENCES campaign_rule_versions (campaign_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_collection_runs_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_collection_runs_status CHECK (status IN ('ready', 'claimed', 'running', 'paused', 'completed', 'failed', 'terminated'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
CREATE TABLE run_devices (
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  claimed_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at TIMESTAMP(3) NULL,
  completed_at TIMESTAMP(3) NULL,
  PRIMARY KEY (run_id, device_id),
  KEY idx_run_devices_device (device_id, claimed_at DESC),
  CONSTRAINT fk_run_devices_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_run_devices_run FOREIGN KEY (workspace_id, run_id) REFERENCES collection_runs (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_run_devices_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

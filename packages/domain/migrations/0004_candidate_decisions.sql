CREATE TABLE campaign_candidates (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  campaign_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  creator_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  latest_run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  latest_creator_observation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  assignee_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  hard_filter_status VARCHAR(20) NOT NULL DEFAULT 'unknown',
  pipeline_status VARCHAR(30) NOT NULL DEFAULT 'pending_review',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  archived_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_campaign_candidates_campaign_creator (campaign_id, creator_id),
  UNIQUE KEY uq_campaign_candidates_workspace_id (workspace_id, id),
  KEY idx_campaign_candidates_filter (workspace_id, campaign_id, pipeline_status, assignee_user_id, updated_at DESC),
  KEY idx_campaign_candidates_creator (workspace_id, creator_id, updated_at DESC),
  CONSTRAINT fk_campaign_candidates_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_campaign_candidates_campaign FOREIGN KEY (workspace_id, campaign_id) REFERENCES campaigns (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_campaign_candidates_creator FOREIGN KEY (workspace_id, creator_id) REFERENCES creators (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_campaign_candidates_run FOREIGN KEY (workspace_id, latest_run_id) REFERENCES collection_runs (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_campaign_candidates_observation FOREIGN KEY (workspace_id, latest_creator_observation_id) REFERENCES creator_observations (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_campaign_candidates_assignee FOREIGN KEY (assignee_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_campaign_candidates_hard_filter CHECK (hard_filter_status IN ('pass', 'fail', 'unknown')),
  CONSTRAINT chk_campaign_candidates_pipeline CHECK (pipeline_status IN ('pending_review', 'unsuitable', 'to_contact', 'contacted', 'communicating', 'partnered', 'declined')),
  CONSTRAINT chk_campaign_candidates_version CHECK (version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
CREATE TABLE rule_evaluations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  candidate_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  rule_version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  creator_observation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  matched_post_observation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  rule_key VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  rule_category VARCHAR(20) NOT NULL,
  outcome VARCHAR(20) NOT NULL,
  evidence_json JSON NOT NULL,
  evaluated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_rule_evaluations_fact (candidate_id, run_id, rule_key, creator_observation_id),
  KEY idx_rule_evaluations_candidate (candidate_id, evaluated_at),
  CONSTRAINT fk_rule_evaluations_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_rule_evaluations_candidate FOREIGN KEY (workspace_id, candidate_id) REFERENCES campaign_candidates (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_rule_evaluations_run FOREIGN KEY (workspace_id, run_id) REFERENCES collection_runs (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_rule_evaluations_rule_version FOREIGN KEY (workspace_id, rule_version_id) REFERENCES campaign_rule_versions (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_rule_evaluations_creator_observation FOREIGN KEY (workspace_id, creator_observation_id) REFERENCES creator_observations (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_rule_evaluations_post_observation FOREIGN KEY (workspace_id, matched_post_observation_id) REFERENCES post_observations (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_rule_evaluations_category CHECK (rule_category IN ('hard', 'ai', 'manual')),
  CONSTRAINT chk_rule_evaluations_outcome CHECK (outcome IN ('pass', 'fail', 'unknown'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
CREATE TABLE ai_analysis_runs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  candidate_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  connection_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  provider_label VARCHAR(200) NULL,
  model VARCHAR(200) NULL,
  prompt_version VARCHAR(100) NOT NULL,
  result_schema_version INT UNSIGNED NOT NULL,
  input_evidence_json JSON NOT NULL,
  normalized_result_json JSON NULL,
  raw_response_metadata_json JSON NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'queued',
  error_code VARCHAR(100) NULL,
  error_message TEXT NULL,
  started_at TIMESTAMP(3) NULL,
  completed_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_analysis_runs_workspace_id (workspace_id, id),
  KEY idx_ai_analysis_runs_candidate (candidate_id, created_at DESC),
  CONSTRAINT fk_ai_analysis_runs_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ai_analysis_runs_candidate FOREIGN KEY (workspace_id, candidate_id) REFERENCES campaign_candidates (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_ai_analysis_runs_status CHECK (status IN ('queued', 'running', 'succeeded', 'unavailable', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
CREATE TABLE manual_reviews (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  candidate_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reviewer_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  decision VARCHAR(20) NOT NULL,
  reason TEXT NULL,
  based_on_candidate_version INT UNSIGNED NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_manual_reviews_candidate (candidate_id, created_at DESC),
  CONSTRAINT fk_manual_reviews_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_manual_reviews_candidate FOREIGN KEY (workspace_id, candidate_id) REFERENCES campaign_candidates (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_manual_reviews_reviewer FOREIGN KEY (reviewer_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_manual_reviews_decision CHECK (decision IN ('pending', 'approved', 'rejected')),
  CONSTRAINT chk_manual_reviews_version CHECK (based_on_candidate_version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
CREATE TABLE outreach_records (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  candidate_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  contact_channel VARCHAR(50) NULL,
  contact_value VARCHAR(500) NULL,
  quoted_amount DECIMAL(12,2) NULL,
  currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NULL,
  next_follow_up_at TIMESTAMP(3) NULL,
  cooperation_notes TEXT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_outreach_records_candidate (candidate_id),
  UNIQUE KEY uq_outreach_records_workspace_id (workspace_id, id),
  KEY idx_outreach_records_follow_up (workspace_id, owner_user_id, next_follow_up_at),
  CONSTRAINT fk_outreach_records_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_outreach_records_candidate FOREIGN KEY (workspace_id, candidate_id) REFERENCES campaign_candidates (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_outreach_records_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_outreach_records_amount CHECK (quoted_amount IS NULL OR quoted_amount >= 0),
  CONSTRAINT chk_outreach_records_version CHECK (version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
CREATE TABLE candidate_notes (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  candidate_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  author_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_candidate_notes_candidate (candidate_id, created_at DESC),
  CONSTRAINT fk_candidate_notes_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_candidate_notes_candidate FOREIGN KEY (workspace_id, candidate_id) REFERENCES campaign_candidates (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_candidate_notes_author FOREIGN KEY (author_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_candidate_notes_body CHECK (CHAR_LENGTH(body) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
CREATE TABLE candidate_events (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  candidate_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  event_type VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  previous_status VARCHAR(30) NULL,
  next_status VARCHAR(30) NULL,
  changed_fields_json JSON NOT NULL,
  note TEXT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_candidate_events_candidate (candidate_id, created_at DESC),
  CONSTRAINT fk_candidate_events_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_candidate_events_candidate FOREIGN KEY (workspace_id, candidate_id) REFERENCES campaign_candidates (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_candidate_events_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
CREATE TRIGGER candidate_events_no_update
BEFORE UPDATE ON candidate_events
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'candidate events are append-only';

-- statement-breakpoint
CREATE TRIGGER candidate_events_no_delete
BEFORE DELETE ON candidate_events
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'candidate events are append-only';

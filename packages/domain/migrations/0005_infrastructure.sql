CREATE TABLE ai_connections (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  label VARCHAR(200) NOT NULL,
  adapter_type VARCHAR(50) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  base_url VARCHAR(2048) NOT NULL,
  model VARCHAR(200) NOT NULL,
  capabilities_json JSON NOT NULL,
  limits_json JSON NOT NULL,
  credential_ciphertext VARBINARY(4096) NOT NULL,
  credential_iv BINARY(12) NOT NULL,
  credential_auth_tag BINARY(16) NOT NULL,
  credential_key_version INT UNSIGNED NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'disabled',
  last_tested_at TIMESTAMP(3) NULL,
  last_test_result_json JSON NULL,
  created_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_connections_workspace_label (workspace_id, label),
  UNIQUE KEY uq_ai_connections_workspace_id (workspace_id, id),
  KEY idx_ai_connections_status (workspace_id, status),
  CONSTRAINT fk_ai_connections_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ai_connections_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_ai_connections_adapter CHECK (adapter_type IN ('openai-compatible')),
  CONSTRAINT chk_ai_connections_status CHECK (status IN ('disabled', 'testing', 'enabled', 'failed')),
  CONSTRAINT chk_ai_connections_key_version CHECK (credential_key_version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
ALTER TABLE ai_analysis_runs
  ADD CONSTRAINT fk_ai_analysis_runs_connection FOREIGN KEY (workspace_id, connection_id) REFERENCES ai_connections (workspace_id, id) ON DELETE RESTRICT;

-- statement-breakpoint
CREATE TABLE background_jobs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  job_type VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  deduplication_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  payload_json JSON NOT NULL,
  result_json JSON NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ready',
  priority SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  run_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lease_owner VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at TIMESTAMP(3) NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 5,
  last_error_code VARCHAR(100) NULL,
  last_error_message TEXT NULL,
  completed_at TIMESTAMP(3) NULL,
  dead_lettered_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_background_jobs_deduplication (workspace_id, job_type, deduplication_key),
  KEY idx_background_jobs_claim (status, run_at, priority, lease_expires_at, id),
  KEY idx_background_jobs_workspace_status (workspace_id, status, updated_at DESC),
  CONSTRAINT fk_background_jobs_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT chk_background_jobs_status CHECK (status IN ('ready', 'leased', 'succeeded', 'retry', 'failed', 'dead')),
  CONSTRAINT chk_background_jobs_attempts CHECK (attempt_count <= max_attempts),
  CONSTRAINT chk_background_jobs_max_attempts CHECK (max_attempts > 0),
  CONSTRAINT chk_background_jobs_lease CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
CREATE TABLE ingestion_keys (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_checksum_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'processing',
  acknowledgement_json JSON NULL,
  started_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at TIMESTAMP(3) NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ingestion_keys_device_key (workspace_id, device_id, idempotency_key),
  KEY idx_ingestion_keys_expiry (status, expires_at),
  KEY idx_ingestion_keys_run (workspace_id, run_id, started_at),
  CONSTRAINT fk_ingestion_keys_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ingestion_keys_device FOREIGN KEY (workspace_id, device_id) REFERENCES devices (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_ingestion_keys_run FOREIGN KEY (workspace_id, run_id) REFERENCES collection_runs (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_ingestion_keys_status CHECK (status IN ('processing', 'completed', 'failed')),
  CONSTRAINT chk_ingestion_keys_ack CHECK (status <> 'completed' OR (acknowledgement_json IS NOT NULL AND completed_at IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE devices
  ADD UNIQUE KEY uq_devices_workspace_id (workspace_id, id);

-- statement-breakpoint
ALTER TABLE run_devices
  DROP FOREIGN KEY fk_run_devices_device,
  ADD CONSTRAINT fk_run_devices_workspace_device FOREIGN KEY (workspace_id, device_id) REFERENCES devices (workspace_id, id) ON DELETE RESTRICT;

-- statement-breakpoint
CREATE TABLE creators (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  platform VARCHAR(30) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  platform_creator_id VARCHAR(200) NOT NULL,
  canonical_profile_url VARCHAR(2048) NULL,
  first_observed_at TIMESTAMP(3) NOT NULL,
  last_observed_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_creators_platform_object (workspace_id, platform, platform_creator_id),
  UNIQUE KEY uq_creators_workspace_id (workspace_id, id),
  KEY idx_creators_recent (workspace_id, last_observed_at DESC),
  CONSTRAINT fk_creators_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT chk_creators_platform CHECK (platform IN ('douyin'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
CREATE TABLE creator_observations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  creator_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nickname VARCHAR(200) NOT NULL,
  biography TEXT NULL,
  follower_count BIGINT UNSIGNED NULL,
  follower_count_raw VARCHAR(100) NULL,
  profile_url VARCHAR(2048) NOT NULL,
  parser_confidence DECIMAL(5,4) NOT NULL,
  collector_version VARCHAR(50) NOT NULL,
  parser_version VARCHAR(50) NOT NULL,
  observed_at TIMESTAMP(3) NOT NULL,
  received_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_creator_observations_workspace_id (workspace_id, id),
  KEY idx_creator_observations_history (creator_id, observed_at DESC),
  KEY idx_creator_observations_run (run_id, observed_at),
  CONSTRAINT fk_creator_observations_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_creator_observations_creator FOREIGN KEY (workspace_id, creator_id) REFERENCES creators (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_creator_observations_run FOREIGN KEY (workspace_id, run_id) REFERENCES collection_runs (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_creator_observations_device FOREIGN KEY (workspace_id, device_id) REFERENCES devices (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_creator_observations_confidence CHECK (parser_confidence >= 0 AND parser_confidence <= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
CREATE TRIGGER creator_observations_no_update
BEFORE UPDATE ON creator_observations
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'creator observations are append-only';

-- statement-breakpoint
CREATE TRIGGER creator_observations_no_delete
BEFORE DELETE ON creator_observations
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'creator observations are append-only';

-- statement-breakpoint
CREATE TABLE run_creator_sources (
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  creator_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  first_observation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  first_observed_at TIMESTAMP(3) NOT NULL,
  last_observed_at TIMESTAMP(3) NOT NULL,
  observation_count INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (run_id, creator_id, device_id),
  KEY idx_run_creator_sources_creator (workspace_id, creator_id, last_observed_at DESC),
  CONSTRAINT fk_run_creator_sources_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_run_creator_sources_run FOREIGN KEY (workspace_id, run_id) REFERENCES collection_runs (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_run_creator_sources_creator FOREIGN KEY (workspace_id, creator_id) REFERENCES creators (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_run_creator_sources_device FOREIGN KEY (workspace_id, device_id) REFERENCES devices (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_run_creator_sources_observation FOREIGN KEY (workspace_id, first_observation_id) REFERENCES creator_observations (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_run_creator_sources_observation_count CHECK (observation_count > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
CREATE TABLE posts (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  creator_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  platform VARCHAR(30) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  platform_post_id VARCHAR(200) NOT NULL,
  canonical_post_url VARCHAR(2048) NOT NULL,
  first_observed_at TIMESTAMP(3) NOT NULL,
  last_observed_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_posts_platform_object (workspace_id, platform, platform_post_id),
  UNIQUE KEY uq_posts_workspace_id (workspace_id, id),
  KEY idx_posts_creator_recent (creator_id, last_observed_at DESC),
  CONSTRAINT fk_posts_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_posts_creator FOREIGN KEY (workspace_id, creator_id) REFERENCES creators (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_posts_platform CHECK (platform IN ('douyin'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
CREATE TABLE post_observations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  post_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  creator_observation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  caption TEXT NULL,
  like_count BIGINT UNSIGNED NULL,
  like_count_raw VARCHAR(100) NULL,
  published_at TIMESTAMP(3) NULL,
  observed_at TIMESTAMP(3) NOT NULL,
  received_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_post_observations_workspace_id (workspace_id, id),
  KEY idx_post_observations_history (post_id, observed_at DESC),
  KEY idx_post_observations_run (run_id, observed_at),
  KEY idx_post_observations_viral (workspace_id, like_count, published_at),
  CONSTRAINT fk_post_observations_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_post_observations_post FOREIGN KEY (workspace_id, post_id) REFERENCES posts (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_post_observations_creator_observation FOREIGN KEY (workspace_id, creator_observation_id) REFERENCES creator_observations (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_post_observations_run FOREIGN KEY (workspace_id, run_id) REFERENCES collection_runs (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_post_observations_device FOREIGN KEY (workspace_id, device_id) REFERENCES devices (workspace_id, id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
CREATE TRIGGER post_observations_no_update
BEFORE UPDATE ON post_observations
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'post observations are append-only';

-- statement-breakpoint
CREATE TRIGGER post_observations_no_delete
BEFORE DELETE ON post_observations
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'post observations are append-only';

-- statement-breakpoint
CREATE TABLE media_objects (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  creator_observation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  post_observation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  object_key VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  purpose VARCHAR(30) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  byte_size BIGINT UNSIGNED NULL,
  checksum_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMP(3) NULL,
  confirmed_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_media_objects_key (object_key),
  KEY idx_media_objects_workspace_status (workspace_id, status, created_at),
  KEY idx_media_objects_creator_observation (creator_observation_id),
  KEY idx_media_objects_post_observation (post_observation_id),
  CONSTRAINT fk_media_objects_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_media_objects_creator_observation FOREIGN KEY (workspace_id, creator_observation_id) REFERENCES creator_observations (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_media_objects_post_observation FOREIGN KEY (workspace_id, post_observation_id) REFERENCES post_observations (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_media_objects_purpose CHECK (purpose IN ('profile_screenshot', 'post_screenshot', 'diagnostic')),
  CONSTRAINT chk_media_objects_status CHECK (status IN ('pending', 'confirmed', 'expired', 'deleted')),
  CONSTRAINT chk_media_objects_evidence CHECK (creator_observation_id IS NOT NULL OR post_observation_id IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

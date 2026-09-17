CREATE TABLE tags (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_tags_workspace_name (workspace_id, name),
  UNIQUE KEY uq_tags_workspace_id (workspace_id, id),
  CONSTRAINT fk_tags_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- statement-breakpoint
CREATE TABLE candidate_tags (
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  candidate_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tag_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (candidate_id, tag_id),
  KEY idx_candidate_tags_tag (workspace_id, tag_id, candidate_id),
  CONSTRAINT fk_candidate_tags_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT fk_candidate_tags_candidate FOREIGN KEY (workspace_id, candidate_id) REFERENCES campaign_candidates (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_candidate_tags_tag FOREIGN KEY (workspace_id, tag_id) REFERENCES tags (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_candidate_tags_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

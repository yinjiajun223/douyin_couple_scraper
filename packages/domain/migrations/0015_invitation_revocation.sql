ALTER TABLE invitations
  ADD COLUMN revoked_at TIMESTAMP(3) NULL AFTER accepted_at;

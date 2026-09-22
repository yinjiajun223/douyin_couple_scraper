ALTER TABLE media_objects
  ADD KEY idx_media_objects_status_confirmed (status, confirmed_at);

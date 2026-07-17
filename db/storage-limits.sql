-- ============================================================================
-- Storage bucket MIME + size limits (enforced by Supabase Storage on upload).
-- ----------------------------------------------------------------------------
-- Signed upload URLs can't carry per-request content-type/size constraints, so
-- the actual bytes a client PUTs are only bounded by the bucket configuration.
-- These make the declared DTO limits real at the storage layer.
--
-- Apply via Supabase Dashboard -> SQL Editor (or set the same values in
-- Dashboard -> Storage -> <bucket> -> Settings). Review before running in prod.
-- ============================================================================

-- Feedback screenshots: images only, <= 5MB (matches ScreenshotUploadUrlDto).
update storage.buckets
   set file_size_limit = 5242880,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
 where id = 'feedback-screenshots';

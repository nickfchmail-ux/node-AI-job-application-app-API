-- Migration: add user_id to jobs table
-- Run this once in the Supabase SQL Editor

-- 1. Add the column (nullable so existing rows aren't broken)
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2. Drop the old unique constraint and replace with one that includes user_id
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_url_scraped_date_key;
ALTER TABLE jobs ADD CONSTRAINT jobs_url_scraped_date_user_id_key
  UNIQUE (url, scraped_date, user_id);

-- 3. Optional index for fast per-user queries
CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs (user_id);

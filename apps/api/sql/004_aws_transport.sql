ALTER TABLE jobs ADD COLUMN dispatched_at TIMESTAMPTZ;
CREATE INDEX jobs_undispatched_idx ON jobs(run_at, created_at)
  WHERE status = 'PENDING' AND dispatched_at IS NULL;

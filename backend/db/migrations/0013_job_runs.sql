-- When each job of the tick last finished. A daily or weekly job checks this, so it runs once however
-- the ticks fall, and a failed run leaves it alone to go again on the next tick.
CREATE TABLE job_runs (
  name         text PRIMARY KEY,
  last_run_at  timestamptz NOT NULL
);

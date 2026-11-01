-- When a send run claimed this row. Set while it is with the provider, so a second run leaves it alone.
ALTER TABLE notifications ADD COLUMN sending_at timestamptz;

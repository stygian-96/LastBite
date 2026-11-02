-- Why an admin asked for changes, shown to the vendor as a fix until they submit again.
ALTER TABLE outlets ADD COLUMN changes_reason text;

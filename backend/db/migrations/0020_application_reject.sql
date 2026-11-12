-- An admin can turn an application down for good, with a reason the vendor sees.
ALTER TABLE outlets DROP CONSTRAINT outlets_status_check;
ALTER TABLE outlets ADD CONSTRAINT outlets_status_check
  CHECK (status = ANY (ARRAY['draft', 'in_review', 'changes_needed', 'live', 'suspended', 'closed', 'rejected']));
ALTER TABLE outlets ADD COLUMN rejection_reason text;

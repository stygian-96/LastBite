-- A super admin is an admin who can make and remove other admins. The first one is made by
-- `npm run admin:super`; no route can make one.
ALTER TABLE users ADD COLUMN is_super_admin boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD CONSTRAINT users_super_admin_check CHECK (NOT is_super_admin OR is_admin);

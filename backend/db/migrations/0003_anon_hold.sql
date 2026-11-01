-- One active hold per anon ID, enforced by the database so parallel requests cannot both pass.
CREATE UNIQUE INDEX one_hold_per_anon
  ON orders (anon_id)
  WHERE status = 'held' AND user_id IS NULL;

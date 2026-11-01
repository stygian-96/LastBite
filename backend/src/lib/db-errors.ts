/**
 * True when e is Postgres rejecting a write on a unique constraint, or on the named one if given.
 * Drizzle wraps driver errors, putting the Postgres error in `cause`.
 */
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { cause?: unknown } | null;
  const pg = (err?.cause ?? err) as { code?: string; constraint?: string } | null;
  return pg?.code === '23505' && (constraint === undefined || pg.constraint === constraint);
}

import type { Tx } from '../db/client.js';
import { auditLog } from '../db/schema.js';

/** Appends an audit row inside the caller's transaction. */
export async function audit(
  tx: Tx,
  e: { actorId: string | null; action: string; entity: string; entityId: string; detail?: object },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorId: e.actorId,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId,
    detail: e.detail ?? null,
  });
}

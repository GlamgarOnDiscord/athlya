/**
 * Fire-and-forget helper that pushes a capacity update to the
 * ClassCapacityDO for a given class.
 *
 * Silently no-ops when the `CLASS_CAPACITY_DO` binding is absent
 * (e.g. local dev without a DO configured) so the booking/cancel
 * flow degrades gracefully.
 *
 * Usage:
 *   c.executionCtx?.waitUntil(notifyCapacityChange(c.env, classId, remaining));
 *
 * CN.8.1 — Sprint 8 (real-time capacity).
 */

import type { AthlyaBindings } from '../types.js';

export async function notifyCapacityChange(
  env: AthlyaBindings,
  classId: string,
  remaining: number,
): Promise<void> {
  if (!env.CLASS_CAPACITY_DO) return;
  const id = env.CLASS_CAPACITY_DO.idFromName(classId);
  const stub = env.CLASS_CAPACITY_DO.get(id);
  await stub
    .fetch('https://do-internal/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classId, remaining }),
    })
    .catch(() => {});
}

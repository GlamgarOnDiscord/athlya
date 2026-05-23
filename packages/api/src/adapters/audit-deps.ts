import type { AuditDeps } from '../routes/audit.js';
import type { AthlyaBindings } from '../types.js';

export function buildAuditDeps(_env: AthlyaBindings): AuditDeps {
  return {
    listAuditLog: () => {
      throw new Error('buildAuditDeps: listAuditLog not yet implemented');
    },
  };
}

/**
 * Who may sign in to the studio console: the staff roles (admin, manager,
 * front desk, coach), from the capability matrix of `@athlya/shared/roles`.
 *
 * A UX gate only. The API stays the authority: every endpoint checks the
 * capability itself (`requireCapability(...)`), so a role that reaches a
 * page it may not open still gets a 403 from the gateway.
 */
import { can, type Role } from '@athlya/shared/roles';

/** Whether `role` may use the console; a member uses the member app instead. */
export function canUseStudio(role: Role): boolean {
  return can(role, 'console.access');
}

/**
 * Who may sign in to the studio console: administrators and coaches.
 *
 * A UX gate only. The API stays the authority: every endpoint checks the
 * role itself (`requireRole(...)`), so a coach who reaches an admin page
 * still gets a 403 from the gateway.
 */
import type { LoginResponse } from './AuthContext';

type StudioRole = LoginResponse['user']['role'];

/** Whether `role` may use the console; a member uses the member app instead. */
export function canUseStudio(role: StudioRole): boolean {
  return role === 'admin' || role === 'coach';
}

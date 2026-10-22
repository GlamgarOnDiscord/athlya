/**
 * Studio roles and the capability matrix (issue #756).
 *
 * One table decides what each role may do. The API gateway enforces it
 * (`requireCapability(...)`), the studio console reads it to gate its
 * routes and its navigation, and the RLS policies of migration 0052
 * mirror it in SQL (`app_is_manager()`, `app_is_staff()`). A change
 * here without the matching policy change is caught by the pgTAP suite.
 *
 *   - `admin`   owns the studio: everything, including billing, branding,
 *               the team, the studio settings and the webhooks.
 *   - `manager` runs the studio day to day: everything an admin does but
 *               billing, branding, changes to the team, the studio
 *               settings and the webhooks.
 *   - `accueil` works the front desk: the check-in kiosk, the attendance
 *               of every class, the members directory and member files
 *               read only, and the planning read only.
 *   - `coach`   teaches: the kiosk, the attendance of their own classes,
 *               the members directory read only and their schedule.
 *   - `member`  uses the member app only.
 */

/** Every role, in the order of the `user_role` PostgreSQL enum. */
export const ROLES = ['member', 'coach', 'admin', 'manager', 'accueil'] as const;

export type Role = (typeof ROLES)[number];

/** Roles that sign in to the studio console. */
export const STAFF_ROLES = [
  'admin',
  'manager',
  'accueil',
  'coach',
] as const satisfies readonly Role[];

export type StaffRole = (typeof STAFF_ROLES)[number];

/** Roles an admin may grant from the Team page. */
export const ASSIGNABLE_ROLES = STAFF_ROLES;

export type Capability =
  /** Sign in to the studio console. */
  | 'console.access'
  /** Create, edit and delete classes. */
  | 'classes.write'
  /** Read the whole planning of the studio. */
  | 'planning.read'
  /** Create, edit and archive training programs; read drafts. */
  | 'programs.write'
  /** Read draft and archived programs. */
  | 'programs.readDrafts'
  /** List the members of the studio. */
  | 'members.list'
  /** Open a member file. */
  | 'members.file'
  /** Download the member list as CSV. */
  | 'members.export'
  /** Read and stamp the roster of any class of the studio. */
  | 'roster.all'
  /** Read and stamp the roster of the classes the caller coaches. */
  | 'roster.own'
  /** Use the QR check-in kiosk. */
  | 'checkin.kiosk'
  /** Read the audit log. */
  | 'audit.read'
  /** See the team and its pending invitations. */
  | 'team.read'
  /** Invite, change the role of and remove team members. */
  | 'team.manage'
  /** Plans, checkout and invoices. */
  | 'billing.manage'
  /** Studio name, colour and logo. */
  | 'branding.manage'
  /** Studio settings: name, time zone, address and contact email. */
  | 'settings.manage'
  /** Webhook endpoints, their signing secrets and deliveries. */
  | 'webhooks.manage';

const MATRIX: Readonly<Record<Capability, readonly Role[]>> = {
  'console.access': STAFF_ROLES,
  'classes.write': ['admin', 'manager'],
  'planning.read': ['admin', 'manager', 'accueil'],
  'programs.write': ['admin', 'manager'],
  'programs.readDrafts': ['admin', 'manager', 'coach'],
  'members.list': STAFF_ROLES,
  'members.file': ['admin', 'manager', 'accueil'],
  'members.export': ['admin', 'manager'],
  'roster.all': ['admin', 'manager', 'accueil'],
  'roster.own': ['coach'],
  'checkin.kiosk': STAFF_ROLES,
  'audit.read': ['admin', 'manager'],
  'team.read': ['admin', 'manager'],
  'team.manage': ['admin'],
  'billing.manage': ['admin'],
  'branding.manage': ['admin'],
  'settings.manage': ['admin'],
  'webhooks.manage': ['admin'],
};

/** Whether `role` holds `capability`. Unknown roles hold nothing. */
export function can(role: string | null | undefined, capability: Capability): boolean {
  if (role === null || role === undefined) return false;
  return (MATRIX[capability] as readonly string[]).includes(role);
}

/** The roles that hold `capability`, for error messages and documentation. */
export function rolesWith(capability: Capability): readonly Role[] {
  return MATRIX[capability];
}

/** Narrow an arbitrary string to a {@link Role}. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Narrow an arbitrary string to a {@link StaffRole}. */
export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === 'string' && (STAFF_ROLES as readonly string[]).includes(value);
}

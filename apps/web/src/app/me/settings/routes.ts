/** Base route of the member settings area. */
export const SETTINGS_ROOT = '/me/settings';

/** Route of each settings section. */
export const SETTINGS_PATHS = {
  profile: `${SETTINGS_ROOT}/profile`,
  security: `${SETTINGS_ROOT}/security`,
  notifications: `${SETTINGS_ROOT}/notifications`,
  preferences: `${SETTINGS_ROOT}/preferences`,
  health: `${SETTINGS_ROOT}/health`,
  privacy: `${SETTINGS_ROOT}/privacy`,
} as const;

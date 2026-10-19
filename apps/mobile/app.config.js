/**
 * Wraps the static `app.json`. EAS builds must carry an explicit API
 * origin (set per profile in `eas.json`), so a misconfigured profile fails
 * the build instead of shipping an app that points at the wrong backend.
 *
 * `EXPO_PUBLIC_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER` (the Google Cloud
 * project linked to the app in Play Console) is optional: without it,
 * Android builds sign in without Play Integrity attestation. When set it
 * must be the numeric project number, not the project id.
 */
module.exports = ({ config }) => {
  if (process.env.EAS_BUILD === 'true' && !process.env.EXPO_PUBLIC_API_URL) {
    throw new Error('EXPO_PUBLIC_API_URL must be set for every EAS build profile');
  }
  const projectNumber = process.env.EXPO_PUBLIC_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER;
  if (projectNumber && !/^\d{1,20}$/.test(projectNumber.trim())) {
    throw new Error(
      'EXPO_PUBLIC_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER must be a numeric project number',
    );
  }
  return config;
};

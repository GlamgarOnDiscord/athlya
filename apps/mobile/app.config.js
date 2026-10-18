/**
 * Wraps the static `app.json`. EAS builds must carry an explicit API
 * origin (set per profile in `eas.json`), so a misconfigured profile fails
 * the build instead of shipping an app that points at the wrong backend.
 */
module.exports = ({ config }) => {
  if (process.env.EAS_BUILD === 'true' && !process.env.EXPO_PUBLIC_API_URL) {
    throw new Error('EXPO_PUBLIC_API_URL must be set for every EAS build profile');
  }
  return config;
};

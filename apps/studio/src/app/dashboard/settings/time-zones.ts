/**
 * IANA time zones offered by the settings form: the runtime's list when it
 * has one, a short European fallback otherwise, always with the current
 * value so a saved zone stays selectable.
 */
const FALLBACK = [
  'Europe/Paris',
  'Europe/Brussels',
  'Europe/Luxembourg',
  'Europe/Zurich',
  'Europe/London',
  'America/Montreal',
  'UTC',
];

export function timeZoneOptions(current: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : FALLBACK;
  const zones = new Set(supported);
  zones.add(current);
  return [...zones].sort((a, b) => a.localeCompare(b));
}

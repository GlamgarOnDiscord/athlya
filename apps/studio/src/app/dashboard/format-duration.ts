import type { Translator } from '../../lib/i18n/t';

/** "45 min", "2 h 05", "3 j": a countdown that stays short. */
export function formatDuration(minutes: number, t: Translator): string {
  if (minutes < 60) return t('studio.dashboard.duration.minutes', { m: minutes });
  if (minutes < 24 * 60) {
    return t('studio.dashboard.duration.hours', {
      h: Math.floor(minutes / 60),
      mm: String(minutes % 60).padStart(2, '0'),
    });
  }
  return t('studio.dashboard.duration.days', { d: Math.floor(minutes / (24 * 60)) });
}

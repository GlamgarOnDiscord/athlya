import { redirect } from 'next/navigation';

import { SETTINGS_PATHS } from './routes';

/** `/me/settings` opens on its first section. */
export default function SettingsIndexPage(): never {
  redirect(SETTINGS_PATHS.profile);
}

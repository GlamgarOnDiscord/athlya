import { useState } from 'react';

import { useRuntime } from '../components/RuntimeProvider';
import { SyncStatusBanner } from '../components/SyncStatusBanner';
import { AppText } from '../components/ui/AppText';
import { Button } from '../components/ui/Button';
import { Screen } from '../components/ui/Screen';

export default function HomeScreen() {
  const runtime = useRuntime();
  const [syncing, setSyncing] = useState(false);

  const syncNow = () => {
    setSyncing(true);
    runtime.sync
      .syncNow()
      .catch(() => undefined)
      .finally(() => {
        setSyncing(false);
      });
  };

  return (
    <Screen>
      <AppText variant="title">{runtime.t('mobile.home.title')}</AppText>
      <AppText variant="muted">{runtime.t('mobile.home.tagline')}</AppText>
      <SyncStatusBanner runtime={runtime} />
      <Button
        title={runtime.t('mobile.home.syncNow')}
        accessibilityHint={runtime.t('mobile.home.syncNowHint')}
        busy={syncing}
        onPress={syncNow}
      />
    </Screen>
  );
}

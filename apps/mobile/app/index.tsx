import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { SignedIn } from '../components/AppSession';
import { useRuntime } from '../components/RuntimeProvider';
import { SyncStatusBanner } from '../components/SyncStatusBanner';
import { TodayProgramCard } from '../components/TodayProgramCard';
import { AppText } from '../components/ui/AppText';
import { Button } from '../components/ui/Button';
import { ScrollScreen } from '../components/ui/ScrollScreen';

const NAVIGATION = [
  { href: '/classes', key: 'mobile.home.nav.classes' },
  { href: '/reservations', key: 'mobile.home.nav.reservations' },
  { href: '/workout', key: 'mobile.home.nav.workout' },
  { href: '/progression', key: 'mobile.home.nav.progression' },
  { href: '/checkin', key: 'mobile.home.nav.checkin' },
  { href: '/settings', key: 'mobile.home.nav.settings' },
] as const;

function Home() {
  const runtime = useRuntime();
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);

  const syncNow = () => {
    setSyncing(true);
    void runtime.sync.syncNow().finally(() => {
      setSyncing(false);
    });
  };

  return (
    <ScrollScreen>
      <AppText variant="title">{runtime.t('mobile.home.title')}</AppText>
      <AppText variant="muted">{runtime.t('mobile.home.tagline')}</AppText>
      <SyncStatusBanner runtime={runtime} />
      <TodayProgramCard />
      <View accessibilityLabel={runtime.t('mobile.home.nav.label')} className="gap-sm">
        {NAVIGATION.map((item) => (
          <Button
            key={item.href}
            title={runtime.t(item.key)}
            variant="secondary"
            onPress={() => {
              router.push(item.href);
            }}
          />
        ))}
      </View>
      <Button
        title={runtime.t('mobile.home.syncNow')}
        accessibilityHint={runtime.t('mobile.home.syncNowHint')}
        busy={syncing}
        onPress={syncNow}
      />
    </ScrollScreen>
  );
}

export default function HomeScreen() {
  return <SignedIn>{() => <Home />}</SignedIn>;
}

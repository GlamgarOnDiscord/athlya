import { Stack } from 'expo-router';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { SignedIn, usePendingMutations, useWriteDeps } from '../components/AppSession';
import { ErrorNotice } from '../components/ErrorNotice';
import { useRuntime } from '../components/RuntimeProvider';
import { AppText } from '../components/ui/AppText';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Notice } from '../components/ui/Notice';
import { ScrollScreen } from '../components/ui/ScrollScreen';
import { formatDateTime } from '../features/format';
import {
  canCancel,
  queuedCancellationIds,
  ReservationsController,
  upcomingReservations,
} from '../features/reservations/reservations-controller';

function Reservations({ userId }: { readonly userId: string }) {
  const runtime = useRuntime();
  const { t, locale } = runtime;
  const writes = useWriteDeps();
  const controller = useMemo(
    () => new ReservationsController({ api: runtime.api, writes }),
    [runtime, writes],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.get);
  const queued = queuedCancellationIds(usePendingMutations(userId));

  useEffect(() => {
    const abort = new AbortController();
    void controller.load(abort.signal);
    return () => {
      abort.abort();
    };
  }, [controller]);

  const now = new Date();
  const items = upcomingReservations(state.items, now);

  return (
    <ScrollScreen>
      <Stack.Screen options={{ headerShown: true, title: t('mobile.reservations.title') }} />
      {state.notice?.kind === 'error' ? <ErrorNotice error={state.notice.error} /> : null}
      {state.notice?.kind === 'cancelled' ? (
        <Notice message={t('mobile.reservations.cancelled')} />
      ) : null}
      {state.notice?.kind === 'queued' ? (
        <Notice message={t('mobile.reservations.queued')} />
      ) : null}
      {state.error !== null ? <ErrorNotice error={state.error} /> : null}
      {state.load === 'ready' && items.length === 0 ? (
        <AppText variant="muted">{t('mobile.reservations.empty')}</AppText>
      ) : null}
      {items.map((item) => {
        const pendingSync = queued.has(item.id);
        const status = pendingSync ? 'cancelled' : item.status;
        return (
          <Card key={item.id}>
            <AppText className="font-semibold">{item.class.title}</AppText>
            <AppText variant="muted">
              {t('mobile.classes.starts', {
                date: formatDateTime(item.class.startsAt, locale),
                duration: item.class.durationMin,
              })}
            </AppText>
            <AppText>
              {pendingSync
                ? t('mobile.reservations.pendingSync')
                : t(`mobile.reservations.status.${status}`)}
            </AppText>
            {pendingSync || (status !== 'confirmed' && status !== 'waitlist') ? null : canCancel(
                item,
                now,
              ) ? (
              <Button
                title={t('mobile.reservations.cancel')}
                accessibilityLabel={`${t('mobile.reservations.cancel')}: ${item.class.title}`}
                accessibilityHint={t('mobile.reservations.cancelHint')}
                variant="secondary"
                busy={state.cancelling.has(item.id)}
                onPress={() => {
                  void controller.cancel(item.id);
                }}
              />
            ) : (
              <AppText variant="muted">{t('mobile.reservations.cancelClosed')}</AppText>
            )}
          </Card>
        );
      })}
    </ScrollScreen>
  );
}

export default function ReservationsScreen() {
  return <SignedIn>{(userId) => <Reservations userId={userId} />}</SignedIn>;
}

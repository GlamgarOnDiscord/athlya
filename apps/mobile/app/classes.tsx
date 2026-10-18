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
import {
  ClassesController,
  queuedBookingClassIds,
  type BookingMark,
} from '../features/classes/classes-controller';
import { formatDateTime } from '../features/format';

import type { AppRuntime } from '../infrastructure/runtime';

function markLabel(t: AppRuntime['t'], mark: BookingMark): string | null {
  switch (mark.kind) {
    case 'pending':
      return null;
    case 'confirmed':
      return t('mobile.classes.confirmed');
    case 'waitlist':
      return t('mobile.classes.waitlisted', { position: mark.position });
    case 'queued':
      return t('mobile.classes.pendingSync');
  }
}

function noticeMessage(t: AppRuntime['t'], mark: BookingMark): string | null {
  return mark.kind === 'queued' ? t('mobile.classes.queued') : markLabel(t, mark);
}

function Classes({ userId }: { readonly userId: string }) {
  const runtime = useRuntime();
  const { t, locale } = runtime;
  const writes = useWriteDeps();
  const controller = useMemo(
    () => new ClassesController({ api: runtime.api, writes }),
    [runtime, writes],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.get);
  const queued = queuedBookingClassIds(usePendingMutations(userId));

  useEffect(() => {
    const abort = new AbortController();
    void controller.load(abort.signal);
    return () => {
      abort.abort();
    };
  }, [controller]);

  const bookedMessage =
    state.notice?.kind === 'booked' ? noticeMessage(t, state.notice.mark) : null;

  return (
    <ScrollScreen>
      <Stack.Screen options={{ headerShown: true, title: t('mobile.classes.title') }} />
      {state.notice?.kind === 'error' ? <ErrorNotice error={state.notice.error} /> : null}
      {bookedMessage === null ? null : <Notice message={bookedMessage} />}
      {state.error !== null ? <ErrorNotice error={state.error} /> : null}
      {state.load === 'ready' && state.items.length === 0 ? (
        <AppText variant="muted">{t('mobile.classes.empty')}</AppText>
      ) : null}
      {state.items.map((item) => {
        const mark: BookingMark | undefined =
          state.bookings[item.id] ?? (queued.has(item.id) ? { kind: 'queued' } : undefined);
        const label = mark === undefined ? null : markLabel(t, mark);
        const full = item.remaining === 0;
        return (
          <Card key={item.id}>
            <AppText className="font-semibold">{item.title}</AppText>
            <AppText variant="muted">
              {t('mobile.classes.starts', {
                date: formatDateTime(item.startsAt, locale),
                duration: item.durationMin,
              })}
            </AppText>
            <AppText>
              {full
                ? t('mobile.classes.full')
                : t('mobile.classes.remaining', { count: item.remaining })}
            </AppText>
            {label === null ? (
              <Button
                title={full ? t('mobile.classes.joinWaitlist') : t('mobile.classes.book')}
                accessibilityLabel={`${full ? t('mobile.classes.joinWaitlist') : t('mobile.classes.book')}: ${item.title}`}
                accessibilityHint={t('mobile.classes.bookHint')}
                busy={mark?.kind === 'pending'}
                onPress={() => {
                  void controller.book(item.id);
                }}
              />
            ) : (
              <AppText className="font-semibold">{label}</AppText>
            )}
          </Card>
        );
      })}
      <Button
        title={t('mobile.classes.refresh')}
        variant="secondary"
        busy={state.load === 'loading'}
        onPress={() => {
          void controller.load();
        }}
      />
    </ScrollScreen>
  );
}

export default function ClassesScreen() {
  return <SignedIn>{(userId) => <Classes userId={userId} />}</SignedIn>;
}

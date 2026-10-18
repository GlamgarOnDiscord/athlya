import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';

import { formatLocalDate } from '../features/format';
import {
  msUntilNextLocalMidnight,
  TodayProgramController,
  type Message,
  type ProgramCard,
} from '../features/programs/today-program';

import { ErrorNotice } from './ErrorNotice';
import { useRuntime } from './RuntimeProvider';
import { AppText } from './ui/AppText';
import { Button } from './ui/Button';
import { Card } from './ui/Card';

/**
 * Today's prescribed workout per program subscription (task 24.4). It is
 * fetched again whenever the home screen regains focus and at local
 * midnight, so it never shows yesterday's workout as today's.
 */
export function TodayProgramCard() {
  const runtime = useRuntime();
  const { t, locale } = runtime;
  const controller = useMemo(() => new TodayProgramController(runtime.api), [runtime]);
  const state = useSyncExternalStore(controller.subscribe, controller.get);

  useFocusEffect(
    useCallback(() => {
      const abort = new AbortController();
      void controller.load(abort.signal);
      return () => {
        abort.abort();
      };
    }, [controller]),
  );

  // Re-armed after every load, so the timer always targets the next midnight.
  useEffect(() => {
    const timer = setTimeout(
      () => {
        void controller.load();
      },
      msUntilNextLocalMidnight(new Date()) + 1_000,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [controller, state.date]);

  const render = (message: Message): string => {
    const values = { ...message.values };
    if (message.key === 'mobile.program.notStarted' && typeof values['date'] === 'string') {
      values['date'] = formatLocalDate(values['date'], locale);
    }
    return t(message.key, values);
  };

  if (state.load === 'error' && state.error !== null) {
    return (
      <View className="gap-sm">
        <AppText variant="muted">{t('mobile.program.loadError')}</AppText>
        <ErrorNotice error={state.error} />
        {state.error.authRequired ? null : (
          <Button
            title={t('common.retry')}
            variant="secondary"
            onPress={() => {
              void controller.load();
            }}
          />
        )}
      </View>
    );
  }
  if (state.cards.length === 0) return null;

  return (
    <View className="gap-sm">
      <Text
        accessibilityRole="header"
        className="text-xl font-bold text-foreground dark:text-dark-foreground"
      >
        {t('mobile.program.title')}
      </Text>
      {state.cards.map((card: ProgramCard) => (
        <Card key={card.subscriptionId}>
          <AppText className="font-semibold">{card.programTitle}</AppText>
          <AppText variant="muted">{render(card.headline)}</AppText>
          {card.workoutTitle === null ? null : <AppText>{card.workoutTitle}</AppText>}
          {card.exercises.map((exercise, index) => (
            <View key={`${String(index)}-${exercise.name}`}>
              <AppText>{`${exercise.name}: ${exercise.parts.map(render).join(', ')}`}</AppText>
              {exercise.notes === null ? null : <AppText variant="muted">{exercise.notes}</AppText>}
            </View>
          ))}
          {card.notes === null ? null : <AppText variant="muted">{card.notes}</AppText>}
        </Card>
      ))}
    </View>
  );
}

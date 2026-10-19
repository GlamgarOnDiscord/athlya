import {
  COACH_QUESTION_MAX_LENGTH,
  type CoachAdvicePartial,
  type CoachAskResponse,
} from '@athlya/shared/schemas/api';
import { Stack } from 'expo-router';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Platform, View } from 'react-native';

import { SignedIn } from '../components/AppSession';
import { ErrorNotice } from '../components/ErrorNotice';
import { useRuntime } from '../components/RuntimeProvider';
import { AppText } from '../components/ui/AppText';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Notice } from '../components/ui/Notice';
import { ScrollScreen } from '../components/ui/ScrollScreen';
import { TextField } from '../components/ui/TextField';
import { CoachController } from '../features/coach/coach-controller';

/**
 * The provisional answer is not a live region: screen readers only hear
 * the final answer, once (live region on Android, announcement on iOS).
 */
function ProvisionalAnswer({ partial }: { readonly partial: CoachAdvicePartial }) {
  const { t } = useRuntime();
  const recommendations = partial.recommendations ?? [];
  return (
    <Card>
      <AppText variant="muted">{t('coach.answer.provisional')}</AppText>
      {partial.summary !== undefined && partial.summary !== '' ? (
        <AppText variant="muted">{partial.summary}</AppText>
      ) : null}
      {recommendations.map((rec, index) => (
        <View key={index} className="gap-xs">
          {rec.title !== undefined ? <AppText variant="muted">{rec.title}</AppText> : null}
          {rec.detail !== undefined ? <AppText variant="muted">{rec.detail}</AppText> : null}
        </View>
      ))}
      {typeof partial.caution === 'string' && partial.caution !== '' ? (
        <AppText variant="muted">{partial.caution}</AppText>
      ) : null}
    </Card>
  );
}

function Answer({ answer }: { readonly answer: CoachAskResponse }) {
  const { t } = useRuntime();
  const { advice } = answer;
  return (
    <Card>
      <AppText className="text-xl font-semibold">{t('coach.answer.title')}</AppText>
      <AppText>{advice.summary}</AppText>
      <AppText className="font-semibold">{t('coach.answer.recommendations')}</AppText>
      {advice.recommendations.map((rec, index) => (
        <View key={`${String(index)}-${rec.title}`} className="gap-xs">
          <AppText className="font-semibold">{`${String(index + 1)}. ${rec.title}`}</AppText>
          <AppText variant="muted">{rec.detail}</AppText>
        </View>
      ))}
      {advice.caution !== null ? (
        <View className="gap-xs rounded-md border border-border p-sm dark:border-dark-border">
          <AppText className="font-semibold">{t('coach.answer.caution')}</AppText>
          <AppText>{advice.caution}</AppText>
        </View>
      ) : null}
      <AppText variant="muted">{t('coach.answer.disclaimer')}</AppText>
    </Card>
  );
}

function Coach() {
  const runtime = useRuntime();
  const { t, locale } = runtime;
  const controller = useMemo(() => new CoachController(runtime.api), [runtime]);
  const state = useSyncExternalStore(controller.subscribe, controller.get);
  const [question, setQuestion] = useState('');

  useEffect(() => {
    void controller.load();
    return () => {
      controller.cancel();
    };
  }, [controller]);

  const { status, ask } = state;
  const answer = ask.kind === 'done' ? ask.answer : null;

  useEffect(() => {
    if (answer !== null && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(
        `${t('coach.answer.title')}. ${answer.advice.summary}`,
      );
    }
  }, [answer, t]);

  const header = <Stack.Screen options={{ headerShown: true, title: t('coach.title') }} />;

  if (status.kind === 'loading') {
    return (
      <ScrollScreen>
        {header}
        <AppText variant="muted">{t('common.loading')}</AppText>
      </ScrollScreen>
    );
  }

  if (status.kind === 'error') {
    return (
      <ScrollScreen>
        {header}
        <ErrorNotice error={status.error} />
        {status.error.authRequired ? null : (
          <Button
            title={t('common.retry')}
            variant="secondary"
            onPress={() => {
              void controller.load();
            }}
          />
        )}
      </ScrollScreen>
    );
  }

  if (status.kind === 'disabled') {
    return (
      <ScrollScreen>
        {header}
        <AppText variant="muted">{t('coach.disabled')}</AppText>
      </ScrollScreen>
    );
  }

  const { quota, consent } = status;
  const exhausted = quota.remaining === 0;
  const pending = ask.kind === 'pending';
  const trimmed = question.trim();
  const counter =
    question.length === 1
      ? t('coach.question.counterOne', { max: COACH_QUESTION_MAX_LENGTH })
      : t('coach.question.counterOther', {
          count: question.length,
          max: COACH_QUESTION_MAX_LENGTH,
        });

  return (
    <ScrollScreen>
      {header}
      <AppText variant="muted">{t('coach.description')}</AppText>
      <AppText variant="muted">{t('coach.privacy')}</AppText>

      {consent ? (
        <>
          <TextField
            label={t('coach.question.label')}
            value={question}
            onChangeText={setQuestion}
            hint={`${t('coach.question.hint', { max: COACH_QUESTION_MAX_LENGTH })} ${counter}`}
            autoCapitalize="sentences"
            maxLength={COACH_QUESTION_MAX_LENGTH}
            multiline
          />
          <Button
            title={t('coach.submit')}
            busy={pending}
            disabled={exhausted || trimmed === ''}
            onPress={() => {
              void controller.ask(question, locale);
            }}
          />
          <AppText variant="muted">
            {exhausted
              ? t('coach.quotaExhausted')
              : quota.remaining === 1
                ? t('coach.quotaOne', { limit: quota.limit })
                : t('coach.quotaOther', { remaining: quota.remaining, limit: quota.limit })}
          </AppText>
        </>
      ) : (
        <Notice message={t('mobile.coach.consentRequired')} />
      )}

      {ask.kind === 'error' ? <ErrorNotice error={ask.error} /> : null}

      {ask.kind === 'pending' && ask.partial === null ? (
        <AppText variant="muted">{t('coach.thinking')}</AppText>
      ) : null}
      {ask.kind === 'pending' && ask.partial !== null ? (
        <ProvisionalAnswer partial={ask.partial} />
      ) : null}

      <View accessibilityLiveRegion="polite">
        {answer !== null ? <Answer answer={answer} /> : null}
      </View>
    </ScrollScreen>
  );
}

export default function CoachScreen() {
  // Keyed by user: another sign-in remounts the screen and drops the answer.
  return <SignedIn>{(userId) => <Coach key={userId} />}</SignedIn>;
}

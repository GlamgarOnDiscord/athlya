import { Stack } from 'expo-router';
import { useEffect, useReducer, useRef, useState } from 'react';
import { View } from 'react-native';

import { SignedIn, useWriteDeps } from '../components/AppSession';
import { ErrorNotice } from '../components/ErrorNotice';
import { useRuntime } from '../components/RuntimeProvider';
import { AppText } from '../components/ui/AppText';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Notice } from '../components/ui/Notice';
import { ScrollScreen } from '../components/ui/ScrollScreen';
import { TextField } from '../components/ui/TextField';
import {
  createDraft,
  MAX_EXERCISES,
  MAX_SETS,
  submitWorkout,
  workoutReducer,
  type SubmitWorkoutResult,
  type WorkoutFieldError,
} from '../features/workouts/workout-form';

type FieldOf<K extends WorkoutFieldError['field']['kind']> = Extract<
  WorkoutFieldError['field'],
  { kind: K }
>;

function Workout() {
  const runtime = useRuntime();
  const { t } = runtime;
  const writes = useWriteDeps();
  const [draft, dispatch] = useReducer(workoutReducer, new Date(), createDraft);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SubmitWorkoutResult | null>(null);
  const inflight = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      inflight.current?.abort();
    },
    [],
  );

  const errors = result?.kind === 'invalid' ? result.errors : [];
  const errorFor = (match: (field: WorkoutFieldError['field']) => boolean): string | null => {
    const found = errors.find((error) => match(error.field));
    return found === undefined ? null : t(found.key);
  };
  const setError = (exercise: number, set: number, part: FieldOf<'set'>['part']) =>
    errorFor(
      (field) =>
        field.kind === 'set' &&
        field.exercise === exercise &&
        field.set === set &&
        field.part === part,
    );

  const submit = () => {
    const controller = new AbortController();
    inflight.current = controller;
    setBusy(true);
    setResult(null);
    submitWorkout(writes, draft, controller.signal)
      .then((outcome) => {
        setResult(outcome);
        if (outcome.kind === 'sent' || outcome.kind === 'queued') {
          dispatch({ type: 'reset', startedAt: new Date().toISOString() });
        }
      })
      .catch(() => {
        // Cancelled because the screen went away: nothing was sent or queued.
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
  };

  const formError = errorFor((field) => field.kind === 'form');

  return (
    <ScrollScreen>
      <Stack.Screen options={{ headerShown: true, title: t('mobile.workout.title') }} />
      <AppText variant="muted">
        {t('mobile.workout.limits', { exercises: MAX_EXERCISES, sets: MAX_SETS })}
      </AppText>
      {draft.exercises.map((exercise, exerciseIndex) => (
        <Card
          key={`exercise-${String(exerciseIndex)}`}
          accessibilityLabel={t('mobile.workout.exercise', { index: exerciseIndex + 1 })}
        >
          <AppText className="font-semibold">
            {t('mobile.workout.exercise', { index: exerciseIndex + 1 })}
          </AppText>
          <TextField
            label={t('mobile.workout.exerciseName')}
            value={exercise.name}
            autoCapitalize="sentences"
            onChangeText={(name) => {
              dispatch({ type: 'renameExercise', exercise: exerciseIndex, name });
            }}
            error={errorFor(
              (field) => field.kind === 'exerciseName' && field.exercise === exerciseIndex,
            )}
          />
          {exercise.sets.map((set, setIndex) => (
            <View key={`set-${String(setIndex)}`} className="gap-sm">
              <AppText variant="muted">{t('mobile.workout.set', { index: setIndex + 1 })}</AppText>
              <TextField
                label={`${t('mobile.workout.set', { index: setIndex + 1 })}, ${t('mobile.workout.reps')}`}
                value={set.reps}
                keyboardType="number-pad"
                onChangeText={(value) => {
                  dispatch({
                    type: 'updateSet',
                    exercise: exerciseIndex,
                    set: setIndex,
                    field: 'reps',
                    value,
                  });
                }}
                error={setError(exerciseIndex, setIndex, 'reps')}
              />
              <TextField
                label={`${t('mobile.workout.set', { index: setIndex + 1 })}, ${t('mobile.workout.weight')}`}
                value={set.weightKg}
                keyboardType="decimal-pad"
                onChangeText={(value) => {
                  dispatch({
                    type: 'updateSet',
                    exercise: exerciseIndex,
                    set: setIndex,
                    field: 'weightKg',
                    value,
                  });
                }}
                error={setError(exerciseIndex, setIndex, 'weightKg')}
              />
              {exercise.sets.length > 1 ? (
                <Button
                  title={t('mobile.workout.removeSet', { index: setIndex + 1 })}
                  variant="secondary"
                  onPress={() => {
                    dispatch({ type: 'removeSet', exercise: exerciseIndex, set: setIndex });
                  }}
                />
              ) : null}
            </View>
          ))}
          <Button
            title={t('mobile.workout.addSet')}
            variant="secondary"
            disabled={exercise.sets.length >= MAX_SETS}
            onPress={() => {
              dispatch({ type: 'addSet', exercise: exerciseIndex });
            }}
          />
          <Button
            title={t('mobile.workout.removeExercise', { index: exerciseIndex + 1 })}
            variant="secondary"
            onPress={() => {
              dispatch({ type: 'removeExercise', exercise: exerciseIndex });
            }}
          />
        </Card>
      ))}
      <Button
        title={t('mobile.workout.addExercise')}
        variant="secondary"
        disabled={draft.exercises.length >= MAX_EXERCISES}
        onPress={() => {
          dispatch({ type: 'addExercise' });
        }}
      />
      <TextField
        label={t('mobile.workout.duration')}
        value={draft.durationMin}
        keyboardType="number-pad"
        onChangeText={(value) => {
          dispatch({ type: 'setDuration', value });
        }}
        error={errorFor((field) => field.kind === 'duration')}
      />
      <TextField
        label={t('mobile.workout.notes')}
        value={draft.notes}
        multiline
        autoCapitalize="sentences"
        onChangeText={(value) => {
          dispatch({ type: 'setNotes', value });
        }}
        error={errorFor((field) => field.kind === 'notes')}
      />
      {formError === null ? null : <Notice tone="error" message={formError} />}
      {result?.kind === 'error' ? <ErrorNotice error={result.error} /> : null}
      {result?.kind === 'sent' ? <Notice message={t('mobile.workout.saved')} /> : null}
      {result?.kind === 'queued' ? <Notice message={t('mobile.workout.queued')} /> : null}
      <Button title={t('mobile.workout.save')} busy={busy} onPress={submit} />
    </ScrollScreen>
  );
}

export default function WorkoutScreen() {
  return <SignedIn>{() => <Workout />}</SignedIn>;
}

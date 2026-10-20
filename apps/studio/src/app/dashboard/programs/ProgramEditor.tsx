'use client';

/**
 * Program editor — weeks, days and exercises (Epic 24, task 24.3).
 *
 * Accessibility:
 *   - every week and workout is a `<fieldset>` with a `<legend>`, every
 *     control has a visible `<label>`, and remove buttons name the row
 *     they remove (screen-reader users hear "Remove week 2", not
 *     "Remove");
 *   - validation errors are listed in a `role="alert"` summary that
 *     takes focus, and each faulty field carries `aria-invalid` +
 *     `aria-describedby` pointing at its message.
 *
 * The draft is validated with the shared Zod schemas before any
 * request; mutations carry an `Idempotency-Key`.
 */
import { CircleNotchIcon, TrashIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { PageHeader } from '../../../components/shell/PageHeader';

import { newIdempotencyKey } from '../../../lib/idempotency';

import {
  MAX_PROGRAM_EXERCISES,
  MAX_PROGRAM_WEEKS,
  addExercise,
  addWeek,
  addWorkout,
  draftFromProgram,
  draftToCreatePayload,
  draftToUpdatePayload,
  emptyDraft,
  freeDays,
  removeExercise,
  removeWeek,
  removeWorkout,
  updateExercise,
  updateWeek,
  updateWorkout,
  type ExerciseDraft,
  type FieldErrors,
  type ProgramDraft,
} from './program-form';

import type { ApiClient } from '../../../lib/api/client';
import type { Translator } from '../../../lib/i18n/t';
import type { ProgramDetail } from '@athlya/shared/schemas/api';

export type ProgramEditorMode =
  { readonly kind: 'create' } | { readonly kind: 'edit'; readonly program: ProgramDetail };

export interface ProgramEditorProps {
  readonly mode: ProgramEditorMode;
  readonly client: ApiClient;
  readonly t: Translator;
  /** `committed` is true when the program was saved. */
  readonly onDone: (committed: boolean) => void;
}

/** Compact remove control: the icon shows, the full sentence names it. */
const REMOVE_BUTTON = 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive';

const CONTROL =
  'w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm';

const EXERCISE_NUMBER_FIELDS = ['sets', 'reps', 'durationSec', 'weightKg', 'restSec'] as const;

type ExerciseNumberField = (typeof EXERCISE_NUMBER_FIELDS)[number];

const NUMBER_LIMITS: Record<ExerciseNumberField, { min: number; max: number; step?: number }> = {
  sets: { min: 1, max: 20 },
  reps: { min: 1, max: 200 },
  durationSec: { min: 1, max: 3600 },
  weightKg: { min: 0, max: 1000, step: 0.5 },
  restSec: { min: 0, max: 900 },
};

function problemCode(err: unknown): string | undefined {
  return (err as { problem?: { code?: string } }).problem?.code;
}

export function ProgramEditor({ mode, client, t, onDone }: ProgramEditorProps): ReactElement {
  const [draft, setDraft] = useState<ProgramDraft>(() =>
    mode.kind === 'edit' ? draftFromProgram(mode.program) : emptyDraft(),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const idBase = useId();
  const fieldId = (path: string) => `${idBase}-${path.replaceAll('.', '-')}`;

  const errorCount = Object.keys(errors).length;
  useEffect(() => {
    if (errorCount > 0 || failure !== null) summaryRef.current?.focus();
  }, [errorCount, failure]);

  const describeField = (path: string) =>
    errors[path] === undefined
      ? {}
      : { 'aria-invalid': true as const, 'aria-describedby': `${fieldId(path)}-error` };

  const fieldError = (path: string): ReactElement | null =>
    errors[path] === undefined ? null : (
      <span id={`${fieldId(path)}-error`} className="text-sm text-destructive">
        {errors[path]}
      </span>
    );

  /** Human location of a payload path, for the error summary. */
  const describePath = (path: string): string => {
    const parts = path.split('.');
    const labels: string[] = [];
    const weekIndex = parts[0] === 'weeks' ? Number(parts[1]) : Number.NaN;
    if (!Number.isNaN(weekIndex))
      labels.push(t('studio.programs.editor.week', { n: weekIndex + 1 }));
    const workout =
      parts[2] === 'workouts' ? draft.weeks[weekIndex]?.workouts[Number(parts[3])] : undefined;
    if (workout !== undefined) {
      labels.push(t('studio.programs.editor.workout', { day: workout.dayNumber }));
    }
    if (parts[4] === 'exercises' && parts[5] !== undefined) {
      labels.push(t('studio.programs.editor.exercise', { n: Number(parts[5]) + 1 }));
    }
    return labels.length === 0 ? '' : `${labels.join(' · ')} — `;
  };

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setFailure(null);
      const result =
        mode.kind === 'create'
          ? draftToCreatePayload(draft)
          : draftToUpdatePayload(draft, mode.program.version);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      setErrors({});
      setPending(true);
      try {
        const init = { headers: { 'Idempotency-Key': newIdempotencyKey() } };
        if (mode.kind === 'create') {
          await client.post('/v1/programs', result.payload, init);
        } else {
          await client.patch(`/v1/programs/${mode.program.id}`, result.payload, init);
        }
        onDone(true);
      } catch (err) {
        const code = problemCode(err);
        setFailure(
          code === 'version_conflict'
            ? t('studio.programs.editor.errors.versionConflict')
            : code === 'program_archived'
              ? t('studio.programs.editor.errors.archived')
              : t('studio.programs.editor.errors.generic'),
        );
      } finally {
        setPending(false);
      }
    },
    [client, draft, mode, onDone, t],
  );

  const exerciseField = (
    weekIndex: number,
    workoutIndex: number,
    exerciseIndex: number,
    exercise: ExerciseDraft,
    field: ExerciseNumberField,
  ): ReactElement => {
    const path = `weeks.${String(weekIndex)}.workouts.${String(workoutIndex)}.exercises.${String(exerciseIndex)}.${field}`;
    const limits = NUMBER_LIMITS[field];
    return (
      <div key={field} className="flex flex-col gap-1">
        <Label htmlFor={fieldId(path)} className="text-xs text-muted-foreground">
          {t(`studio.programs.editor.fields.${field}`)}
        </Label>
        <Input
          id={fieldId(path)}
          type="number"
          inputMode={field === 'weightKg' ? 'decimal' : 'numeric'}
          min={limits.min}
          max={limits.max}
          step={limits.step ?? 1}
          value={exercise[field]}
          onChange={(e) =>
            setDraft((d) =>
              updateExercise(d, weekIndex, workoutIndex, exerciseIndex, {
                [field]: e.target.value,
              }),
            )
          }
          {...describeField(path)}
        />
        {fieldError(path)}
      </div>
    );
  };

  const title =
    mode.kind === 'create'
      ? t('studio.programs.editor.createTitle')
      : t('studio.programs.editor.editTitle');

  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title={title}
        subtitle={t('studio.programs.editor.help', {
          weeks: MAX_PROGRAM_WEEKS,
          exercises: MAX_PROGRAM_EXERCISES,
        })}
        actions={
          <Button variant="outline" onClick={() => onDone(false)} disabled={pending}>
            {t('studio.programs.editor.back')}
          </Button>
        }
      />

      {errorCount > 0 || failure !== null ? (
        <div
          ref={summaryRef}
          tabIndex={-1}
          role="alert"
          className="rounded-lg border border-destructive p-3 text-sm text-destructive"
        >
          {failure !== null ? <p>{failure}</p> : null}
          {errorCount > 0 ? (
            <>
              <p className="font-medium">{t('studio.programs.editor.errorsTitle')}</p>
              <ul className="list-disc pl-5">
                {Object.entries(errors).map(([path, message]) => (
                  <li key={path}>
                    {describePath(path)}
                    {message}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      <form
        onSubmit={(e) => {
          void submit(e);
        }}
        aria-busy={pending}
        noValidate
        className="flex flex-col gap-6"
      >
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId('title')}>{t('studio.programs.editor.fields.title')}</Label>
            <Input
              id={fieldId('title')}
              required
              maxLength={120}
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              {...describeField('title')}
            />
            {fieldError('title')}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId('status')}>{t('studio.programs.editor.fields.status')}</Label>
            <select
              id={fieldId('status')}
              className={`${CONTROL} h-8`}
              value={draft.status}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  status: e.target.value === 'published' ? 'published' : 'draft',
                }))
              }
            >
              <option value="draft">{t('studio.programs.status.draft')}</option>
              <option value="published">{t('studio.programs.status.published')}</option>
            </select>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fieldId('description')}>
            {t('studio.programs.editor.fields.description')}
          </Label>
          <textarea
            id={fieldId('description')}
            className={`${CONTROL} min-h-20`}
            maxLength={2000}
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            {...describeField('description')}
          />
          {fieldError('description')}
        </div>

        {fieldError('weeks')}

        {draft.weeks.map((week, weekIndex) => {
          const weekNumber = weekIndex + 1;
          const weekPath = `weeks.${String(weekIndex)}`;
          return (
            <fieldset
              key={week.key}
              className="flex min-w-0 flex-col gap-4 rounded-xl border p-3 sm:p-4"
            >
              <legend className="px-1 text-lg font-semibold">
                {t('studio.programs.editor.week', { n: weekNumber })}
              </legend>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Label htmlFor={fieldId(`${weekPath}.title`)}>
                    {t('studio.programs.editor.fields.weekTitle')}
                  </Label>
                  <Input
                    id={fieldId(`${weekPath}.title`)}
                    maxLength={120}
                    value={week.title}
                    onChange={(e) =>
                      setDraft((d) => updateWeek(d, weekIndex, { title: e.target.value }))
                    }
                    {...describeField(`${weekPath}.title`)}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={REMOVE_BUTTON}
                  aria-label={t('studio.programs.editor.removeWeek', { n: weekNumber })}
                  title={t('studio.programs.editor.removeWeek', { n: weekNumber })}
                  disabled={draft.weeks.length === 1}
                  onClick={() => setDraft((d) => removeWeek(d, weekIndex))}
                >
                  <TrashIcon aria-hidden="true" />
                </Button>
              </div>

              {week.workouts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('studio.programs.editor.restWeek')}
                </p>
              ) : null}
              {fieldError(`${weekPath}.workouts`)}

              {week.workouts.map((workout, workoutIndex) => {
                const workoutPath = `${weekPath}.workouts.${String(workoutIndex)}`;
                const workoutLabel = { day: workout.dayNumber, week: weekNumber };
                return (
                  <fieldset
                    key={workout.key}
                    className="flex min-w-0 flex-col gap-3 rounded-lg border border-dashed p-3"
                  >
                    <legend className="px-1 font-medium">
                      {t('studio.programs.editor.workout', { day: workout.dayNumber })}
                    </legend>
                    <div className="grid grid-cols-[1fr_auto] items-end gap-3 sm:grid-cols-[8rem_1fr_auto]">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor={fieldId(`${workoutPath}.dayNumber`)}>
                          {t('studio.programs.editor.fields.day')}
                        </Label>
                        <select
                          id={fieldId(`${workoutPath}.dayNumber`)}
                          className={`${CONTROL} h-8`}
                          value={workout.dayNumber}
                          onChange={(e) =>
                            setDraft((d) =>
                              updateWorkout(d, weekIndex, workoutIndex, {
                                dayNumber: Number(e.target.value),
                              }),
                            )
                          }
                        >
                          {freeDays(week, workout.dayNumber).map((day) => (
                            <option key={day} value={day}>
                              {t('studio.programs.editor.dayOption', { n: day })}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="order-last col-span-2 flex flex-col gap-1.5 sm:order-none sm:col-span-1">
                        <Label htmlFor={fieldId(`${workoutPath}.title`)}>
                          {t('studio.programs.editor.fields.workoutTitle')}
                        </Label>
                        <Input
                          id={fieldId(`${workoutPath}.title`)}
                          required
                          maxLength={120}
                          value={workout.title}
                          onChange={(e) =>
                            setDraft((d) =>
                              updateWorkout(d, weekIndex, workoutIndex, { title: e.target.value }),
                            )
                          }
                          {...describeField(`${workoutPath}.title`)}
                        />
                        {fieldError(`${workoutPath}.title`)}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={REMOVE_BUTTON}
                        aria-label={t('studio.programs.editor.removeWorkout', workoutLabel)}
                        title={t('studio.programs.editor.removeWorkout', workoutLabel)}
                        onClick={() => setDraft((d) => removeWorkout(d, weekIndex, workoutIndex))}
                      >
                        <TrashIcon aria-hidden="true" />
                      </Button>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={fieldId(`${workoutPath}.notes`)}>
                        {t('studio.programs.editor.fields.notes')}
                      </Label>
                      <textarea
                        id={fieldId(`${workoutPath}.notes`)}
                        className={`${CONTROL} min-h-14`}
                        maxLength={2000}
                        value={workout.notes}
                        onChange={(e) =>
                          setDraft((d) =>
                            updateWorkout(d, weekIndex, workoutIndex, { notes: e.target.value }),
                          )
                        }
                      />
                    </div>

                    <ol className="flex flex-col gap-3">
                      {workout.exercises.map((exercise, exerciseIndex) => {
                        const exercisePath = `${workoutPath}.exercises.${String(exerciseIndex)}`;
                        const removeLabel = t('studio.programs.editor.removeExercise', {
                          n: exerciseIndex + 1,
                          ...workoutLabel,
                        });
                        return (
                          <li
                            key={exercise.key}
                            className="grid grid-cols-2 items-end gap-2 rounded-md bg-muted/40 p-2 sm:grid-cols-[2fr_repeat(5,minmax(4.5rem,1fr))_auto]"
                          >
                            <div className="col-span-2 flex flex-col gap-1 sm:col-span-1">
                              <Label
                                htmlFor={fieldId(`${exercisePath}.name`)}
                                className="text-xs text-muted-foreground"
                              >
                                {t('studio.programs.editor.exercise', { n: exerciseIndex + 1 })}
                              </Label>
                              <Input
                                id={fieldId(`${exercisePath}.name`)}
                                required
                                maxLength={120}
                                value={exercise.name}
                                onChange={(e) =>
                                  setDraft((d) =>
                                    updateExercise(d, weekIndex, workoutIndex, exerciseIndex, {
                                      name: e.target.value,
                                    }),
                                  )
                                }
                                {...describeField(`${exercisePath}.name`)}
                              />
                              {fieldError(`${exercisePath}.name`)}
                            </div>
                            {EXERCISE_NUMBER_FIELDS.map((field) =>
                              exerciseField(
                                weekIndex,
                                workoutIndex,
                                exerciseIndex,
                                exercise,
                                field,
                              ),
                            )}
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className={`${REMOVE_BUTTON} justify-self-end`}
                              aria-label={removeLabel}
                              title={removeLabel}
                              onClick={() =>
                                setDraft((d) =>
                                  removeExercise(d, weekIndex, workoutIndex, exerciseIndex),
                                )
                              }
                            >
                              <TrashIcon aria-hidden="true" />
                            </Button>
                            <div className="col-span-2 flex flex-col gap-1 sm:col-span-full">
                              <Label
                                htmlFor={fieldId(`${exercisePath}.notes`)}
                                className="text-xs text-muted-foreground"
                              >
                                {t('studio.programs.editor.fields.exerciseNotes')}
                              </Label>
                              <Input
                                id={fieldId(`${exercisePath}.notes`)}
                                maxLength={280}
                                value={exercise.notes}
                                onChange={(e) =>
                                  setDraft((d) =>
                                    updateExercise(d, weekIndex, workoutIndex, exerciseIndex, {
                                      notes: e.target.value,
                                    }),
                                  )
                                }
                                {...describeField(`${exercisePath}.notes`)}
                              />
                              {fieldError(`${exercisePath}.notes`)}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                    <div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={workout.exercises.length >= MAX_PROGRAM_EXERCISES}
                        onClick={() => setDraft((d) => addExercise(d, weekIndex, workoutIndex))}
                      >
                        {t('studio.programs.editor.addExercise')}
                      </Button>
                    </div>
                  </fieldset>
                );
              })}

              <div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={week.workouts.length >= 7}
                  onClick={() => setDraft((d) => addWorkout(d, weekIndex))}
                >
                  {t('studio.programs.editor.addWorkout')}
                </Button>
              </div>
            </fieldset>
          );
        })}

        <div className="flex flex-wrap justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={draft.weeks.length >= MAX_PROGRAM_WEEKS}
            onClick={() => setDraft(addWeek)}
          >
            {t('studio.programs.editor.addWeek')}
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onDone(false)}
              disabled={pending}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? (
                <CircleNotchIcon className="mr-2 size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {pending
                ? t('studio.programs.editor.saving')
                : mode.kind === 'create'
                  ? t('studio.programs.editor.create')
                  : t('studio.programs.editor.save')}
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}

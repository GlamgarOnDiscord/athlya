'use client';

import {
  CreateClassRequestSchema,
  CreateClassSeriesRequestSchema,
  UpdateClassRequestSchema,
  UpdateClassSeriesRequestSchema,
  type ClassWithRemaining,
  type Room,
  type ScheduleConflictItem,
} from '@athlya/shared/schemas/api';
import { CircleNotchIcon, RepeatIcon, WarningIcon } from '@phosphor-icons/react';
import { useCallback, useId, useMemo, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../../lib/i18n/t';
import { newIdempotencyKey } from '../../../lib/idempotency';

import {
  browserTimeZone,
  defaultRepeat,
  ISO_WEEKDAYS,
  localTimeOf,
  problemCodeOf,
  recurrenceOf,
  scheduleConflictsOf,
  toggleWeekday,
  type IsoDay,
  type RepeatDraft,
  type SeriesScope,
} from './class-form';

import type { ApiClient } from '../../../lib/api/client';
import type { StudioMember } from '../../../lib/api/members';
import type { Locale } from '@athlya/shared/i18n';

export type ClassFormMode =
  | { readonly kind: 'create'; readonly startsAt?: string }
  | { readonly kind: 'edit'; readonly cls: ClassWithRemaining };

export interface ClassFormDialogProps {
  readonly mode: ClassFormMode;
  readonly client: ApiClient;
  /** Live rooms of the studio, for the room picker. */
  readonly rooms: ReadonlyArray<Room>;
  /** Coaches and admins, for the coach picker. */
  readonly staff: ReadonlyArray<StudioMember>;
  readonly onClose: (committed: boolean) => void;
  readonly onConflict: () => void;
}

interface FormState {
  title: string;
  startsAt: string;
  durationMin: string;
  capacity: string;
  roomId: string;
  coachId: string;
}

const SELECT =
  'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';

function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(local: string): string {
  if (local === '') return '';
  return new Date(local).toISOString();
}

function defaultState(mode: ClassFormMode): FormState {
  if (mode.kind === 'edit') {
    return {
      title: mode.cls.title,
      startsAt: isoToLocalInput(mode.cls.startsAt),
      durationMin: String(mode.cls.durationMin),
      capacity: String(mode.cls.capacity),
      roomId: mode.cls.roomId ?? '',
      coachId: mode.cls.coachId ?? '',
    };
  }
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return {
    title: '',
    startsAt: isoToLocalInput(mode.startsAt ?? tomorrow.toISOString()),
    durationMin: '60',
    capacity: '12',
    roomId: '',
    coachId: '',
  };
}

type FieldErrors = Readonly<Record<string, string>>;

function fieldErrorsOf(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): FieldErrors {
  const next = Object.create(null) as Record<string, string>;
  for (const issue of issues) {
    const path = issue.path.map(String).join('.');
    if (next[path] === undefined) next[path] = issue.message;
  }
  return next;
}

/** "Mon", "Tue", ... in the reader's language, Monday first. */
function weekdayLabels(
  locale: Locale,
): ReadonlyArray<{ day: IsoDay; short: string; long: string }> {
  const short = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const long = new Intl.DateTimeFormat(locale, { weekday: 'long' });
  // 2027-01-04 is a Monday.
  return ISO_WEEKDAYS.map((day) => {
    const date = new Date(2027, 0, 3 + day);
    return { day, short: short.format(date).replace(/\.$/u, ''), long: long.format(date) };
  });
}

export function ClassFormDialog({
  mode,
  client,
  rooms,
  staff,
  onClose,
  onConflict,
}: ClassFormDialogProps): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);

  const [state, setState] = useState<FormState>(() => defaultState(mode));
  const [repeat, setRepeat] = useState<RepeatDraft>(() =>
    defaultRepeat(defaultState(mode).startsAt),
  );
  const [scope, setScope] = useState<SeriesScope>('one');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [genericError, setGenericError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ReadonlyArray<ScheduleConflictItem> | null>(null);
  const [pending, setPending] = useState<boolean>(false);

  const id = useId();
  const fieldId = (name: string): string => `${id}-${name}`;
  const editing = mode.kind === 'edit' ? mode.cls : null;
  const seriesId = editing?.seriesId ?? null;
  const days = useMemo(() => weekdayLabels(locale), [locale]);

  // The class's current room or coach stays selectable while the lists load
  // or after it left them (a coach who left the studio).
  const roomOptions = useMemo(
    () =>
      withCurrent(
        rooms.map((r) => ({ id: r.id, label: r.name })),
        editing?.roomId,
        t('studio.classes.fields.room'),
      ),
    [rooms, editing, t],
  );
  const staffOptions = useMemo(
    () =>
      withCurrent(
        staff.map((p) => ({ id: p.id, label: p.displayName })),
        editing?.coachId,
        t('studio.classes.fields.coach'),
      ),
    [staff, editing, t],
  );

  const update = (patch: Partial<FormState>): void => {
    setConflicts(null);
    setState((s) => ({ ...s, ...patch }));
  };

  const onRoomChange = (roomId: string): void => {
    const room = rooms.find((r) => r.id === roomId);
    update({
      roomId,
      ...(mode.kind === 'create' && room !== undefined && room.capacity !== null
        ? { capacity: String(room.capacity) }
        : {}),
    });
  };

  const send = useCallback(
    async (allowConflicts: boolean): Promise<void> => {
      setFieldErrors({});
      setGenericError(null);
      const base = {
        title: state.title,
        startsAt: localInputToIso(state.startsAt),
        durationMin: Number(state.durationMin),
        capacity: Number(state.capacity),
      };
      const override = allowConflicts ? { allowConflicts: true } : {};
      const headers = { headers: { 'Idempotency-Key': newIdempotencyKey() } };

      let request: (() => Promise<unknown>) | null = null;
      if (editing === null) {
        const placement = {
          ...(state.roomId !== '' ? { roomId: state.roomId } : {}),
          ...(state.coachId !== '' ? { coachId: state.coachId } : {}),
        };
        if (repeat.enabled) {
          if (repeat.weekdays.length === 0) {
            setFieldErrors({ weekdays: t('studio.classes.repeat.noWeekday') });
            return;
          }
          const parsed = CreateClassSeriesRequestSchema.safeParse({
            ...base,
            ...placement,
            ...override,
            recurrence: recurrenceOf(repeat),
            timeZone: browserTimeZone(),
          });
          if (!parsed.success) {
            setFieldErrors(fieldErrorsOf(parsed.error.issues));
            return;
          }
          request = () => client.post('/v1/classes/series', parsed.data, headers);
        } else {
          const parsed = CreateClassRequestSchema.safeParse({ ...base, ...placement, ...override });
          if (!parsed.success) {
            setFieldErrors(fieldErrorsOf(parsed.error.issues));
            return;
          }
          request = () => client.post('/v1/classes', parsed.data, headers);
        }
      } else {
        const changed = {
          ...(base.title !== editing.title ? { title: base.title } : {}),
          ...(base.durationMin !== editing.durationMin ? { durationMin: base.durationMin } : {}),
          ...(base.capacity !== editing.capacity ? { capacity: base.capacity } : {}),
          ...(state.roomId !== (editing.roomId ?? '')
            ? { roomId: state.roomId === '' ? null : state.roomId }
            : {}),
          ...(state.coachId !== (editing.coachId ?? '')
            ? { coachId: state.coachId === '' ? null : state.coachId }
            : {}),
        };
        const moved = base.startsAt !== new Date(editing.startsAt).toISOString();
        if (seriesId !== null && scope === 'following') {
          const parsed = UpdateClassSeriesRequestSchema.safeParse({
            fromClassId: editing.id,
            version: editing.version,
            ...changed,
            ...(moved
              ? { startTime: localTimeOf(state.startsAt), timeZone: browserTimeZone() }
              : {}),
            ...override,
          });
          if (!parsed.success) {
            if (!moved && Object.keys(changed).length === 0) {
              onClose(false);
              return;
            }
            setFieldErrors(fieldErrorsOf(parsed.error.issues));
            return;
          }
          request = () => client.patch(`/v1/classes/series/${seriesId}`, parsed.data, headers);
        } else {
          if (!moved && Object.keys(changed).length === 0) {
            onClose(false);
            return;
          }
          const parsed = UpdateClassRequestSchema.safeParse({
            ...changed,
            ...(moved ? { startsAt: base.startsAt } : {}),
            version: editing.version,
            ...override,
          });
          if (!parsed.success) {
            setFieldErrors(fieldErrorsOf(parsed.error.issues));
            return;
          }
          request = () => client.patch(`/v1/classes/${editing.id}`, parsed.data, headers);
        }
      }

      setPending(true);
      try {
        await request();
        onClose(true);
      } catch (err) {
        const clashes = scheduleConflictsOf(err);
        if (clashes !== null) {
          setConflicts(clashes);
          return;
        }
        const code = problemCodeOf(err);
        if (code === 'version_conflict') {
          setGenericError(t('studio.classes.errors.versionConflict'));
          onConflict();
          return;
        }
        if (code === 'room_not_found') {
          setGenericError(t('studio.classes.errors.roomNotFound'));
          return;
        }
        handleMutationError(err, setGenericError, t);
      } finally {
        setPending(false);
      }
    },
    [state, repeat, scope, editing, seriesId, client, t, onClose, onConflict],
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose(false);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode.kind === 'create'
              ? t('studio.classes.dialog.createTitle')
              : t('studio.classes.dialog.editTitle')}
          </DialogTitle>
          {seriesId !== null ? (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <RepeatIcon aria-hidden="true" className="size-4" />
              {t('studio.classes.series.partOf')}
            </p>
          ) : null}
        </DialogHeader>

        <form
          id="class-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send(false);
          }}
          aria-busy={pending}
          noValidate
          className="flex flex-col gap-4"
        >
          <Field
            id={fieldId('title')}
            label={t('studio.classes.fields.title')}
            error={fieldErrors['title']}
          >
            <Input
              id={fieldId('title')}
              type="text"
              required
              maxLength={200}
              value={state.title}
              onChange={(e) => update({ title: e.target.value })}
            />
          </Field>

          <Field
            id={fieldId('startsAt')}
            label={t('studio.classes.fields.startsAt')}
            error={fieldErrors['startsAt']}
          >
            <Input
              id={fieldId('startsAt')}
              type="datetime-local"
              required
              value={state.startsAt}
              onChange={(e) => {
                update({ startsAt: e.target.value });
                if (!repeat.enabled) setRepeat(defaultRepeat(e.target.value));
              }}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field
              id={fieldId('durationMin')}
              label={t('studio.classes.fields.durationMin')}
              error={fieldErrors['durationMin']}
            >
              <Input
                id={fieldId('durationMin')}
                type="number"
                min={5}
                max={480}
                required
                value={state.durationMin}
                onChange={(e) => update({ durationMin: e.target.value })}
              />
            </Field>
            <Field
              id={fieldId('capacity')}
              label={t('studio.classes.fields.capacity')}
              error={fieldErrors['capacity']}
            >
              <Input
                id={fieldId('capacity')}
                type="number"
                min={1}
                max={500}
                required
                value={state.capacity}
                onChange={(e) => update({ capacity: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              id={fieldId('room')}
              label={t('studio.classes.fields.room')}
              error={fieldErrors['roomId']}
            >
              <select
                id={fieldId('room')}
                className={SELECT}
                value={state.roomId}
                onChange={(e) => onRoomChange(e.target.value)}
              >
                <option value="">{t('studio.classes.fields.noRoom')}</option>
                {roomOptions.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              id={fieldId('coach')}
              label={t('studio.classes.fields.coach')}
              error={fieldErrors['coachId']}
            >
              <select
                id={fieldId('coach')}
                className={SELECT}
                value={state.coachId}
                onChange={(e) => update({ coachId: e.target.value })}
              >
                <option value="">{t('studio.classes.fields.noCoach')}</option>
                {staffOptions.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {mode.kind === 'create' ? (
            <RepeatSection
              idPrefix={id}
              repeat={repeat}
              days={days}
              error={
                fieldErrors['weekdays'] ??
                fieldErrors['recurrence.until'] ??
                fieldErrors['recurrence.count']
              }
              t={t}
              onChange={(next) => {
                setConflicts(null);
                setRepeat(next);
              }}
            />
          ) : null}

          {seriesId !== null ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">
                {t('studio.classes.series.scopeLegend')}
              </legend>
              {(['one', 'following'] as const).map((value) => (
                <label key={value} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={`${id}-scope`}
                    value={value}
                    checked={scope === value}
                    onChange={() => {
                      setConflicts(null);
                      setScope(value);
                    }}
                    className="size-4 accent-primary"
                  />
                  {t(
                    value === 'one'
                      ? 'studio.classes.series.scopeOne'
                      : 'studio.classes.series.scopeFollowing',
                  )}
                </label>
              ))}
              {scope === 'following' ? (
                <p className="text-xs text-muted-foreground">
                  {t('studio.classes.series.timeOnly')}
                </p>
              ) : null}
            </fieldset>
          ) : null}

          {conflicts !== null ? (
            <ConflictNotice conflicts={conflicts} locale={locale} t={t} />
          ) : null}

          {genericError !== null ? (
            <span role="alert" className="text-sm text-destructive">
              {genericError}
            </span>
          ) : null}
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)} disabled={pending}>
            {t('common.cancel')}
          </Button>
          {conflicts !== null ? (
            <Button disabled={pending} onClick={() => void send(true)}>
              {pending ? (
                <CircleNotchIcon className="mr-2 size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {t('studio.classes.conflict.confirm')}
            </Button>
          ) : (
            <Button type="submit" form="class-form" disabled={pending}>
              {pending ? (
                <CircleNotchIcon className="mr-2 size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {mode.kind === 'create'
                ? t('studio.classes.dialog.createSubmit')
                : t('studio.classes.dialog.editSubmit')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface Option {
  readonly id: string;
  readonly label: string;
}

/** `options`, plus `current` under a generic label when it is not among them. */
function withCurrent(
  options: ReadonlyArray<Option>,
  current: string | null | undefined,
  fallbackLabel: string,
): ReadonlyArray<Option> {
  if (current == null || options.some((o) => o.id === current)) return options;
  return [...options, { id: current, label: fallbackLabel }];
}

function Field({
  id,
  label,
  error,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly error: string | undefined;
  readonly children: ReactElement;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error !== undefined ? (
        <span role="alert" className="text-sm text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function RepeatSection({
  idPrefix,
  repeat,
  days,
  error,
  t,
  onChange,
}: {
  readonly idPrefix: string;
  readonly repeat: RepeatDraft;
  readonly days: ReadonlyArray<{ day: IsoDay; short: string; long: string }>;
  readonly error: string | undefined;
  readonly t: Translator;
  readonly onChange: (next: RepeatDraft) => void;
}): ReactElement {
  const endId = `${idPrefix}-repeat-end-value`;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={repeat.enabled}
          onChange={(e) => onChange({ ...repeat, enabled: e.target.checked })}
          className="size-4 accent-primary"
        />
        {t('studio.classes.repeat.label')}
      </label>
      {repeat.enabled ? (
        <>
          <div
            role="group"
            aria-label={t('studio.classes.repeat.weekdays')}
            className="flex flex-wrap gap-1.5"
          >
            {days.map(({ day, short, long }) => {
              const on = repeat.weekdays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  aria-label={long}
                  onClick={() =>
                    onChange({ ...repeat, weekdays: toggleWeekday(repeat.weekdays, day) })
                  }
                  className={cn(
                    'h-8 min-w-10 rounded-lg border px-2 text-sm font-medium first-letter:uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    on
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {short}
                </button>
              );
            })}
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t('studio.classes.repeat.end')}</legend>
            {(['count', 'until'] as const).map((end) => (
              <label key={end} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${idPrefix}-repeat-end`}
                  value={end}
                  checked={repeat.end === end}
                  onChange={() => onChange({ ...repeat, end })}
                  className="size-4 accent-primary"
                />
                {t(
                  end === 'count'
                    ? 'studio.classes.repeat.endCount'
                    : 'studio.classes.repeat.endUntil',
                )}
              </label>
            ))}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={endId}>
                {t(
                  repeat.end === 'count'
                    ? 'studio.classes.repeat.count'
                    : 'studio.classes.repeat.until',
                )}
              </Label>
              {repeat.end === 'count' ? (
                <Input
                  id={endId}
                  type="number"
                  min={2}
                  max={60}
                  value={repeat.count}
                  onChange={(e) => onChange({ ...repeat, count: e.target.value })}
                  className="w-28"
                />
              ) : (
                <Input
                  id={endId}
                  type="date"
                  value={repeat.until}
                  onChange={(e) => onChange({ ...repeat, until: e.target.value })}
                  className="w-44"
                />
              )}
            </div>
          </fieldset>
          {error !== undefined ? (
            <span role="alert" className="text-sm text-destructive">
              {error}
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

const MAX_SHOWN_CONFLICTS = 4;

function ConflictNotice({
  conflicts,
  locale,
  t,
}: {
  readonly conflicts: ReadonlyArray<ScheduleConflictItem>;
  readonly locale: Locale;
  readonly t: Translator;
}): ReactElement {
  const fmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }),
    [locale],
  );
  const shown = conflicts.slice(0, MAX_SHOWN_CONFLICTS);
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg border border-border bg-muted p-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        <WarningIcon aria-hidden="true" weight="bold" className="size-4 shrink-0" />
        {t('studio.classes.conflict.title')}
      </p>
      <p className="text-sm text-muted-foreground">{t('studio.classes.conflict.body')}</p>
      <ul className="flex flex-col gap-1 text-sm">
        {shown.map((c) => (
          <li key={`${c.occurrenceStartsAt}-${c.classId}`} className="flex flex-wrap gap-x-1.5">
            <span className="font-medium">{c.title}</span>
            <span className="text-muted-foreground tabular-nums">
              {fmt.format(new Date(c.startsAt))}
            </span>
            <span className="text-muted-foreground">
              ({c.reasons.map((r) => t(`studio.classes.conflict.${r}`)).join(', ')})
            </span>
          </li>
        ))}
      </ul>
      {conflicts.length > shown.length ? (
        <p className="text-xs text-muted-foreground">
          {t('studio.classes.conflict.more', { count: conflicts.length - shown.length })}
        </p>
      ) : null}
    </div>
  );
}

function handleMutationError(
  err: unknown,
  setGenericError: (msg: string | null) => void,
  t: Translator,
): void {
  const probe = err as { status?: number; problem?: { detail?: string; title?: string } };
  if (probe.problem?.detail !== undefined) {
    setGenericError(probe.problem.detail);
    return;
  }
  if (probe.problem?.title !== undefined) {
    setGenericError(probe.problem.title);
    return;
  }
  setGenericError(t('studio.classes.errors.generic'));
}

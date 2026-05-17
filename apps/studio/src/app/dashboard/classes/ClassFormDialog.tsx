'use client';

import {
  CreateClassRequestSchema,
  UpdateClassRequestSchema,
  type ClassWithRemaining,
} from '@athlya/shared/schemas/api';
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
import { Loader2 } from 'lucide-react';

import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';
import { newIdempotencyKey } from '../../../lib/idempotency';

import type { ApiClient } from '../../../lib/api/client';

export type ClassFormMode =
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly cls: ClassWithRemaining };

export interface ClassFormDialogProps {
  readonly mode: ClassFormMode;
  readonly client: ApiClient;
  readonly onClose: (committed: boolean) => void;
  readonly onConflict: () => void;
}

interface FormState {
  title: string;
  startsAt: string;
  durationMin: string;
  capacity: string;
}

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
    };
  }
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return {
    title: '',
    startsAt: isoToLocalInput(tomorrow.toISOString()),
    durationMin: '60',
    capacity: '12',
  };
}

type FieldErrors = Readonly<Record<string, string>>;

export function ClassFormDialog({
  mode,
  client,
  onClose,
  onConflict,
}: ClassFormDialogProps): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);

  const [state, setState] = useState<FormState>(() => defaultState(mode));
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [genericError, setGenericError] = useState<string | null>(null);
  const [pending, setPending] = useState<boolean>(false);

  const titleId = useId();

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setFieldErrors({});
      setGenericError(null);

      const payload = {
        title: state.title,
        startsAt: localInputToIso(state.startsAt),
        durationMin: Number(state.durationMin),
        capacity: Number(state.capacity),
      };

      if (mode.kind === 'create') {
        const parsed = CreateClassRequestSchema.safeParse(payload);
        if (!parsed.success) {
          const next: Record<string, string> = {};
          for (const issue of parsed.error.issues) {
            const path = issue.path.join('.');
            if (next[path] === undefined) next[path] = issue.message;
          }
          setFieldErrors(next);
          return;
        }
        setPending(true);
        try {
          await client.post('/v1/classes', parsed.data, {
            headers: { 'Idempotency-Key': newIdempotencyKey() },
          });
          onClose(true);
        } catch (err) {
          handleMutationError(err, setGenericError, t);
        } finally {
          setPending(false);
        }
        return;
      }

      const editPayload = { ...payload, version: mode.cls.version };
      const parsed = UpdateClassRequestSchema.safeParse(editPayload);
      if (!parsed.success) {
        const next: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          const path = issue.path.join('.');
          if (next[path] === undefined) next[path] = issue.message;
        }
        setFieldErrors(next);
        return;
      }
      setPending(true);
      try {
        await client.patch(`/v1/classes/${mode.cls.id}`, parsed.data, {
          headers: { 'Idempotency-Key': newIdempotencyKey() },
        });
        onClose(true);
      } catch (err) {
        if (isVersionConflict(err)) {
          setGenericError(t('studio.classes.errors.versionConflict'));
          onConflict();
          return;
        }
        handleMutationError(err, setGenericError, t);
      } finally {
        setPending(false);
      }
    },
    [state, mode, client, t, onClose, onConflict],
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose(false);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode.kind === 'create'
              ? t('studio.classes.dialog.createTitle')
              : t('studio.classes.dialog.editTitle')}
          </DialogTitle>
        </DialogHeader>

        <form
          id="class-form"
          onSubmit={(e) => {
            void onSubmit(e);
          }}
          aria-busy={pending}
          noValidate
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={titleId}>{t('studio.classes.fields.title')}</Label>
            <Input
              id={titleId}
              type="text"
              required
              maxLength={200}
              value={state.title}
              onChange={(e) => setState((s) => ({ ...s, title: e.target.value }))}
            />
            {fieldErrors['title'] !== undefined ? (
              <span role="alert" className="text-sm text-destructive">
                {fieldErrors['title']}
              </span>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t('studio.classes.fields.startsAt')}</Label>
            <Input
              type="datetime-local"
              required
              value={state.startsAt}
              onChange={(e) => setState((s) => ({ ...s, startsAt: e.target.value }))}
            />
            {fieldErrors['startsAt'] !== undefined ? (
              <span role="alert" className="text-sm text-destructive">
                {fieldErrors['startsAt']}
              </span>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>{t('studio.classes.fields.durationMin')}</Label>
              <Input
                type="number"
                min={5}
                max={480}
                required
                value={state.durationMin}
                onChange={(e) => setState((s) => ({ ...s, durationMin: e.target.value }))}
              />
              {fieldErrors['durationMin'] !== undefined ? (
                <span role="alert" className="text-sm text-destructive">
                  {fieldErrors['durationMin']}
                </span>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t('studio.classes.fields.capacity')}</Label>
              <Input
                type="number"
                min={1}
                max={500}
                required
                value={state.capacity}
                onChange={(e) => setState((s) => ({ ...s, capacity: e.target.value }))}
              />
              {fieldErrors['capacity'] !== undefined ? (
                <span role="alert" className="text-sm text-destructive">
                  {fieldErrors['capacity']}
                </span>
              ) : null}
            </div>
          </div>

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
          <Button type="submit" form="class-form" disabled={pending}>
            {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {mode.kind === 'create'
              ? t('studio.classes.dialog.createSubmit')
              : t('studio.classes.dialog.editSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function handleMutationError(
  err: unknown,
  setGenericError: (msg: string | null) => void,
  t: (
    key: string extends string ? Parameters<ReturnType<typeof createTranslator>>[0] : never,
  ) => string,
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

function isVersionConflict(err: unknown): boolean {
  const probe = err as { status?: number; problem?: { code?: string } };
  if (probe.status === 409) return true;
  return probe.problem?.code === 'version_conflict';
}

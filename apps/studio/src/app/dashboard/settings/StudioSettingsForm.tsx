'use client';

/**
 * Studio settings form (issue #759): name, time zone, postal address and
 * contact email, read from and written to `/v1/studios/me/settings`.
 * Fields the API rejects are flagged with its message.
 */
import { UpdateStudioSettingsRequestSchema } from '@athlya/shared/schemas/api';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

import { PageHeader } from '../../../components/shell/PageHeader';
import { useApiClient } from '../../../lib/api/buildClient';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../../lib/i18n/t';

import { timeZoneOptions } from './time-zones';

import type { StudioSettings } from '@athlya/shared/schemas/api';

const PATH = '/v1/studios/me/settings';

const CONTROL =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm';

type Draft = Record<keyof StudioSettings, string>;
type Field = keyof Draft;

function toDraft(settings: StudioSettings): Draft {
  return {
    name: settings.name,
    timezone: settings.timezone,
    addressLine: settings.addressLine ?? '',
    postalCode: settings.postalCode ?? '',
    city: settings.city ?? '',
    country: settings.country ?? '',
    contactEmail: settings.contactEmail ?? '',
  };
}

/** The fields that differ from the saved settings, as the API expects them. */
export function changedFields(saved: Draft, draft: Draft): Partial<Draft> {
  const patch: Partial<Draft> = {};
  for (const key of Object.keys(draft) as Field[]) {
    if (draft[key].trim() !== saved[key].trim()) patch[key] = draft[key];
  }
  return patch;
}

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; saved: Draft };

export function StudioSettingsForm(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { accessToken } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);

  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void client.get<StudioSettings>(PATH).then(
      (settings) => {
        if (cancelled) return;
        const saved = toDraft(settings);
        setLoad({ kind: 'ready', saved });
        setDraft(saved);
      },
      () => !cancelled && setLoad({ kind: 'error' }),
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  const zones = useMemo(
    () => timeZoneOptions(draft?.timezone ?? 'Europe/Paris'),
    [draft?.timezone],
  );

  const submit = async (): Promise<void> => {
    if (load.kind !== 'ready' || draft === null) return;
    const patch = changedFields(load.saved, draft);
    if (Object.keys(patch).length === 0) {
      toast.info(t('studio.settings.unchanged'));
      return;
    }
    const parsed = UpdateStudioSettingsRequestSchema.safeParse(patch);
    if (!parsed.success) {
      const next: Partial<Record<Field, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (typeof field === 'string' && field in draft) {
          next[field as Field] = t(`studio.settings.errors.${field as Field}`);
        }
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const saved = toDraft(await client.patch<StudioSettings>(PATH, parsed.data));
      setLoad({ kind: 'ready', saved });
      setDraft(saved);
      toast.success(t('studio.settings.saved'));
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('studio.settings.title')} subtitle={t('studio.settings.subtitle')} />
      {load.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {t('studio.settings.loadError')}
        </p>
      ) : load.kind === 'loading' || draft === null ? (
        <div className="flex max-w-3xl flex-col gap-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : (
        <form
          noValidate
          aria-busy={pending}
          className="flex max-w-3xl flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Section title={t('studio.settings.sections.general')}>
            <TextField
              field="name"
              t={t}
              draft={draft}
              errors={errors}
              onChange={setDraft}
              maxLength={120}
            />
            <div className="flex flex-col gap-1.5">
              <FieldLabel field="timezone" t={t} />
              <TimezoneSelect
                value={draft.timezone}
                zones={zones}
                onChange={(timezone) => setDraft({ ...draft, timezone })}
              />
              <p className="text-xs text-muted-foreground">{t('studio.settings.help.timezone')}</p>
            </div>
            <TextField
              field="contactEmail"
              t={t}
              draft={draft}
              errors={errors}
              onChange={setDraft}
              type="email"
              maxLength={254}
              help={t('studio.settings.help.contactEmail')}
            />
          </Section>

          <Section title={t('studio.settings.sections.address')}>
            <TextField
              field="addressLine"
              t={t}
              draft={draft}
              errors={errors}
              onChange={setDraft}
              maxLength={200}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[10rem_1fr_8rem]">
              <TextField
                field="postalCode"
                t={t}
                draft={draft}
                errors={errors}
                onChange={setDraft}
                maxLength={16}
              />
              <TextField
                field="city"
                t={t}
                draft={draft}
                errors={errors}
                onChange={setDraft}
                maxLength={100}
              />
              <TextField
                field="country"
                t={t}
                draft={draft}
                errors={errors}
                onChange={setDraft}
                maxLength={2}
                help={t('studio.settings.help.country')}
              />
            </div>
          </Section>

          <Section title={t('studio.settings.sections.booking')}>
            <p className="text-sm text-muted-foreground">{t('studio.settings.booking.body')}</p>
          </Section>

          <div className="flex justify-end">
            <Button type="submit" size="lg" disabled={pending}>
              {t('studio.settings.save')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:p-6">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function FieldLabel({ field, t }: { readonly field: Field; readonly t: Translator }): ReactElement {
  return <Label htmlFor={`settings-${field}`}>{t(`studio.settings.fields.${field}`)}</Label>;
}

function TextField({
  field,
  t,
  draft,
  errors,
  onChange,
  type = 'text',
  maxLength,
  help,
}: {
  readonly field: Field;
  readonly t: Translator;
  readonly draft: Draft;
  readonly errors: Partial<Record<Field, string>>;
  readonly onChange: (draft: Draft) => void;
  readonly type?: 'text' | 'email';
  readonly maxLength: number;
  readonly help?: string;
}): ReactElement {
  const error = errors[field];
  const errorId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <FieldLabel field={field} t={t} />
      <Input
        id={`settings-${field}`}
        type={type}
        maxLength={maxLength}
        value={draft[field]}
        aria-invalid={error !== undefined}
        aria-describedby={error !== undefined ? errorId : undefined}
        onChange={(e) => onChange({ ...draft, [field]: e.target.value })}
      />
      {error !== undefined ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : help !== undefined ? (
        <p className="text-xs text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}

function TimezoneSelect({
  value,
  zones,
  onChange,
}: {
  readonly value: string;
  readonly zones: readonly string[];
  readonly onChange: (zone: string) => void;
}): ReactElement {
  return (
    <select
      id="settings-timezone"
      className={CONTROL}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {zones.map((zone) => (
        <option key={zone} value={zone}>
          {zone.replace(/_/gu, ' ')}
        </option>
      ))}
    </select>
  );
}

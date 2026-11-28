/**
 * One custom domain (web or e-mail sending): issue #761.
 *
 * Empty: a hostname form. Registered: the hostname, its DNS verdict,
 * the records to create (each value copyable, with the result of the
 * last lookup), "check now", change and remove. Every record value
 * comes from the API: the card never builds DNS data itself.
 */
'use client';

import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  CopyIcon,
  HourglassIcon,
  TrashIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { useId, useState, type FormEvent, type ReactElement } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { ApiError } from '../../../lib/api/client';

import type { ApiClient } from '../../../lib/api/client';
import type { Translator } from '../../../lib/i18n/t';
import type { Locale } from '@athlya/shared/i18n';
import type {
  DnsRecord,
  DnsRecordCheck,
  StudioDomain,
  StudioDomainKind,
} from '@athlya/shared/schemas/api';

export interface DomainCardProps {
  readonly kind: StudioDomainKind;
  readonly domain: StudioDomain | null;
  readonly client: ApiClient;
  readonly t: Translator;
  readonly locale: Locale;
  readonly onChange: (kind: StudioDomainKind, domain: StudioDomain | null) => void;
}

type Busy = 'idle' | 'saving' | 'checking' | 'removing';

/** Message key of an API failure on a domain action. */
export function domainErrorKey(
  err: unknown,
):
  | 'studio.branding.domains.errors.invalid'
  | 'studio.branding.domains.errors.taken'
  | 'studio.branding.domains.errors.cooldown'
  | 'studio.branding.domains.errors.lookup'
  | 'studio.branding.domains.errors.generic' {
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? (err as { status: unknown }).status
      : undefined;
  if (status === 429) return 'studio.branding.domains.errors.cooldown';
  const code = err instanceof ApiError ? err.problem?.code : undefined;
  if (code === 'domain_taken') return 'studio.branding.domains.errors.taken';
  if (code === 'dns_lookup_failed' || status === 502)
    return 'studio.branding.domains.errors.lookup';
  if (status === 422) return 'studio.branding.domains.errors.invalid';
  return 'studio.branding.domains.errors.generic';
}

function CheckIcon({ check }: { readonly check: DnsRecordCheck }): ReactElement {
  if (check === 'ok') return <CheckCircleIcon aria-hidden="true" weight="fill" />;
  if (check === 'awaiting_value') return <HourglassIcon aria-hidden="true" />;
  if (check === 'unchecked') return <CircleDashedIcon aria-hidden="true" />;
  return <WarningIcon aria-hidden="true" className="text-destructive" />;
}

function CopyValue({
  label,
  value,
  t,
}: {
  readonly label: string;
  readonly value: string;
  readonly t: Translator;
}): ReactElement {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1 font-mono text-xs break-all">
        {value}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t('studio.branding.domains.records.copy', { field: label })}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(
            () => toast.success(t('studio.branding.domains.records.copied')),
            () => toast.error(t('studio.branding.domains.records.copyFailed')),
          );
        }}
      >
        <CopyIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

function RecordItem({
  record,
  t,
}: {
  readonly record: DnsRecord;
  readonly t: Translator;
}): ReactElement {
  const nameLabel = t('studio.branding.domains.records.name');
  const valueLabel = t('studio.branding.domains.records.value');
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <Badge variant="outline" className="font-mono">
            {record.type}
          </Badge>
          {t(`studio.branding.domains.purpose.${record.purpose}`)}
          {!record.required ? (
            <span className="text-xs font-normal text-muted-foreground">
              {t('studio.branding.domains.records.optional')}
            </span>
          ) : null}
        </p>
        <p className="flex items-center gap-1.5 text-sm [&_svg]:size-4">
          <CheckIcon check={record.check} />
          {t(`studio.branding.domains.check.${record.check}`)}
        </p>
      </div>
      <dl className="grid gap-2 text-sm md:grid-cols-[8rem_1fr] md:items-start">
        <dt className="text-muted-foreground">{nameLabel}</dt>
        <dd className="min-w-0">
          <CopyValue label={nameLabel} value={record.name} t={t} />
        </dd>
        <dt className="text-muted-foreground">{valueLabel}</dt>
        <dd className="min-w-0">
          {record.value !== null ? (
            <CopyValue label={valueLabel} value={record.value} t={t} />
          ) : (
            <span className="text-muted-foreground">
              {t('studio.branding.domains.records.awaitingValue')}
            </span>
          )}
        </dd>
        {record.priority !== null ? (
          <>
            <dt className="text-muted-foreground">
              {t('studio.branding.domains.records.priority')}
            </dt>
            <dd className="font-mono">{record.priority}</dd>
          </>
        ) : null}
      </dl>
    </li>
  );
}

function StatusBadge({
  domain,
  t,
}: {
  readonly domain: StudioDomain;
  readonly t: Translator;
}): ReactElement {
  if (domain.activatedAt !== null && domain.status === 'verified') {
    return <Badge>{t('studio.branding.domains.status.active')}</Badge>;
  }
  if (domain.status === 'verified') {
    return <Badge variant="secondary">{t('studio.branding.domains.status.verified')}</Badge>;
  }
  if (domain.status === 'failed') {
    return <Badge variant="destructive">{t('studio.branding.domains.status.failed')}</Badge>;
  }
  return <Badge variant="outline">{t('studio.branding.domains.status.pending')}</Badge>;
}

export function DomainCard({
  kind,
  domain,
  client,
  t,
  locale,
  onChange,
}: DomainCardProps): ReactElement {
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<Busy>('idle');
  const [error, setError] = useState<string | null>(null);
  const base = `/v1/studios/me/domains/${kind}`;

  const run = async (next: Busy, action: () => Promise<void>) => {
    setBusy(next);
    setError(null);
    try {
      await action();
    } catch (err: unknown) {
      setError(t(domainErrorKey(err)));
    } finally {
      setBusy('idle');
    }
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const hostname = draft.trim().toLowerCase().replace(/\.$/u, '');
    if (hostname === '') return;
    void run('saving', async () => {
      onChange(kind, await client.put<StudioDomain>(base, { hostname }));
      setEditing(false);
    });
  };

  const showForm = domain === null || editing;
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t(`studio.branding.domains.${kind}.title`)}
          {domain !== null ? <StatusBadge domain={domain} t={t} /> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t(`studio.branding.domains.${kind}.help`)}</p>

        {domain !== null && !editing ? (
          <div className="flex flex-col gap-1">
            <p className="font-mono text-base break-all">{domain.hostname}</p>
            <p className="text-sm text-muted-foreground">
              {domain.lastCheckedAt !== null
                ? t('studio.branding.domains.lastChecked', {
                    date: dateFormat.format(new Date(domain.lastCheckedAt)),
                  })
                : t('studio.branding.domains.neverChecked')}
            </p>
            {domain.status === 'verified' && domain.activatedAt === null ? (
              <p className="text-sm">{t(`studio.branding.domains.${kind}.awaitingActivation`)}</p>
            ) : null}
          </div>
        ) : null}

        {showForm ? (
          <form className="flex flex-col gap-2" noValidate onSubmit={onSubmit}>
            <Label htmlFor={inputId}>{t('studio.branding.domains.hostname')}</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id={inputId}
                className="font-mono sm:max-w-sm"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t(`studio.branding.domains.${kind}.placeholder`)}
                autoComplete="off"
                spellCheck={false}
                inputMode="url"
              />
              <div className="flex gap-2">
                <Button type="submit" disabled={busy !== 'idle' || draft.trim() === ''}>
                  {busy === 'saving'
                    ? t('studio.branding.saving')
                    : t('studio.branding.domains.add')}
                </Button>
                {editing ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setEditing(false);
                      setError(null);
                    }}
                  >
                    {t('common.cancel')}
                  </Button>
                ) : null}
              </div>
            </div>
          </form>
        ) : null}

        {domain !== null && !editing ? (
          <>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">
                {t('studio.branding.domains.records.title')}
              </h3>
              <ul className="flex flex-col gap-3">
                {domain.records.map((record) => (
                  <RecordItem key={record.purpose} record={record} t={t} />
                ))}
              </ul>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={busy !== 'idle'}
                onClick={() => {
                  void run('checking', async () => {
                    onChange(kind, await client.post<StudioDomain>(`${base}/check`, {}));
                  });
                }}
              >
                <ArrowClockwiseIcon aria-hidden="true" data-icon="inline-start" />
                {busy === 'checking'
                  ? t('studio.branding.domains.checking')
                  : t('studio.branding.domains.checkNow')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy !== 'idle'}
                onClick={() => {
                  setDraft(domain.hostname);
                  setEditing(true);
                }}
              >
                {t('studio.branding.domains.change')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy !== 'idle'}
                onClick={() => {
                  void run('removing', async () => {
                    await client.del<void>(base);
                    onChange(kind, null);
                  });
                }}
              >
                <TrashIcon aria-hidden="true" data-icon="inline-start" />
                {t('studio.branding.domains.remove')}
              </Button>
            </div>
          </>
        ) : null}

        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

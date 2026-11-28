'use client';

/**
 * Integrations (issue #760): the studio's webhook endpoints. Add one (URL
 * and events), see its signing secret once, enable or disable it, rotate
 * the secret, delete it, and read its last deliveries. Reads and writes
 * `/v1/studios/me/webhooks` (admins only).
 */
import {
  CreateWebhookEndpointRequestSchema,
  WEBHOOK_EVENT_TYPES,
} from '@athlya/shared/schemas/api';
import {
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  PlugsConnectedIcon,
  PlusIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useId, useMemo, useState, type ReactElement } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

import { PageHeader } from '../../../components/shell/PageHeader';
import { useApiClient } from '../../../lib/api/buildClient';
import { ApiError } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { pluralKey } from '../../../lib/i18n/plural';
import { createTranslator, type Translator } from '../../../lib/i18n/t';

import type { Locale } from '@athlya/shared/i18n';
import type {
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEventType,
  WebhookSecretResponse,
} from '@athlya/shared/schemas/api';

const PATH = '/v1/studios/me/webhooks';

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; items: WebhookEndpoint[] };

export function IntegrationsPanel(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { accessToken } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);

  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  const [deleting, setDeleting] = useState<WebhookEndpoint | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelled = false;
    void client.get<{ items: WebhookEndpoint[] }>(PATH).then(
      (res) => !cancelled && setLoad({ kind: 'ready', items: res.items }),
      () => !cancelled && setLoad({ kind: 'error' }),
    );
    return () => {
      cancelled = true;
    };
  }, [client, version]);

  const act = useCallback(
    async (endpoint: WebhookEndpoint, run: () => Promise<unknown>, done: string) => {
      setBusyId(endpoint.id);
      try {
        await run();
        toast.success(done);
        refresh();
      } catch {
        toast.error(t('errors.generic'));
      } finally {
        setBusyId(null);
      }
    },
    [refresh, t],
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('studio.integrations.title')}
        subtitle={t('studio.integrations.subtitle')}
        actions={
          <Button size="lg" onClick={() => setAdding(true)}>
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            {t('studio.integrations.add.open')}
          </Button>
        }
      />

      {load.kind === 'loading' ? (
        <Skeleton className="h-48 w-full" />
      ) : load.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {t('studio.integrations.loadError')}
        </p>
      ) : load.items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-10 text-center">
          <PlugsConnectedIcon aria-hidden="true" className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">{t('studio.integrations.empty.title')}</p>
          <p className="max-w-md text-sm text-muted-foreground">
            {t('studio.integrations.empty.body')}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {load.items.map((endpoint) => (
            <EndpointCard
              key={endpoint.id}
              endpoint={endpoint}
              busy={busyId === endpoint.id}
              locale={locale}
              t={t}
              onToggle={() =>
                void act(
                  endpoint,
                  () => client.patch(`${PATH}/${endpoint.id}`, { enabled: !endpoint.enabled }),
                  t(
                    endpoint.enabled
                      ? 'studio.integrations.disabledToast'
                      : 'studio.integrations.enabledToast',
                  ),
                )
              }
              onRotate={() => {
                setBusyId(endpoint.id);
                void client
                  .post<WebhookSecretResponse>(`${PATH}/${endpoint.id}/rotate-secret`, {})
                  .then(
                    (res) => setSecret({ url: res.endpoint.url, secret: res.secret }),
                    () => toast.error(t('errors.generic')),
                  )
                  .finally(() => setBusyId(null));
              }}
              onDelete={() => setDeleting(endpoint)}
            />
          ))}
        </ul>
      )}

      <SignatureHelp t={t} />

      {adding ? (
        <AddEndpointDialog
          t={t}
          create={(body) => client.post<WebhookSecretResponse>(PATH, body)}
          onClose={(created) => {
            setAdding(false);
            if (created !== null) {
              setSecret({ url: created.endpoint.url, secret: created.secret });
              refresh();
            }
          }}
        />
      ) : null}

      {secret !== null ? (
        <SecretDialog
          url={secret.url}
          secret={secret.secret}
          t={t}
          onClose={() => setSecret(null)}
        />
      ) : null}

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('studio.integrations.delete.title')}</DialogTitle>
            <DialogDescription className="break-all">{deleting?.url ?? ''}</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t('studio.integrations.delete.body')}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = deleting;
                setDeleting(null);
                if (target !== null) {
                  void act(
                    target,
                    () => client.del(`${PATH}/${target.id}`),
                    t('studio.integrations.deletedToast'),
                  );
                }
              }}
            >
              {t('studio.integrations.delete.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EndpointCard({
  endpoint,
  busy,
  locale,
  t,
  onToggle,
  onRotate,
  onDelete,
}: {
  readonly endpoint: WebhookEndpoint;
  readonly busy: boolean;
  readonly locale: Locale;
  readonly t: Translator;
  readonly onToggle: () => void;
  readonly onRotate: () => void;
  readonly onDelete: () => void;
}): ReactElement {
  return (
    <li className="flex flex-col rounded-lg border border-border bg-card">
      <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-all font-mono text-sm font-medium">{endpoint.url}</span>
            <Badge variant={endpoint.enabled ? 'default' : 'outline'}>
              {t(endpoint.enabled ? 'studio.integrations.active' : 'studio.integrations.paused')}
            </Badge>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {endpoint.events.map((event) => (
              <Badge key={event} variant="secondary">
                {t(eventKey(event))}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={onToggle}>
            {t(endpoint.enabled ? 'studio.integrations.disable' : 'studio.integrations.enable')}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={onRotate}>
            {t('studio.integrations.rotate')}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={onDelete}>
            {t('studio.integrations.delete.open')}
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2 p-4">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t('studio.integrations.deliveries.title')}
        </h3>
        {endpoint.recentDeliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('studio.integrations.deliveries.empty')}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {endpoint.recentDeliveries.map((delivery) => (
              <DeliveryRow key={delivery.id} delivery={delivery} locale={locale} t={t} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

type Key = Parameters<Translator>[0];

const EVENT_KEY: Readonly<Record<WebhookEventType, Key>> = {
  'reservation.created': 'studio.integrations.events.reservationCreated',
  'reservation.waitlisted': 'studio.integrations.events.reservationWaitlisted',
  'reservation.cancelled': 'studio.integrations.events.reservationCancelled',
  'reservation.promoted': 'studio.integrations.events.reservationPromoted',
  'auth.user.registered': 'studio.integrations.events.memberRegistered',
};

/** The i18n key naming an event type; an unknown type reads as "other event". */
export function eventKey(event: string): Key {
  return EVENT_KEY[event as WebhookEventType] ?? 'studio.integrations.events.other';
}

function DeliveryRow({
  delivery,
  locale,
  t,
}: {
  readonly delivery: WebhookDelivery;
  readonly locale: Locale;
  readonly t: Translator;
}): ReactElement {
  const when = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(delivery.createdAt));
  const Icon =
    delivery.status === 'delivered'
      ? CheckCircleIcon
      : delivery.status === 'failed'
        ? WarningCircleIcon
        : ClockIcon;
  const detail =
    delivery.lastStatusCode !== null
      ? `HTTP ${delivery.lastStatusCode}`
      : delivery.lastError !== null
        ? t(`studio.integrations.deliveries.errors.${errorKey(delivery.lastError)}`)
        : null;
  return (
    <li className="flex flex-col gap-1 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
      <span className="flex min-w-0 items-center gap-2">
        <Icon
          aria-hidden="true"
          className={
            delivery.status === 'failed' ? 'size-4 shrink-0 text-destructive' : 'size-4 shrink-0'
          }
        />
        <span className="truncate">{t(eventKey(delivery.eventType))}</span>
      </span>
      <span className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
        <span>{t(`studio.integrations.deliveries.status.${delivery.status}`)}</span>
        {detail !== null ? <span>{detail}</span> : null}
        <span>
          {t(
            pluralKey(locale, delivery.attempts, {
              one: 'studio.integrations.deliveries.attempts.one',
              other: 'studio.integrations.deliveries.attempts.other',
            }),
            { count: delivery.attempts },
          )}
        </span>
        <span>{when}</span>
      </span>
    </li>
  );
}

function errorKey(error: string): 'timeout' | 'network' | 'url' | 'other' {
  if (error === 'timeout') return 'timeout';
  if (error === 'network_error') return 'network';
  if (error === 'url_refused') return 'url';
  return 'other';
}

function SignatureHelp({ t }: { readonly t: Translator }): ReactElement {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">{t('studio.integrations.signature.title')}</h2>
      <p className="text-sm text-muted-foreground">{t('studio.integrations.signature.body')}</p>
      <pre className="rounded-md bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap">
        {'athlya-signature: t=1761033600,v1=<hex HMAC-SHA256(secret, "t.body")>'}
      </pre>
      <p className="text-sm text-muted-foreground">{t('studio.integrations.signature.retries')}</p>
    </section>
  );
}

function AddEndpointDialog({
  t,
  create,
  onClose,
}: {
  readonly t: Translator;
  readonly create: (body: {
    url: string;
    events: WebhookEventType[];
  }) => Promise<WebhookSecretResponse>;
  readonly onClose: (created: WebhookSecretResponse | null) => void;
}): ReactElement {
  const urlId = useId();
  const [url, setUrl] = useState('https://');
  const [events, setEvents] = useState<ReadonlySet<WebhookEventType>>(
    new Set(['reservation.created']),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (): Promise<void> => {
    const parsed = CreateWebhookEndpointRequestSchema.safeParse({ url, events: [...events] });
    if (!parsed.success) {
      const onUrl = parsed.error.issues.some((issue) => issue.path[0] === 'url');
      setError(t(onUrl ? 'studio.integrations.add.invalidUrl' : 'studio.integrations.add.noEvent'));
      return;
    }
    setError(null);
    setPending(true);
    try {
      onClose(await create(parsed.data));
    } catch (err) {
      setError(
        t(
          err instanceof ApiError && err.problem?.code === 'webhook_limit_reached'
            ? 'studio.integrations.add.limit'
            : 'errors.generic',
        ),
      );
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose(null);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('studio.integrations.add.title')}</DialogTitle>
          <DialogDescription>{t('studio.integrations.add.body')}</DialogDescription>
        </DialogHeader>
        <form
          id="webhook-add"
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={urlId}>{t('studio.integrations.add.url')}</Label>
            <Input
              id={urlId}
              type="url"
              inputMode="url"
              maxLength={2048}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">
              {t('studio.integrations.add.events')}
            </legend>
            {WEBHOOK_EVENT_TYPES.map((event) => (
              <label key={event} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-foreground"
                  checked={events.has(event)}
                  onChange={(e) => {
                    const next = new Set(events);
                    if (e.target.checked) next.add(event);
                    else next.delete(event);
                    setEvents(next);
                  }}
                />
                <span className="flex flex-col">
                  <span>{t(eventKey(event))}</span>
                  <span className="font-mono text-xs text-muted-foreground">{event}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {error !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onClose(null)}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="webhook-add" disabled={pending}>
            {t('studio.integrations.add.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SecretDialog({
  url,
  secret,
  t,
  onClose,
}: {
  readonly url: string;
  readonly secret: string;
  readonly t: Translator;
  readonly onClose: () => void;
}): ReactElement {
  const secretId = useId();
  const [copied, setCopied] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('studio.integrations.secret.title')}</DialogTitle>
          <DialogDescription className="break-all">{url}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor={secretId}>{t('studio.integrations.secret.label')}</Label>
          <div className="flex gap-2">
            <Input
              id={secretId}
              readOnly
              value={secret}
              className="min-w-0 flex-1 font-mono text-sm"
            />
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(secret).then(
                  () => setCopied(true),
                  () => toast.error(t('errors.generic')),
                );
              }}
            >
              {copied ? (
                <CheckIcon aria-hidden="true" data-icon="inline-start" />
              ) : (
                <CopyIcon aria-hidden="true" data-icon="inline-start" />
              )}
              {t(copied ? 'studio.integrations.secret.copied' : 'studio.integrations.secret.copy')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('studio.integrations.secret.once')}</p>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t('studio.integrations.secret.done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

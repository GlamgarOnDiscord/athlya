/**
 * One studio logo (light or dark surface): issue #761.
 *
 * Shows the stored logo on the surface it is made for (white for the
 * light variant, ink for the dark one, whatever the console theme),
 * uploads a PNG, JPEG or WebP through `PUT /v1/studios/me/logo/{variant}`
 * and removes it through `DELETE`. Type and size are checked here first
 * so the admin gets the reason before the upload; the API checks them
 * again, with the file's magic bytes.
 */
'use client';

import { ImageSquareIcon, TrashIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import { useId, useRef, useState, type ChangeEvent, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';

import { ApiError } from '../../../lib/api/client';

import type { ApiClient } from '../../../lib/api/client';
import type { Translator } from '../../../lib/i18n/t';
import type { StudioLogoVariant, StudioMeResponse } from '@athlya/shared/schemas/api';

/** Mirrors `LOGO_MAX_BYTES` of the API (`studio-logo-store.ts`). */
export const LOGO_MAX_BYTES = 128 * 1024;

export const LOGO_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp']);

export interface LogoEditorProps {
  readonly variant: StudioLogoVariant;
  readonly value: string | null;
  readonly studioName: string;
  readonly client: ApiClient;
  readonly t: Translator;
  readonly onSaved: (studio: StudioMeResponse) => void;
}

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'done'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

/** Reason a file cannot be sent, or `null` when it can. */
export function logoFileProblem(file: {
  readonly type: string;
  readonly size: number;
}): 'invalidType' | 'tooLarge' | null {
  if (!LOGO_TYPES.has(file.type)) return 'invalidType';
  if (file.size > LOGO_MAX_BYTES) return 'tooLarge';
  return null;
}

export function LogoEditor({
  variant,
  value,
  studioName,
  client,
  t,
  onSaved,
}: LogoEditorProps): ReactElement {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const label = t(`studio.branding.logo.${variant}`);
  const path = `/v1/studios/me/logo/${variant}`;

  const upload = async (file: File) => {
    const problem = logoFileProblem(file);
    if (problem !== null) {
      setStatus({ kind: 'error', message: t(`studio.branding.logo.${problem}`) });
      return;
    }
    setStatus({ kind: 'busy' });
    try {
      onSaved(await client.put<StudioMeResponse>(path, file));
      setStatus({ kind: 'done', message: t('studio.branding.logo.uploaded') });
    } catch (err: unknown) {
      const code = err instanceof ApiError ? err.problem?.code : undefined;
      setStatus({
        kind: 'error',
        message:
          code === 'logo_invalid_format'
            ? t('studio.branding.logo.invalidFormat')
            : code === 'logo_too_large' || code === 'payload_too_large'
              ? t('studio.branding.logo.tooLarge')
              : code === 'unsupported_media_type'
                ? t('studio.branding.logo.invalidType')
                : t('studio.branding.saveError'),
      });
    }
  };

  const remove = async () => {
    setStatus({ kind: 'busy' });
    try {
      onSaved(await client.del<StudioMeResponse>(path));
      setStatus({ kind: 'done', message: t('studio.branding.logo.removed') });
    } catch {
      setStatus({ kind: 'error', message: t('studio.branding.saveError') });
    }
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file !== undefined) void upload(file);
  };

  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-3">
      <p className="text-sm font-medium">{label}</p>
      <div
        className={`brand-logo-surface-${variant} flex h-28 items-center justify-center rounded-lg border border-border p-4`}
      >
        {value !== null ? (
          <img
            src={value}
            alt={t('studio.branding.logo.alt', { studio: studioName, variant: label })}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <span className="flex flex-col items-center gap-1 text-sm">
            <ImageSquareIcon aria-hidden="true" className="size-6" />
            {t('studio.branding.logo.empty')}
          </span>
        )}
      </div>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        onChange={onFile}
        aria-label={t('studio.branding.logo.choose', { variant: label })}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={status.kind === 'busy'}
          onClick={() => inputRef.current?.click()}
        >
          <UploadSimpleIcon aria-hidden="true" data-icon="inline-start" />
          {status.kind === 'busy'
            ? t('studio.branding.saving')
            : value === null
              ? t('studio.branding.logo.upload')
              : t('studio.branding.logo.replace')}
        </Button>
        {value !== null ? (
          <Button
            type="button"
            variant="ghost"
            disabled={status.kind === 'busy'}
            onClick={() => {
              void remove();
            }}
          >
            <TrashIcon aria-hidden="true" data-icon="inline-start" />
            {t('studio.branding.logo.remove')}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('studio.branding.logo.constraints')}</p>
      {status.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {status.message}
        </p>
      ) : null}
      {status.kind === 'done' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {status.message}
        </p>
      ) : null}
    </section>
  );
}

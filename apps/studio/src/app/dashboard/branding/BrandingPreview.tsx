/**
 * Brand color editor with a live contrast reading: B9.2, issue #761.
 *
 * Saves through `PATCH /v1/studios/me`. While the admin types, the
 * reading of `brand-contrast.ts` shows the text color the app and the
 * e-mails pair with the color (white or black), their contrast and
 * whether it meets WCAG 2.2 AA, plus how the color itself reads on the
 * light and dark surfaces. A color under AA cannot be saved (the API
 * refuses it as well, `brand_color_low_contrast`); a weak surface
 * contrast is a warning only.
 *
 * Colors reach the preview through CSS variables set via the CSSOM
 * (`setProperty`), so the strict CSP needs no `style=""` attribute
 * (issue #75).
 *
 * @see Requirement 13.2 (per-tenant branding), 15.2 (WCAG AA gate).
 */
'use client';

import { CheckCircleIcon, WarningIcon } from '@phosphor-icons/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
} from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { ApiError } from '../../../lib/api/client';
import { newIdempotencyKey } from '../../../lib/idempotency';

import { formatRatio, readBrandContrast, type SurfaceUse } from './brand-contrast';

import type { ApiClient } from '../../../lib/api/client';
import type { Translator } from '../../../lib/i18n/t';
import type { StudioMeResponse } from '@athlya/shared/schemas/api';
import type { TranslationKeys } from '@athlya/shared/i18n';

export interface BrandingPreviewProps {
  /** Stored brand color, `#RRGGBB`. */
  readonly color: string;
  readonly client: ApiClient;
  readonly t: Translator;
  readonly onSaved: (studio: StudioMeResponse) => void;
}

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'success' }
  | { readonly kind: 'error'; readonly message: string };

const USE_KEYS: Readonly<Record<SurfaceUse, TranslationKeys>> = {
  text: 'studio.branding.brandColor.use.text',
  graphics: 'studio.branding.brandColor.use.graphics',
  fill: 'studio.branding.brandColor.use.fill',
};

export function BrandingPreview({ color, client, t, onSaved }: BrandingPreviewProps): ReactElement {
  const [draft, setDraft] = useState<string>(() => color.toUpperCase());
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const reading = useMemo(() => readBrandContrast(draft), [draft]);
  const shown = reading ?? readBrandContrast(color);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = previewRef.current;
    if (root === null || shown === null) return;
    root.style.setProperty('--brand-bg', shown.color);
    root.style.setProperty('--brand-fg', shown.onPrimary);
  }, [shown]);

  const onColorChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setDraft(e.target.value.toUpperCase());
    setStatus({ kind: 'idle' });
  }, []);

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const next = readBrandContrast(draft);
      if (next === null) {
        setStatus({ kind: 'error', message: t('studio.branding.invalidHexError') });
        return;
      }
      if (!next.meetsAa) {
        setStatus({ kind: 'error', message: t('studio.branding.lowContrastError') });
        return;
      }
      setStatus({ kind: 'saving' });
      try {
        const studio = await client.patch<StudioMeResponse>(
          '/v1/studios/me',
          { brandColor: next.color },
          { headers: { 'Idempotency-Key': newIdempotencyKey() } },
        );
        onSaved(studio);
        setStatus({ kind: 'success' });
      } catch (err: unknown) {
        const code = err instanceof ApiError ? err.problem?.code : undefined;
        setStatus({
          kind: 'error',
          message:
            code === 'brand_color_low_contrast'
              ? t('studio.branding.lowContrastError')
              : err instanceof ApiError && err.status === 422
                ? t('studio.branding.invalidHexError')
                : t('studio.branding.saveError'),
        });
      }
    },
    [client, draft, onSaved, t],
  );

  const fgName = (hex: string) =>
    hex === '#000000'
      ? t('studio.branding.brandColor.fgBlack')
      : t('studio.branding.brandColor.fgWhite');
  const unchanged = draft === color.toUpperCase();

  return (
    <div ref={previewRef} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-3">
          <div
            aria-hidden="true"
            className="brand-preview-swatch size-12 shrink-0 rounded-full border border-border"
          />
          <span className="font-mono text-base">{shown?.color ?? color.toUpperCase()}</span>
        </div>
        <span className="brand-preview-sample rounded-md px-4 py-2 text-sm font-medium">
          {t('studio.branding.brandColor.sampleButton')}
        </span>
        {shown !== null ? (
          <dl className="grid min-w-0 grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('studio.branding.brandColor.computed')}</dt>
            <dd className="font-medium">
              {fgName(shown.onPrimary)} <span className="font-mono">{shown.onPrimary}</span>
            </dd>
            <dt className="text-muted-foreground">{t('studio.branding.brandColor.ratio')}</dt>
            <dd className="flex items-center gap-1.5 font-medium">
              <span className="font-mono">{formatRatio(shown.ratio)}</span>
              {shown.meetsAa ? (
                <>
                  <CheckCircleIcon aria-hidden="true" className="size-4" weight="fill" />
                  {t('studio.branding.brandColor.aaPass')}
                </>
              ) : (
                <>
                  <WarningIcon aria-hidden="true" className="size-4 text-destructive" />
                  <span className="text-destructive">{t('studio.branding.brandColor.aaFail')}</span>
                </>
              )}
            </dd>
          </dl>
        ) : null}
      </div>

      {shown !== null ? (
        <ul className="grid gap-2 text-sm sm:grid-cols-2" aria-live="polite">
          {(
            [
              ['onLight', shown.onLight],
              ['onDark', shown.onDark],
            ] as const
          ).map(([surface, value]) => (
            <li key={surface} className="flex items-start gap-2 rounded-lg border p-3">
              {value.use === 'text' ? (
                <CheckCircleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              ) : (
                <WarningIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              )}
              <span className="min-w-0">
                <span className="font-medium">
                  {t(`studio.branding.brandColor.${surface}`, { ratio: formatRatio(value.ratio) })}
                </span>
                <span className="block text-muted-foreground">{t(USE_KEYS[value.use])}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          void onSubmit(e);
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brand-color-input">{t('studio.branding.brandColor.input')}</Label>
          <Input
            id="brand-color-input"
            className="max-w-48 font-mono"
            value={draft}
            onChange={onColorChange}
            placeholder="#0EA5E9"
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={status.kind === 'error' || reading === null}
            aria-describedby={status.kind === 'error' ? 'brand-color-error' : undefined}
          />
        </div>
        {status.kind === 'error' ? (
          <p id="brand-color-error" role="alert" className="text-sm text-destructive">
            {status.message}
          </p>
        ) : null}
        {status.kind === 'success' ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('studio.branding.saveSuccess')}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={status.kind === 'saving' || unchanged || reading === null || !reading.meetsAa}
          >
            {status.kind === 'saving' ? t('studio.branding.saving') : t('studio.branding.save')}
          </Button>
          {!unchanged ? (
            <Button
              type="button"
              variant="outline"
              disabled={status.kind === 'saving'}
              onClick={() => {
                setDraft(color.toUpperCase());
                setStatus({ kind: 'idle' });
              }}
            >
              {t('common.cancel')}
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

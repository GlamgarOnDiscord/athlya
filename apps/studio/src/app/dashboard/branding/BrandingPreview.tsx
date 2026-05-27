/**
 * Brand color preview chip + sample CTA buttons + edit form (B9.2).
 *
 * Slice B9.2 wires the previously-disabled "Modifier" button to
 * `PATCH /v1/studios/me`. Pure client component — uses the
 * `useApiClient` hook so token refresh on 401 is handled by the
 * shared client.
 *
 * Why a separate file?
 * --------------------
 * The page itself is a Server Component (locale resolution +
 * static render). Dynamic brand colours use CSS variables set via
 * the CSSOM (`setProperty`) so production CSP does not rely on
 * `style=""` attributes in app code (issue #75).
 *
 * Validation flow
 * ---------------
 *   1. Client-side regex `/^#[0-9A-Fa-f]{6}$/` rejects malformed
 *      hex before the API call. Error surfaced as
 *      `branding.invalidHexError`.
 *   2. Server-side WCAG AA check (route handler in B9.2) maps to
 *      `branding.lowContrastError` when the API returns a 422 with
 *      `code: 'brand_color_low_contrast'`.
 *   3. Other errors fall back to `branding.saveError`.
 *
 * @see Requirement 13.2 (per-tenant branding), 15.2 (WCAG AA gate).
 */
'use client';

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

import { useApiClient } from '../../../lib/api/buildClient';
import { ApiError } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';

export interface BrandingPreviewProps {
  /** CSS hex color, e.g. `#0EA5E9`. */
  readonly color: string;
}

/**
 * Compute the contrast pairing (white or black) for a foreground on
 * the supplied background hex. Mirrors the WCAG 2.2 relative
 * luminance formula used by `@athlya/shared/theming`. Lightweight
 * inline copy to avoid pulling the package on this preview path.
 */
function contrastForeground(hex: string): '#FFFFFF' | '#000000' {
  const trimmed = hex.startsWith('#') ? hex.slice(1) : hex;
  if (trimmed.length !== 6) return '#FFFFFF';
  const r = parseInt(trimmed.slice(0, 2), 16) / 255;
  const g = parseInt(trimmed.slice(2, 4), 16) / 255;
  const b = parseInt(trimmed.slice(4, 6), 16) / 255;
  const lum = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
  return L > 0.179 ? '#000000' : '#FFFFFF';
}

const HEX_RE = /^#[0-9A-Fa-f]{6}$/u;

type Status =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

export function BrandingPreview({ color }: BrandingPreviewProps): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);

  const { accessToken } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);

  const [currentColor, setCurrentColor] = useState<string>(() => color);
  const [draft, setDraft] = useState<string>(() => color);
  const [editing, setEditing] = useState<boolean>(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const fg = useMemo(() => contrastForeground(currentColor), [currentColor]);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = previewRef.current;
    if (root === null) return;
    root.style.setProperty('--brand-bg', currentColor);
    root.style.setProperty('--brand-fg', fg);
  }, [currentColor, fg]);

  const onColorChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setDraft(e.target.value);
    setStatus({ kind: 'idle' });
  }, []);

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const next = draft.trim().toUpperCase();
      if (!HEX_RE.test(next)) {
        setStatus({
          kind: 'error',
          message: t('studio.branding.invalidHexError'),
        });
        return;
      }
      setStatus({ kind: 'saving' });
      try {
        await client.patch('/v1/studios/me', { brandColor: next });
        setCurrentColor(next);
        setStatus({ kind: 'success' });
        setEditing(false);
      } catch (err: unknown) {
        if (err instanceof ApiError && err.status === 422) {
          const code = err.problem?.code;
          if (code === 'brand_color_low_contrast') {
            setStatus({
              kind: 'error',
              message: t('studio.branding.lowContrastError'),
            });
            return;
          }
          setStatus({
            kind: 'error',
            message: t('studio.branding.invalidHexError'),
          });
          return;
        }
        setStatus({
          kind: 'error',
          message: t('studio.branding.saveError'),
        });
      }
    },
    [client, draft, t],
  );

  return (
    <div ref={previewRef} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <div
          aria-hidden="true"
          className="brand-preview-swatch size-12 rounded-full border border-border"
        />
        <div className="flex flex-col text-sm">
          <span className="font-mono text-base">{currentColor}</span>
          <span className="text-muted-foreground">
            {t('studio.branding.brandColor.contrast', {
              fg:
                fg === '#000000'
                  ? t('studio.branding.brandColor.fgBlack')
                  : t('studio.branding.brandColor.fgWhite'),
            })}
          </span>
        </div>
        <span className="brand-preview-sample ml-auto rounded-md px-4 py-2 text-sm font-medium">
          {t('studio.branding.brandColor.sampleButton')}
        </span>
      </div>

      {editing ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            void onSubmit(e);
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="brand-color-input">{t('studio.branding.brandColor.input')}</Label>
            <Input
              id="brand-color-input"
              value={draft}
              onChange={onColorChange}
              placeholder="#0EA5E9"
              pattern="^#[0-9A-Fa-f]{6}$"
              required
              aria-invalid={status.kind === 'error'}
              aria-describedby={status.kind === 'error' ? 'brand-color-error' : undefined}
            />
          </div>
          {status.kind === 'error' ? (
            <p id="brand-color-error" role="alert" className="text-sm text-destructive">
              {status.message}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={status.kind === 'saving'}>
              {status.kind === 'saving' ? t('studio.branding.saving') : t('studio.branding.save')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={status.kind === 'saving'}
              onClick={() => {
                setEditing(false);
                setDraft(currentColor);
                setStatus({ kind: 'idle' });
              }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={() => {
              setDraft(currentColor);
              setStatus({ kind: 'idle' });
              setEditing(true);
            }}
          >
            {t('studio.branding.edit')}
          </Button>
          {status.kind === 'success' ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t('studio.branding.saveSuccess')}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

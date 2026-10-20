/**
 * Member profile form — `PATCH /v1/members/me`.
 *
 * Renders the read-only `email`, an editable `displayName` (capped at
 * 80 chars client-side — Req 3.4) and an optional `avatarUrl`. The
 * submit path mirrors the Hono router's validation chain:
 *
 *   1. Client-side `UpdateProfileRequestSchema.safeParse(...)` with
 *      per-field error surfacing so obviously invalid inputs never
 *      leave the browser.
 *   2. `PATCH /v1/members/me` with a fresh `Idempotency-Key`.
 *   3. On 422 `validation_error` the server's `problem.errors[]` are
 *      re-mapped to the same `<span role="alert">` slots.
 *
 * Accessibility:
 *   - Every `<input>` is associated with its `<label>` via `htmlFor`.
 *   - Error messages use `role="alert"` + `aria-live="polite"` and
 *     are referenced by the input's `aria-describedby`.
 *
 * @see Requirements 3.1, 3.2, 3.4.
 */
'use client';

import { UpdateProfileRequestSchema } from '@athlya/shared/schemas/api';
import { UploadSimpleIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import Image from 'next/image';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

import { ApiError, type ApiClient } from '../../lib/api/client';
import { newIdempotencyKey } from '../../lib/idempotency';

import type { MeProfile } from './ProfileSection';
import type { Translator } from '../../lib/i18n/t';

export interface ProfileFormProps {
  readonly profile: MeProfile;
  readonly client: ApiClient;
  readonly t: Translator;
}

/** Success banner TTL — matches the pattern used elsewhere in the app. */
const SUCCESS_BANNER_MS = 3_000;

/** Client-side pre-flight cap — mirrors `AVATAR_MAX_BYTES` on the API. */
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export function ProfileForm({ profile, client, t }: ProfileFormProps): ReactElement {
  interface ProfileFormState {
    displayName: string;
    avatarUrl: string;
    /** Name of the last picture chosen, shown next to the picker. */
    avatarFileName: string | null;
    fieldErrors: Record<string, string>;
    genericError: string | null;
    pending: boolean;
    submittedAt: number | null;
  }

  const [form, setForm] = useState<ProfileFormState>(() => ({
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl ?? '',
    avatarFileName: null,
    fieldErrors: {},
    genericError: null,
    pending: false,
    submittedAt: null,
  }));

  const counterLabel = useMemo(
    () => t('profile.displayNameCounter', { count: form.displayName.length }),
    [form.displayName, t],
  );

  useEffect(() => {
    if (form.submittedAt === null) return undefined;
    const timer = setTimeout(() => {
      setForm((s) => ({ ...s, submittedAt: null }));
    }, SUCCESS_BANNER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [form.submittedAt]);

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setForm((s) => ({ ...s, fieldErrors: {}, genericError: null }));

      const payload = {
        displayName: form.displayName,
        ...(form.avatarUrl === '' ? {} : { avatarUrl: form.avatarUrl }),
      };

      const parsed = UpdateProfileRequestSchema.safeParse(payload);
      if (!parsed.success) {
        const next = Object.create(null) as Record<string, string>;
        for (const issue of parsed.error.issues) {
          const path = issue.path.join('.');
          if (next[path] === undefined) next[path] = issue.message;
        }
        setForm((s) => ({ ...s, fieldErrors: next }));
        return;
      }

      setForm((s) => ({ ...s, pending: true }));
      try {
        await client.patch('/v1/members/me', parsed.data, {
          headers: { 'Idempotency-Key': newIdempotencyKey() },
        });
        setForm((s) => ({ ...s, submittedAt: Date.now() }));
      } catch (err) {
        if (
          err instanceof ApiError &&
          err.problem?.code === 'validation_error' &&
          err.problem.errors !== undefined
        ) {
          const next = Object.create(null) as Record<string, string>;
          for (const e of err.problem.errors) {
            if (next[e.path] === undefined) next[e.path] = e.message;
          }
          setForm((s) => ({ ...s, fieldErrors: next }));
        } else {
          setForm((s) => ({ ...s, genericError: t('profile.updateError') }));
        }
      } finally {
        setForm((s) => ({ ...s, pending: false }));
      }
    },
    [form, client, t],
  );

  return (
    <section aria-label={t('profile.title')} className="flex flex-col gap-4">
      <form
        onSubmit={(e) => {
          void onSubmit(e);
        }}
        noValidate
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-email">{t('profile.email')}</Label>
          <Input
            id="profile-email"
            type="email"
            value={profile.email}
            readOnly
            className="bg-muted text-muted-foreground"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-display-name">{t('profile.displayName')}</Label>
          <Input
            id="profile-display-name"
            type="text"
            required
            maxLength={80}
            value={form.displayName}
            onChange={(e) => setForm((s) => ({ ...s, displayName: e.target.value }))}
            aria-describedby="profile-display-name-counter profile-display-name-error"
          />
          <span id="profile-display-name-counter" className="text-xs text-muted-foreground">
            {counterLabel}
          </span>
          {form.fieldErrors['displayName'] !== undefined ? (
            <span
              id="profile-display-name-error"
              role="alert"
              aria-live="polite"
              className="text-sm text-destructive"
            >
              {form.fieldErrors['displayName']}
            </span>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-avatar-file">{t('profile.avatar')}</Label>
          {form.avatarUrl !== '' ? (
            <Image
              src={form.avatarUrl}
              alt=""
              width={80}
              height={80}
              unoptimized
              className="size-20 rounded-full border border-border object-cover"
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <input
              id="profile-avatar-file"
              type="file"
              accept="image/png, image/jpeg, image/webp"
              disabled={form.pending}
              onChange={async (e) => {
                setForm((s) => {
                  const { avatarUrl: _omit, ...rest } = s.fieldErrors;
                  void _omit;
                  return { ...s, fieldErrors: rest };
                });
                const file = e.target.files?.[0];
                if (file === undefined) return;
                if (file.size > AVATAR_MAX_BYTES) {
                  setForm((s) => ({
                    ...s,
                    fieldErrors: {
                      ...s.fieldErrors,
                      avatarUrl: t('profile.avatarTooLarge', {
                        max: Math.floor(AVATAR_MAX_BYTES / (1024 * 1024)),
                      }),
                    },
                  }));
                  e.target.value = '';
                  return;
                }
                setForm((s) => ({ ...s, avatarFileName: file.name, pending: true }));
                try {
                  const result = await client.put<{ avatarUrl: string }>(
                    '/v1/members/me/avatar',
                    file,
                    { headers: { 'Content-Type': file.type } },
                  );
                  setForm((s) => ({ ...s, avatarUrl: result.avatarUrl, pending: false }));
                } catch {
                  setForm((s) => ({
                    ...s,
                    pending: false,
                    fieldErrors: {
                      ...s.fieldErrors,
                      avatarUrl: t('profile.avatarUploadError'),
                    },
                  }));
                }
              }}
              aria-describedby="profile-avatar-file-hint profile-avatar-url-error"
              className="peer sr-only"
            />
            <label
              htmlFor="profile-avatar-file"
              className={cn(
                buttonVariants({ variant: 'outline', size: 'sm' }),
                'cursor-pointer peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background peer-disabled:pointer-events-none peer-disabled:opacity-50',
              )}
            >
              <UploadSimpleIcon aria-hidden="true" />
              {t('profile.avatarChoose')}
            </label>
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {form.avatarFileName ?? t('profile.avatarNoFile')}
            </span>
          </div>
          <span id="profile-avatar-file-hint" className="text-xs text-muted-foreground">
            {t('profile.avatarHint', {
              max: Math.floor(AVATAR_MAX_BYTES / (1024 * 1024)),
            })}
          </span>
          {form.avatarUrl !== '' ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="self-start px-0 text-muted-foreground"
              onClick={() => setForm((s) => ({ ...s, avatarUrl: '' }))}
            >
              {t('profile.avatarRemove')}
            </Button>
          ) : null}
          {form.fieldErrors['avatarUrl'] !== undefined ? (
            <span
              id="profile-avatar-url-error"
              role="alert"
              aria-live="polite"
              className="text-sm text-destructive"
            >
              {form.fieldErrors['avatarUrl']}
            </span>
          ) : null}
        </div>

        {form.genericError !== null ? (
          <span role="alert" aria-live="polite" className="text-sm text-destructive">
            {form.genericError}
          </span>
        ) : null}

        {form.submittedAt !== null ? (
          <output aria-live="polite" className="text-sm text-emerald-600 dark:text-emerald-400">
            {t('profile.updateSuccess')}
          </output>
        ) : null}

        <Button type="submit" disabled={form.pending} className="self-start">
          {t('profile.save')}
        </Button>
      </form>
    </section>
  );
}

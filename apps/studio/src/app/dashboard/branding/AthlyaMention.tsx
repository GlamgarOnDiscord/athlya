/**
 * Athlya mention of the studio's e-mails: issue #761.
 *
 * One checkbox saved through `PATCH /v1/studios/me`
 * (`hideAthlyaBranding`). Checked, the transactional e-mails end with
 * "Sent by {studio}" instead of "Sent by {studio} via Athlya".
 */
'use client';

import { useId, useState, type ReactElement } from 'react';

import { newIdempotencyKey } from '../../../lib/idempotency';

import type { ApiClient } from '../../../lib/api/client';
import type { Translator } from '../../../lib/i18n/t';
import type { StudioMeResponse } from '@athlya/shared/schemas/api';

export interface AthlyaMentionProps {
  readonly hidden: boolean;
  readonly client: ApiClient;
  readonly t: Translator;
  readonly onSaved: (studio: StudioMeResponse) => void;
}

type Status = 'idle' | 'saving' | 'saved' | 'error';

export function AthlyaMention({ hidden, client, t, onSaved }: AthlyaMentionProps): ReactElement {
  const id = useId();
  const [status, setStatus] = useState<Status>('idle');

  const save = async (next: boolean) => {
    setStatus('saving');
    try {
      onSaved(
        await client.patch<StudioMeResponse>(
          '/v1/studios/me',
          { hideAthlyaBranding: next },
          { headers: { 'Idempotency-Key': newIdempotencyKey() } },
        ),
      );
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="flex items-start gap-3 text-sm">
        <input
          id={id}
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 accent-primary"
          checked={hidden}
          disabled={status === 'saving'}
          aria-describedby={`${id}-help`}
          onChange={(e) => {
            void save(e.target.checked);
          }}
        />
        <span className="font-medium">{t('studio.branding.mention.label')}</span>
      </label>
      <p id={`${id}-help`} className="text-sm text-muted-foreground">
        {hidden ? t('studio.branding.mention.hiddenHelp') : t('studio.branding.mention.shownHelp')}
      </p>
      {status === 'saved' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('studio.branding.saveSuccess')}
        </p>
      ) : null}
      {status === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {t('studio.branding.saveError')}
        </p>
      ) : null}
    </div>
  );
}

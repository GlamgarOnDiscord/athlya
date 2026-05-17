'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState, type ReactElement } from 'react';

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

import { type ApiClient } from '../../../lib/api/client';
import { useApiClient } from '../../../lib/api/use-api-client';
import { setAccessToken } from '../../../lib/auth/token-store';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../../lib/i18n/t';
import { newIdempotencyKey } from '../../../lib/idempotency';

export interface DeletePanelProps {
  readonly t?: Translator;
  readonly client?: ApiClient;
}

type Status = 'idle' | 'pending' | 'error';

export function DeletePanel({ t: tProp, client: clientProp }: DeletePanelProps): ReactElement {
  const { push } = useRouter();
  const locale = useLocale();
  const t: Translator = useMemo(() => tProp ?? createTranslator(locale), [tProp, locale]);

  const client = useApiClient(clientProp);

  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [status, setStatus] = useState<Status>('idle');
  const [confirmText, setConfirmText] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const confirmWord = t('rgpd.delete.confirmWord');

  const openModal = useCallback(() => {
    setConfirmText('');
    setErrorMsg(null);
    setStatus('idle');
    setIsOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    setIsOpen(false);
  }, []);

  const canConfirm = confirmText === confirmWord && status !== 'pending';

  const onConfirm = useCallback(async () => {
    if (!canConfirm) return;
    setStatus('pending');
    setErrorMsg(null);
    try {
      await client.del('/v1/auth/me', {
        headers: { 'Idempotency-Key': newIdempotencyKey() },
      });
      setAccessToken(null);
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } catch {
        // cookie will expire
      }
      push('/');
    } catch {
      setErrorMsg(t('errors.generic'));
      setStatus('error');
    }
  }, [canConfirm, client, push, t]);

  const instructionId = 'delete-modal-instruction';

  return (
    <section aria-label={t('rgpd.delete.title')} className="flex flex-col gap-4">
      <Button variant="destructive" className="self-start" onClick={openModal}>
        {t('rgpd.delete.confirm')}
      </Button>

      <Dialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!open && status !== 'pending') closeModal();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('rgpd.delete.modalTitle')}</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">{t('rgpd.delete.warning')}</p>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="delete-confirm-input" id={instructionId}>
                {t('rgpd.delete.confirmInstruction', { word: confirmWord })}
              </Label>
              <Input
                id="delete-confirm-input"
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                autoComplete="off"
                aria-describedby={instructionId}
              />
            </div>

            {errorMsg !== null ? (
              <span role="alert" aria-live="polite" className="text-sm text-destructive">
                {errorMsg}
              </span>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeModal} disabled={status === 'pending'}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                void onConfirm();
              }}
              disabled={!canConfirm}
            >
              {t('rgpd.delete.confirmButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

import { useRouter } from 'expo-router';

import { useSessionStore } from './AppSession';
import { useRuntime } from './RuntimeProvider';
import { Button } from './ui/Button';
import { Notice } from './ui/Notice';

import type { ErrorModel } from '../features/errors';

/**
 * Error message with the way out it needs: a "sign in" action when the
 * session is gone (the stored session may have been cleared by a rejected
 * refresh, so the gate state is re-read first).
 */
export function ErrorNotice({ error }: { readonly error: ErrorModel }) {
  const { t } = useRuntime();
  const session = useSessionStore();
  const router = useRouter();
  return (
    <>
      <Notice tone="error" message={t(error.key)} />
      {error.authRequired ? (
        <Button
          title={t('mobile.errors.signIn')}
          variant="secondary"
          onPress={() => {
            // Replace, so Back cannot return to the protected screen.
            void session
              .refresh()
              .catch(() => undefined)
              .finally(() => {
                router.replace('/login');
              });
          }}
        />
      ) : null}
    </>
  );
}

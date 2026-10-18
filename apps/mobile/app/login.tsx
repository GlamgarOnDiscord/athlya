import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { useSessionStore } from '../components/AppSession';
import { useRuntime } from '../components/RuntimeProvider';
import { AppText } from '../components/ui/AppText';
import { Button } from '../components/ui/Button';
import { Notice } from '../components/ui/Notice';
import { ScrollScreen } from '../components/ui/ScrollScreen';
import { TextField } from '../components/ui/TextField';
import { signIn, type AuthResult } from '../features/auth/auth';

export default function LoginScreen() {
  const runtime = useRuntime();
  const { t } = runtime;
  const session = useSessionStore();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<AuthResult, { ok: false }> | null>(null);
  const inflight = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      inflight.current?.abort();
    },
    [],
  );

  const submit = () => {
    const controller = new AbortController();
    inflight.current = controller;
    setBusy(true);
    setFailure(null);
    signIn(runtime, { email, password }, controller.signal)
      .then(async (result) => {
        if (!result.ok) {
          setFailure(result);
          return;
        }
        await session.refresh();
        router.replace('/');
      })
      .catch(() => {
        // Cancelled because the screen went away.
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
  };

  const fieldError = (field: string): string | null => {
    const key = failure?.fieldErrors[field];
    return key === undefined ? null : t(key);
  };

  return (
    <ScrollScreen>
      <AppText variant="title">{t('mobile.auth.login.title')}</AppText>
      <TextField
        label={t('auth.login.email')}
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoComplete="email"
        textContentType="username"
        error={fieldError('email')}
      />
      <TextField
        label={t('auth.login.password')}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        error={fieldError('password')}
      />
      {failure?.error ? <Notice tone="error" message={t(failure.error.key)} /> : null}
      <Button title={t('mobile.auth.login.submit')} busy={busy} onPress={submit} />
      <Button
        title={t('mobile.auth.login.toRegister')}
        variant="secondary"
        disabled={busy}
        onPress={() => {
          router.push('/register');
        }}
      />
    </ScrollScreen>
  );
}

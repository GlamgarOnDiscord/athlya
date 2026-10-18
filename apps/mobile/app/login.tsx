import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { useSessionStore } from '../components/AppSession';
import { useRuntime } from '../components/RuntimeProvider';
import { TurnstileChallenge, useTurnstileChallenge } from '../components/TurnstileChallenge';
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
  const challenge = useTurnstileChallenge();

  useEffect(
    () => () => {
      inflight.current?.abort();
    },
    [],
  );

  const submit = () => {
    const turnstileToken = challenge.token;
    if (turnstileToken === null) return;
    const controller = new AbortController();
    inflight.current = controller;
    setBusy(true);
    setFailure(null);
    signIn(runtime, { email, password, turnstileToken }, controller.signal)
      .then(async (result) => {
        if (!result.ok) {
          setFailure(result);
          // The API saw the token, which is single-use: ask for a new one.
          if (result.error !== null) challenge.reset();
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
      <TurnstileChallenge controller={challenge} />
      <Button
        title={t('mobile.auth.login.submit')}
        busy={busy}
        disabled={challenge.token === null}
        {...(challenge.token === null
          ? { accessibilityHint: t('mobile.auth.turnstile.required') }
          : {})}
        onPress={submit}
      />
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

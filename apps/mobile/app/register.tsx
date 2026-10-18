import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { useSessionStore } from '../components/AppSession';
import { useRuntime } from '../components/RuntimeProvider';
import { AppText } from '../components/ui/AppText';
import { Button } from '../components/ui/Button';
import { Notice } from '../components/ui/Notice';
import { ScrollScreen } from '../components/ui/ScrollScreen';
import { TextField } from '../components/ui/TextField';
import { ToggleRow } from '../components/ui/ToggleRow';
import { register, type AuthResult, type RegisterInput } from '../features/auth/auth';

type Consents = RegisterInput['consents'];

const NO_CONSENT: Consents = { marketing: false, analytics: false, thirdParty: false };

export default function RegisterScreen() {
  const runtime = useRuntime();
  const { t } = runtime;
  const session = useSessionStore();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [studioSlug, setStudioSlug] = useState('');
  const [consents, setConsents] = useState<Consents>(NO_CONSENT);
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
    register(runtime, { email, password, displayName, studioSlug, consents }, controller.signal)
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

  const consentToggle = (key: keyof Consents, label: string) => (
    <ToggleRow
      label={label}
      value={consents[key]}
      onValueChange={(value) => {
        setConsents((current) => ({ ...current, [key]: value }));
      }}
    />
  );

  return (
    <ScrollScreen>
      <AppText variant="title">{t('mobile.auth.register.title')}</AppText>
      <TextField
        label={t('auth.register.displayName')}
        value={displayName}
        onChangeText={setDisplayName}
        autoCapitalize="words"
        autoComplete="name"
        textContentType="name"
        error={fieldError('displayName')}
      />
      <TextField
        label={t('auth.register.email')}
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoComplete="email"
        textContentType="username"
        error={fieldError('email')}
      />
      <TextField
        label={t('auth.register.password')}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        error={fieldError('password')}
      />
      <TextField
        label={t('auth.register.studioSlug')}
        hint={t('mobile.auth.register.studioSlugHint')}
        value={studioSlug}
        onChangeText={setStudioSlug}
        error={fieldError('studioSlug')}
      />
      <AppText variant="muted">{t('auth.register.consents.legend')}</AppText>
      {consentToggle('marketing', t('auth.register.consents.marketing'))}
      {consentToggle('analytics', t('auth.register.consents.analytics'))}
      {consentToggle('thirdParty', t('auth.register.consents.thirdParty'))}
      {failure?.error ? <Notice tone="error" message={t(failure.error.key)} /> : null}
      <Button title={t('mobile.auth.register.submit')} busy={busy} onPress={submit} />
      <Button
        title={t('mobile.auth.register.toLogin')}
        variant="secondary"
        disabled={busy}
        onPress={() => {
          router.replace('/login');
        }}
      />
    </ScrollScreen>
  );
}

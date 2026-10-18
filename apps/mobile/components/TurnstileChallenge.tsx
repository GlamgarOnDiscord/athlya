import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Linking, View, useColorScheme } from 'react-native';
import { WebView, type WebViewMessageEvent, type WebViewProps } from 'react-native-webview';

import {
  INITIAL_CHALLENGE_STATE,
  challengeNotice,
  challengeToken,
  challengeUrl,
  isAllowedNavigation,
  parseChallengeMessage,
  reduceChallenge,
  shouldOpenExternally,
  type ChallengeEvent,
  type ChallengeState,
} from '../features/auth/turnstile';

import { useRuntime } from './RuntimeProvider';
import { AppText } from './ui/AppText';
import { Button } from './ui/Button';
import { Notice } from './ui/Notice';

type ShouldStartLoadRequest = Parameters<
  NonNullable<WebViewProps['onShouldStartLoadWithRequest']>
>[0];

/** Height of Turnstile's flexible widget (65 px) plus a small margin. */
const WIDGET_HEIGHT = 72;

export interface TurnstileChallengeController {
  readonly state: ChallengeState;
  /** The current single-use token, or `null` while none is available. */
  readonly token: string | null;
  /** Bumped on every reset; remounts the WebView for a fresh challenge. */
  readonly attempt: number;
  readonly dispatch: (event: ChallengeEvent) => void;
  /** Starts a new challenge: after a failure, and after each submit (tokens are single-use). */
  readonly reset: () => void;
}

export function useTurnstileChallenge(): TurnstileChallengeController {
  const [state, dispatch] = useReducer(reduceChallenge, INITIAL_CHALLENGE_STATE);
  const [attempt, setAttempt] = useState(0);
  const reset = useCallback(() => {
    dispatch({ type: 'reset' });
    setAttempt((current) => current + 1);
  }, []);
  return { state, token: challengeToken(state), attempt, dispatch, reset };
}

/**
 * Cloudflare Turnstile widget for the sign-in and registration screens
 * (issue #649): the API's challenge page in a WebView, its status
 * announced through a `Notice`, and a retry button when it fails.
 */
export function TurnstileChallenge({
  controller,
}: {
  readonly controller: TurnstileChallengeController;
}) {
  const { apiBaseUrl, locale, t } = useRuntime();
  const theme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const source = useMemo(
    () => ({ uri: challengeUrl(apiBaseUrl, locale, theme) }),
    [apiBaseUrl, locale, theme],
  );
  const { dispatch, reset, state, attempt } = controller;

  // A new source (theme or locale change) reloads the WebView, which drops
  // the widget and its token: start a fresh challenge so a stale token is
  // never sent.
  const renderedUri = useRef(source.uri);
  useEffect(() => {
    if (renderedUri.current === source.uri) return;
    renderedUri.current = source.uri;
    reset();
  }, [source.uri, reset]);
  const notice = challengeNotice(state);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const parsed = parseChallengeMessage(
        event.nativeEvent.data,
        event.nativeEvent.url,
        apiBaseUrl,
      );
      if (parsed !== null) dispatch(parsed);
    },
    [apiBaseUrl, dispatch],
  );

  const onShouldStartLoadWithRequest = useCallback(
    (request: ShouldStartLoadRequest) => {
      if (isAllowedNavigation(request.url, apiBaseUrl)) return true;
      if (shouldOpenExternally(request.url, request.isTopFrame)) {
        Linking.openURL(request.url).catch(() => undefined);
      }
      return false;
    },
    [apiBaseUrl],
  );

  const onLoadFailed = useCallback(() => {
    dispatch({ type: 'load-failed' });
  }, [dispatch]);

  return (
    <View className="gap-sm">
      <AppText variant="muted">{t('mobile.auth.turnstile.label')}</AppText>
      <View style={{ height: WIDGET_HEIGHT }}>
        <WebView
          key={attempt}
          source={source}
          accessibilityLabel={t('mobile.auth.turnstile.frameLabel')}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          onError={onLoadFailed}
          onHttpError={onLoadFailed}
          javaScriptEnabled
          domStorageEnabled
          setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically={false}
          allowFileAccess={false}
          allowsLinkPreview={false}
          mixedContentMode="never"
          scrollEnabled={false}
          bounces={false}
          style={{ backgroundColor: 'transparent' }}
        />
      </View>
      <Notice tone={notice.tone} message={t(notice.key)} />
      {notice.retry ? (
        <Button
          title={t('mobile.auth.turnstile.retry')}
          accessibilityHint={t('mobile.auth.turnstile.retryHint')}
          variant="secondary"
          onPress={reset}
        />
      ) : null}
    </View>
  );
}

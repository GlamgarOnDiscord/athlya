import { describe, expect, it } from 'vitest';

import {
  INITIAL_CHALLENGE_STATE,
  challengeNotice,
  challengeToken,
  challengeUrl,
  isAllowedNavigation,
  isChallengePage,
  isExternalLink,
  parseChallengeMessage,
  reduceChallenge,
  shouldOpenExternally,
  type ChallengeEvent,
  type ChallengeState,
} from '../../features/auth/turnstile';

const API = 'https://api.athlya.test';
const PAGE = `${API}/v1/auth/turnstile-challenge?lang=fr&theme=light`;

function run(events: readonly ChallengeEvent[]): ChallengeState {
  return events.reduce(reduceChallenge, INITIAL_CHALLENGE_STATE);
}

describe('challengeUrl', () => {
  it('points at the API challenge page with the locale and theme', () => {
    expect(challengeUrl(API, 'en', 'dark')).toBe(
      `${API}/v1/auth/turnstile-challenge?lang=en&theme=dark`,
    );
    expect(challengeUrl('http://10.0.2.2:8787', 'fr', 'light')).toBe(
      'http://10.0.2.2:8787/v1/auth/turnstile-challenge?lang=fr&theme=light',
    );
  });
});

describe('parseChallengeMessage', () => {
  it('accepts the messages posted by the challenge page', () => {
    expect(parseChallengeMessage('{"type":"ready"}', PAGE, API)).toEqual({ type: 'ready' });
    expect(parseChallengeMessage('{"type":"token","token":"t-1"}', PAGE, API)).toEqual({
      type: 'token',
      token: 't-1',
    });
    expect(parseChallengeMessage('{"type":"expired"}', PAGE, API)).toEqual({ type: 'expired' });
    expect(parseChallengeMessage('{"type":"timeout"}', PAGE, API)).toEqual({ type: 'timeout' });
    expect(parseChallengeMessage('{"type":"error","code":"110200"}', PAGE, API)).toEqual({
      type: 'error',
      code: '110200',
    });
  });

  it('drops messages from any other page', () => {
    const data = '{"type":"token","token":"t-1"}';
    expect(parseChallengeMessage(data, 'https://evil.test/v1/auth/turnstile-challenge', API)).toBe(
      null,
    );
    expect(parseChallengeMessage(data, `${API}/v1/other`, API)).toBeNull();
    expect(parseChallengeMessage(data, 'not a url', API)).toBeNull();
  });

  it('drops malformed messages', () => {
    expect(parseChallengeMessage('not json', PAGE, API)).toBeNull();
    expect(parseChallengeMessage('{"type":"token","token":""}', PAGE, API)).toBeNull();
    expect(parseChallengeMessage('{"type":"token"}', PAGE, API)).toBeNull();
    expect(parseChallengeMessage('{"type":"reset"}', PAGE, API)).toBeNull();
    expect(parseChallengeMessage('{"type":"load-failed"}', PAGE, API)).toBeNull();
    expect(parseChallengeMessage('null', PAGE, API)).toBeNull();
  });
});

describe('navigation policy', () => {
  it('keeps the WebView on the challenge page and Cloudflare frames', () => {
    expect(isChallengePage(PAGE, API)).toBe(true);
    expect(isAllowedNavigation(PAGE, API)).toBe(true);
    expect(
      isAllowedNavigation('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x', API),
    ).toBe(true);
    expect(isAllowedNavigation('about:blank', API)).toBe(true);
  });

  it('refuses every other destination', () => {
    expect(isAllowedNavigation(`${API}/v1/members/me`, API)).toBe(false);
    expect(isAllowedNavigation('https://www.cloudflare.com/privacypolicy/', API)).toBe(false);
    expect(isAllowedNavigation('https://challenges.cloudflare.com.evil.test/', API)).toBe(false);
    expect(isAllowedNavigation('javascript:alert(1)', API)).toBe(false);
    expect(isAllowedNavigation('garbage', API)).toBe(false);
  });

  it('opens only https links in the system browser', () => {
    expect(isExternalLink('https://www.cloudflare.com/privacypolicy/')).toBe(true);
    expect(isExternalLink('http://example.test')).toBe(false);
    expect(isExternalLink('intent://scan')).toBe(false);
    expect(isExternalLink('garbage')).toBe(false);
  });
});

describe('shouldOpenExternally', () => {
  const link = 'https://www.cloudflare.com/privacypolicy/';

  it('opens top-frame links, including Android where isTopFrame is missing', () => {
    expect(shouldOpenExternally(link, true)).toBe(true);
    expect(shouldOpenExternally(link, undefined)).toBe(true);
  });

  it('never opens nested-frame navigations or non-https links', () => {
    expect(shouldOpenExternally(link, false)).toBe(false);
    expect(shouldOpenExternally('intent://scan', undefined)).toBe(false);
  });
});

describe('reduceChallenge', () => {
  it('goes from loading to pending to verified', () => {
    expect(INITIAL_CHALLENGE_STATE).toEqual({ status: 'loading' });
    expect(run([{ type: 'ready' }])).toEqual({ status: 'pending' });
    const verified = run([{ type: 'ready' }, { type: 'token', token: 't-1' }]);
    expect(verified).toEqual({ status: 'verified', token: 't-1' });
    expect(challengeToken(verified)).toBe('t-1');
  });

  it('does not let a late ready event drop a token', () => {
    expect(run([{ type: 'token', token: 't-1' }, { type: 'ready' }])).toEqual({
      status: 'verified',
      token: 't-1',
    });
  });

  it('clears the token on expiry and takes the refreshed one', () => {
    const expired = run([{ type: 'token', token: 't-1' }, { type: 'expired' }]);
    expect(expired).toEqual({ status: 'expired' });
    expect(challengeToken(expired)).toBeNull();
    expect(reduceChallenge(expired, { type: 'token', token: 't-2' })).toEqual({
      status: 'verified',
      token: 't-2',
    });
  });

  it('fails on widget errors, timeouts and page load failures', () => {
    for (const event of [
      { type: 'error', code: '300030' },
      { type: 'timeout' },
      { type: 'load-failed' },
    ] as const) {
      const state = run([{ type: 'token', token: 't-1' }, event]);
      expect(state).toEqual({ status: 'failed' });
      expect(challengeToken(state)).toBeNull();
    }
  });

  it('starts over on reset', () => {
    expect(run([{ type: 'token', token: 't-1' }, { type: 'reset' }])).toEqual(
      INITIAL_CHALLENGE_STATE,
    );
    expect(run([{ type: 'error', code: 'x' }, { type: 'reset' }])).toEqual(INITIAL_CHALLENGE_STATE);
  });
});

describe('challengeNotice', () => {
  it('maps every state to a translated status, with a retry only on failure', () => {
    expect(challengeNotice({ status: 'loading' })).toEqual({
      key: 'mobile.auth.turnstile.pending',
      tone: 'info',
      retry: false,
    });
    expect(challengeNotice({ status: 'pending' }).key).toBe('mobile.auth.turnstile.pending');
    expect(challengeNotice({ status: 'verified', token: 't' })).toEqual({
      key: 'mobile.auth.turnstile.verified',
      tone: 'info',
      retry: false,
    });
    expect(challengeNotice({ status: 'expired' })).toEqual({
      key: 'mobile.auth.turnstile.expired',
      tone: 'info',
      retry: false,
    });
    expect(challengeNotice({ status: 'failed' })).toEqual({
      key: 'mobile.auth.turnstile.failed',
      tone: 'error',
      retry: true,
    });
  });
});

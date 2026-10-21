/**
 * Calendar feed tokens (issue #719): signature, tampering, version and
 * key binding.
 */

import { describe, expect, it } from 'vitest';

import {
  buildCalendarFeedUrls,
  isCalendarFeedKeyConfigured,
  signCalendarFeedToken,
  verifyCalendarFeedToken,
} from '../../adapters/calendar-feed-token.js';
import { fromBase64Url, toBase64Url } from '../../adapters/export-download.js';

const SECRET = 'calendar-feed-test-key-0123456789abcdef';
const OTHER_SECRET = 'another-calendar-feed-key-0123456789abcd';

const SUBJECT = {
  memberId: '11111111-1111-4111-8111-111111111111',
  studioId: '22222222-2222-4222-8222-222222222222',
  credentialsVersion: 3,
};

/** Flip the second-to-last character: the last one carries ignored padding bits. */
function flipLastChar(value: string): string {
  const i = value.length - 2;
  const replacement = value[i] === 'A' ? 'B' : 'A';
  return `${value.slice(0, i)}${replacement}${value.slice(i + 1)}`;
}

describe('calendar feed token', () => {
  it('round-trips the subject', async () => {
    const token = await signCalendarFeedToken(SECRET, SUBJECT);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
    await expect(verifyCalendarFeedToken(SECRET, token)).resolves.toEqual(SUBJECT);
  });

  it('is deterministic for one subject and differs per version', async () => {
    const a = await signCalendarFeedToken(SECRET, SUBJECT);
    const b = await signCalendarFeedToken(SECRET, SUBJECT);
    const c = await signCalendarFeedToken(SECRET, { ...SUBJECT, credentialsVersion: 4 });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it('rejects a token signed with another key (rotation revokes every feed)', async () => {
    const token = await signCalendarFeedToken(OTHER_SECRET, SUBJECT);
    await expect(verifyCalendarFeedToken(SECRET, token)).resolves.toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const token = await signCalendarFeedToken(SECRET, SUBJECT);
    await expect(verifyCalendarFeedToken(SECRET, flipLastChar(token))).resolves.toBeNull();
  });

  it('rejects a payload swapped to another member under the original signature', async () => {
    const token = await signCalendarFeedToken(SECRET, SUBJECT);
    const [, mac] = token.split('.') as [string, string];
    const forged = toBase64Url(
      new TextEncoder().encode(
        `v1.33333333-3333-4333-8333-333333333333.${SUBJECT.studioId}.${SUBJECT.credentialsVersion}`,
      ),
    );
    await expect(verifyCalendarFeedToken(SECRET, `${forged}.${mac}`)).resolves.toBeNull();
  });

  it('binds the payload it signs to the expected layout', async () => {
    const token = await signCalendarFeedToken(SECRET, SUBJECT);
    const [payload] = token.split('.') as [string, string];
    const decoded = fromBase64Url(payload);
    expect(decoded).not.toBeNull();
    expect(new TextDecoder().decode(decoded ?? new Uint8Array())).toBe(
      `v1.${SUBJECT.memberId}.${SUBJECT.studioId}.3`,
    );
  });

  it.each([
    '',
    'no-dot',
    'a.b.c',
    '.',
    '!!!.???',
    `${'A'.repeat(300)}.${'B'.repeat(43)}`,
    'dGVzdA.c2hvcnQ',
  ])('rejects the malformed token %j', async (token) => {
    await expect(verifyCalendarFeedToken(SECRET, token)).resolves.toBeNull();
  });

  it('only accepts keys of at least 32 characters', () => {
    expect(isCalendarFeedKeyConfigured(undefined)).toBe(false);
    expect(isCalendarFeedKeyConfigured('short')).toBe(false);
    expect(isCalendarFeedKeyConfigured('x'.repeat(32))).toBe(true);
  });

  it('builds https and webcal URLs carrying the token as a query parameter', () => {
    const urls = buildCalendarFeedUrls('https://api.athlya.app', 'abc.def');
    expect(urls).toEqual({
      httpsUrl: 'https://api.athlya.app/v1/calendar/feed.ics?token=abc.def',
      webcalUrl: 'webcal://api.athlya.app/v1/calendar/feed.ics?token=abc.def',
    });
  });
});

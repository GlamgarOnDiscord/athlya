/**
 * Unit tests for the login anomaly detector
 * (Sprint 12 / Slice 12.8, Epic B3.4).
 */

import { describe, expect, it } from 'vitest';

import {
  classifyUserAgent,
  detectLoginAnomaly,
  type LoginSignal,
  type UaFamily,
} from '../login-anomaly.js';

/* ------------------------------------------------------------------ */
/*  classifyUserAgent — UA bucket                                        */
/* ------------------------------------------------------------------ */

describe('classifyUserAgent', () => {
  const cases: Array<[string | undefined, UaFamily]> = [
    // Bot patterns first.
    ['Googlebot/2.1', 'bot'],
    ['curl/8.7.1', 'bot'],
    ['python-requests/2.31', 'bot'],
    // Mobile takes precedence over Chrome / Safari.
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'mobile',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'mobile',
    ],
    // Desktop browsers.
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0',
      'edge',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0', 'firefox'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'chrome',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      'safari',
    ],
    // Fallbacks.
    ['', 'other'],
    [undefined, 'other'],
    ['Some unknown user agent', 'other'],
  ];

  for (const [ua, expected] of cases) {
    it(`returns ${expected} for ${String(ua).slice(0, 40)}…`, () => {
      expect(classifyUserAgent(ua)).toBe(expected);
    });
  }
});

/* ------------------------------------------------------------------ */
/*  detectLoginAnomaly                                                   */
/* ------------------------------------------------------------------ */

describe('detectLoginAnomaly', () => {
  const FR_CHROME: LoginSignal = { country: 'FR', uaFamily: 'chrome' };

  it('returns null on first login ever (no baseline)', () => {
    const result = detectLoginAnomaly({
      currentCountry: 'FR',
      currentUserAgent: 'Chrome/120',
      previous: null,
    });
    expect(result).toBeNull();
  });

  it('returns null when both dimensions match the baseline', () => {
    const result = detectLoginAnomaly({
      currentCountry: 'FR',
      currentUserAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      previous: FR_CHROME,
    });
    expect(result).toBeNull();
  });

  it('returns an anomaly when country changes', () => {
    const result = detectLoginAnomaly({
      currentCountry: 'US',
      currentUserAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      previous: FR_CHROME,
    });
    expect(result).not.toBeNull();
    expect(result?.country).toBe('US');
    expect(result?.previousCountry).toBe('FR');
    expect(result?.uaFamily).toBe('chrome');
    expect(result?.previousUaFamily).toBe('chrome');
  });

  it('returns an anomaly when UA family changes', () => {
    const result = detectLoginAnomaly({
      currentCountry: 'FR',
      currentUserAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
      previous: FR_CHROME,
    });
    expect(result).not.toBeNull();
    expect(result?.uaFamily).toBe('firefox');
    expect(result?.previousUaFamily).toBe('chrome');
    expect(result?.country).toBe('FR');
  });

  it('returns an anomaly when both dimensions change', () => {
    const result = detectLoginAnomaly({
      currentCountry: 'JP',
      currentUserAgent: 'Mozilla/5.0 (iPhone) Mobile/Safari',
      previous: FR_CHROME,
    });
    expect(result).not.toBeNull();
    expect(result?.country).toBe('JP');
    expect(result?.uaFamily).toBe('mobile');
  });

  it('skips detection when current country is XX (dev mode)', () => {
    const result = detectLoginAnomaly({
      currentCountry: 'XX',
      currentUserAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
      previous: FR_CHROME,
    });
    expect(result).toBeNull();
  });

  it('skips detection when previous country is XX (dev baseline)', () => {
    const result = detectLoginAnomaly({
      currentCountry: 'US',
      currentUserAgent: 'Chrome/120',
      previous: { country: 'XX', uaFamily: 'chrome' },
    });
    expect(result).toBeNull();
  });

  it('normalises country case + invalid input to XX', () => {
    // lowercase is normalised to upper case → matches FR.
    const result = detectLoginAnomaly({
      currentCountry: 'fr',
      currentUserAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      previous: FR_CHROME,
    });
    expect(result).toBeNull();
  });

  it('treats malformed country (3 chars) as XX → skips', () => {
    const result = detectLoginAnomaly({
      currentCountry: 'FRA',
      currentUserAgent: 'Chrome/120',
      previous: FR_CHROME,
    });
    // 'FRA' → 'XX' → skip.
    expect(result).toBeNull();
  });
});

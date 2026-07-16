/**
 * Unit tests for `scripts/_guard.mjs` (issue #509).
 *
 * Guards never import postgres — they must reject a production-shaped URL
 * _before_ any SQL runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// guardConnectionString calls process.exit() on failure.
// Spy on it so we can assert the call without terminating the test runner.
const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
  throw new Error(`process.exit called with ${_code}`);
});

// Silence console noise inside tests.
const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

// Import after mocking process.exit so the module-level code (if any) is safe.
const { guardConnectionString } = await import('../scripts/_guard.mjs');

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const original: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    original[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

beforeEach(() => {
  exitSpy.mockClear();
  errSpy.mockClear();
  warnSpy.mockClear();
});

afterEach(() => {
  delete process.env.ATHLYA_ALLOW_DANGEROUS_WRITE;
  delete process.env.ATHLYA_DESTRUCTIVE;
});

describe('guardConnectionString — local hosts (safe)', () => {
  const localUrls = [
    'postgresql://user:pass@localhost/dev',
    'postgresql://user:pass@127.0.0.1/dev',
    'postgresql://user:pass@[::1]/dev',
    'postgresql://user:pass@postgres/dev',
    'postgresql://user:pass@db/dev',
  ];

  for (const url of localUrls) {
    it(`allows ${new URL(url).hostname}`, () => {
      withEnv({ ATHLYA_DESTRUCTIVE: undefined, ATHLYA_ALLOW_DANGEROUS_WRITE: undefined }, () => {
        expect(() => guardConnectionString(url)).not.toThrow();
        expect(exitSpy).not.toHaveBeenCalled();
      });
    });
  }
});

describe('guardConnectionString — production-shaped URLs (blocked)', () => {
  const prodUrls = [
    'postgresql://user:pass@neon.tech/db',
    'postgresql://user:pass@ep-cool-night-123.us-east-2.aws.neon.tech/neondb',
    'postgresql://user:pass@production.internal.example.com/db',
    'postgresql://user:pass@db.example.com/db',
  ];

  for (const url of prodUrls) {
    it(`rejects ${new URL(url).hostname} without opt-in`, () => {
      withEnv({ ATHLYA_ALLOW_DANGEROUS_WRITE: undefined }, () => {
        expect(() => guardConnectionString(url)).toThrow('process.exit called with 1');
        expect(exitSpy).toHaveBeenCalledWith(1);
      });
    });

    it(`allows ${new URL(url).hostname} with ATHLYA_ALLOW_DANGEROUS_WRITE=1`, () => {
      withEnv({ ATHLYA_ALLOW_DANGEROUS_WRITE: '1', ATHLYA_DESTRUCTIVE: undefined }, () => {
        expect(() => guardConnectionString(url)).not.toThrow();
        expect(exitSpy).not.toHaveBeenCalled();
      });
    });
  }
});

describe('guardConnectionString — destructive flag on local hosts', () => {
  it('rejects destructive=true on localhost without ATHLYA_DESTRUCTIVE=1', () => {
    withEnv({ ATHLYA_DESTRUCTIVE: undefined }, () => {
      expect(() =>
        guardConnectionString('postgresql://user@localhost/dev', { destructive: true }),
      ).toThrow('process.exit called with 1');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  it('allows destructive=true on localhost with ATHLYA_DESTRUCTIVE=1', () => {
    withEnv({ ATHLYA_DESTRUCTIVE: '1' }, () => {
      expect(() =>
        guardConnectionString('postgresql://user@localhost/dev', { destructive: true }),
      ).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });
});

describe('guardConnectionString — destructive flag on remote hosts', () => {
  it('rejects destructive=true on remote even with ATHLYA_ALLOW_DANGEROUS_WRITE=1 if ATHLYA_DESTRUCTIVE is unset', () => {
    withEnv({ ATHLYA_ALLOW_DANGEROUS_WRITE: '1', ATHLYA_DESTRUCTIVE: undefined }, () => {
      expect(() =>
        guardConnectionString('postgresql://user@ep-cool.neon.tech/db', { destructive: true }),
      ).toThrow('process.exit called with 1');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  it('allows destructive=true on remote with both env vars set', () => {
    withEnv({ ATHLYA_ALLOW_DANGEROUS_WRITE: '1', ATHLYA_DESTRUCTIVE: '1' }, () => {
      expect(() =>
        guardConnectionString('postgresql://user@ep-cool.neon.tech/db', { destructive: true }),
      ).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });
});

describe('guardConnectionString — unparseable URL', () => {
  it('rejects a connection string that is not a valid URL', () => {
    expect(() => guardConnectionString('not-a-url')).toThrow('process.exit called with 1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

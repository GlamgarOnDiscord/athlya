import { describe, expect, it, vi } from 'vitest';

import { TX_RETRY_ATTEMPTS, withTransactionRetry } from '../../adapters/db-retry.js';

/** postgres-js error shape: SQLSTATE on `.code`. */
function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`pg ${code}`), { code });
}

const noSleep = { sleep: vi.fn((_ms: number) => Promise.resolve()), random: () => 0.5 };

describe('withTransactionRetry', () => {
  it('returns the first successful attempt without sleeping', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    const fn = vi.fn(() => Promise.resolve('ok'));

    await expect(withTransactionRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(['40001', '40P01'])('re-runs the transaction after SQLSTATE %s', async (code) => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(pgError(code))
      .mockResolvedValueOnce('ok');

    await expect(withTransactionRetry(fn, noSleep)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('finds the SQLSTATE on a wrapped cause', async () => {
    const wrapped = new Error('Failed query', { cause: pgError('40P01') });
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(wrapped)
      .mockResolvedValue('ok');

    await expect(withTransactionRetry(fn, noSleep)).resolves.toBe('ok');
  });

  it(`gives up after ${String(TX_RETRY_ATTEMPTS)} attempts and rethrows the last abort`, async () => {
    const abort = pgError('40001');
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(abort);

    await expect(withTransactionRetry(fn, noSleep)).rejects.toBe(abort);
    expect(fn).toHaveBeenCalledTimes(TX_RETRY_ATTEMPTS);
  });

  it('never retries another error, a unique violation included', async () => {
    const unique = pgError('23505');
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(unique);

    await expect(withTransactionRetry(fn, noSleep)).rejects.toBe(unique);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('backs off with full jitter that doubles per attempt', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(pgError('40001'));

    await expect(withTransactionRetry(fn, { sleep, random: () => 0.999 })).rejects.toThrow();

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([24, 49]);
  });
});

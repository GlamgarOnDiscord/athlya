import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_IDEMPOTENCY_PURGE_LIMIT,
  purgeExpiredIdempotencyKeys,
} from '../maintenance/idempotency-purge.js';
import { runScheduledRgpdMaintenance } from '../maintenance/scheduled-runner.js';

function selectReturning(rows: unknown[]) {
  return vi.fn(async () => rows) as unknown as <T>(
    query: string,
    params: readonly unknown[],
  ) => Promise<T[]>;
}

const silentLogger = { info: vi.fn(), error: vi.fn() };

describe('purgeExpiredIdempotencyKeys', () => {
  it('calls the cron-only function with the default batch limit', async () => {
    const selectRows = selectReturning([{ deleted: 3 }]);

    await expect(purgeExpiredIdempotencyKeys({ selectRows })).resolves.toEqual({
      deletedCount: 3,
      hasMore: false,
    });
    expect(selectRows).toHaveBeenCalledWith(
      'SELECT idempotency_purge_expired($1::integer) AS deleted',
      [DEFAULT_IDEMPOTENCY_PURGE_LIMIT],
    );
  });

  it('reports a backlog when the batch is full', async () => {
    const selectRows = selectReturning([{ deleted: '50' }]);

    await expect(purgeExpiredIdempotencyKeys({ selectRows }, { batchLimit: 50 })).resolves.toEqual({
      deletedCount: 50,
      hasMore: true,
    });
  });

  it('treats a missing row as nothing deleted', async () => {
    await expect(purgeExpiredIdempotencyKeys({ selectRows: selectReturning([]) })).resolves.toEqual(
      { deletedCount: 0, hasMore: false },
    );
  });

  it('rejects a count that is not a non-negative integer', async () => {
    await expect(
      purgeExpiredIdempotencyKeys({ selectRows: selectReturning([{ deleted: 'abc' }]) }),
    ).rejects.toThrow(/unexpected count/u);
  });
});

describe('runScheduledRgpdMaintenance — idempotency purge', () => {
  function executor(onPurge: () => Promise<unknown[]>) {
    return {
      execute: vi.fn(async () => 0),
      selectRows: vi.fn(async (query: string) =>
        query.includes('idempotency_purge_expired') ? onPurge() : [],
      ) as unknown as <T>(query: string, params: readonly unknown[]) => Promise<T[]>,
    };
  }

  it('runs the purge on every tick and returns its count', async () => {
    const result = await runScheduledRgpdMaintenance({
      executeSql: executor(async () => [{ deleted: 7 }]),
      logger: silentLogger,
    });

    expect(result.idempotencyPurge).toEqual({ deletedCount: 7, hasMore: false });
    expect(result.purge.error).toBeUndefined();
  });

  it('isolates a purge failure from the other maintenance jobs', async () => {
    const anonymizeOne = vi.fn(async () => ({ anonymizedRows: 0 }));
    const logger = { info: vi.fn(), error: vi.fn() };

    const result = await runScheduledRgpdMaintenance({
      executeSql: executor(async () => {
        throw new Error('function idempotency_purge_expired(integer) does not exist');
      }),
      anonymizeOne,
      logger,
    });

    expect(result.idempotencyPurge).toEqual({
      deletedCount: 0,
      hasMore: false,
      error: 'function idempotency_purge_expired(integer) does not exist',
    });
    expect(result.purge.error).toBeUndefined();
    expect(result.auditAnonymise.skipped).toBe(false);
    expect(logger.error).toHaveBeenCalledWith('maintenance: idempotency purge failed', {
      error: 'function idempotency_purge_expired(integer) does not exist',
    });
  });
});

/**
 * Unit tests for `anonymizeAuditLogViaSql` (Sprint 13 / Slice 13.3,
 * Epic B10.2).
 */

import { describe, expect, it, vi } from 'vitest';

import { anonymizeAuditLogViaSql } from '../maintenance/anonymize-audit-tx.js';

import type { CronSqlExecutor } from '../adapters/cron-sql-executor.js';

const VALID_USER_ID = '11111111-1111-4111-8111-111111111111';

function makeExecutor(returns: { actor: number; subject: number }): {
    executor: CronSqlExecutor;
    executeMock: ReturnType<typeof vi.fn>;
} {
    let call = 0;
    const executeMock = vi.fn(async () => {
        call += 1;
        if (call === 1) return returns.actor;
        return returns.subject;
    });
    const executor: CronSqlExecutor = {
        execute: executeMock,
        selectRows: vi.fn(),
    };
    return { executor, executeMock };
}

describe('anonymizeAuditLogViaSql', () => {
    it('runs two UPDATE statements (actor + subject) and returns the sum', async () => {
        const { executor, executeMock } = makeExecutor({
            actor: 3,
            subject: 1,
        });

        const total = await anonymizeAuditLogViaSql(executor, VALID_USER_ID);

        expect(total).toBe(4);
        expect(executeMock).toHaveBeenCalledTimes(2);
        const firstCall = executeMock.mock.calls[0] as [
            string,
            readonly unknown[],
        ];
        const secondCall = executeMock.mock.calls[1] as [
            string,
            readonly unknown[],
        ];
        // First UPDATE targets actor_id.
        expect(firstCall[0]).toContain('actor_id = $1::uuid');
        expect(firstCall[0]).toContain('actor_id = NULL');
        expect(firstCall[1]).toEqual([VALID_USER_ID]);
        // Second UPDATE targets metadata->>'subjectUserId'.
        expect(secondCall[0]).toContain(
            "metadata->>'subjectUserId' = $1",
        );
        expect(secondCall[1]).toEqual([VALID_USER_ID]);
    });

    it('strips email/userAgent/ip from metadata in both UPDATE statements', async () => {
        const { executor, executeMock } = makeExecutor({
            actor: 0,
            subject: 0,
        });

        await anonymizeAuditLogViaSql(executor, VALID_USER_ID);

        const calls = executeMock.mock.calls as Array<[string, unknown[]]>;
        for (const call of calls) {
            const sql = call[0];
            expect(sql).toContain("metadata - 'email'");
            expect(sql).toContain("'userAgent'");
            expect(sql).toContain("'ip'");
        }
    });

    it('returns 0 when no rows match (idempotent on already-anonymised user)', async () => {
        const { executor } = makeExecutor({ actor: 0, subject: 0 });
        const total = await anonymizeAuditLogViaSql(executor, VALID_USER_ID);
        expect(total).toBe(0);
    });

    it('rejects malformed userId at validation time', async () => {
        const executeMock = vi.fn();
        const executor: CronSqlExecutor = {
            execute: executeMock,
            selectRows: vi.fn(),
        };

        await expect(
            anonymizeAuditLogViaSql(executor, 'not-a-uuid'),
        ).rejects.toThrow(/malformed userId/);
        expect(executeMock).not.toHaveBeenCalled();
    });

    it('propagates execute errors verbatim', async () => {
        const executeMock = vi.fn().mockRejectedValue(
            new Error('postgres unreachable'),
        );
        const executor: CronSqlExecutor = {
            execute: executeMock,
            selectRows: vi.fn(),
        };

        await expect(
            anonymizeAuditLogViaSql(executor, VALID_USER_ID),
        ).rejects.toThrow('postgres unreachable');
    });
});

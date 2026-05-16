/**
 * Shared drizzle-SQL capture helpers for the unit-test suites.
 *
 * The idempotency and outbox helpers both emit raw `sql\`\`` templates
 * and hand them to `tx.execute()`. To unit-test them without spinning
 * up Postgres, we:
 *
 *   1. Stand up a fake `AthlyaTx` whose `.execute()` records every call
 *      and returns a scripted result.
 *   2. Inspect the drizzle `SQL` instance handed to `.execute()` and
 *      reconstruct `{ sqlText, params }` from its `queryChunks`. The
 *      template places `StringChunk` instances for SQL literals and
 *      raw primitives for each interpolated value, so the
 *      reconstruction is a straight walk over the array — no
 *      dependency on drizzle internals beyond the public array shape.
 *
 * Keeping these helpers in a separate module lets both `idempotency.test.ts`
 * and `outbox.test.ts` reuse identical plumbing and keeps the test
 * files focused on the per-helper assertions.
 */

import { vi } from 'vitest';

import type { AthlyaTx } from '../src/index.js';

/** A single recorded `.execute()` call, flattened for assertion. */
export interface ExecuteCall {
    /** Reconstructed SQL text with `?` placeholders in lieu of bound params. */
    readonly sqlText: string;
    /** Interpolated parameter values in positional order. */
    readonly params: readonly unknown[];
}

/** Result scripting + call log returned by {@link makeFakeTx}. */
export interface FakeTxHandle {
    readonly tx: AthlyaTx;
    readonly execute: ReturnType<typeof vi.fn>;
    readonly calls: readonly ExecuteCall[];
    /**
     * Queue `rows` as the result of the next `.execute()`. Declared as
     * a bound function reference (not a method) so destructuring the
     * handle does not strip `this`; ESLint's `unbound-method` rule
     * flags method-style destructuring as a foot-gun, and the explicit
     * `this: void` annotation tells both the compiler and the lint
     * rule that the callable is safe to pass around on its own.
     */
    readonly enqueueResult: (this: void, rows: unknown) => void;
}

export function makeFakeTx(): FakeTxHandle {
    const calls: ExecuteCall[] = [];
    const results: unknown[] = [];

    const execute = vi.fn((query: unknown): Promise<unknown> => {
        calls.push(extractCall(query));
        const next = results.length > 0 ? results.shift() : [];
        return Promise.resolve(next);
    });

    // Anchored to `this: void` so destructuring the handle (which every
    // test file does) preserves the call signature the lint rule
    // expects. The arrow body means there is nothing to "unbind" at
    // runtime; the annotation is purely a static promise to readers
    // and to `@typescript-eslint/unbound-method`.
    const enqueueResult: (this: void, rows: unknown) => void = (rows) => {
        results.push(rows);
    };

    return {
        tx: { execute } as unknown as AthlyaTx,
        execute,
        calls,
        enqueueResult,
    };
}

/**
 * Walk a drizzle `SQL` instance's `queryChunks` and rebuild
 * `{ sqlText, params }`. `StringChunk` instances expose a `value:
 * string[]` array of SQL fragments; everything else is an interpolated
 * parameter captured in positional order.
 */
export function extractCall(query: unknown): ExecuteCall {
    if (!query || typeof query !== 'object') {
        return { sqlText: JSON.stringify(query ?? ''), params: [] };
    }
    const obj = query as { queryChunks?: unknown[] };
    if (!Array.isArray(obj.queryChunks)) {
        return { sqlText: JSON.stringify(query), params: [] };
    }

    const textParts: string[] = [];
    const params: unknown[] = [];

    for (const chunk of obj.queryChunks) {
        if (isStringChunk(chunk)) {
            textParts.push(chunk.value.join(''));
            continue;
        }
        textParts.push('?');
        params.push(chunk);
    }

    return { sqlText: textParts.join(''), params };
}

function isStringChunk(value: unknown): value is { value: string[] } {
    if (!value || typeof value !== 'object') return false;
    const v = (value as { value?: unknown }).value;
    if (!Array.isArray(v) || !v.every((item) => typeof item === 'string')) {
        return false;
    }
    // drizzle's `StringChunk` sets its constructor name identically
    // across CJS and ESM builds; we pin on it so an accidental
    // `{ value: [...] }` object interpolated as a parameter (highly
    // unlikely in this codebase, but worth defending against) is not
    // mis-classified as SQL text.
    return (value as { constructor?: { name?: string } }).constructor?.name === 'StringChunk';
}

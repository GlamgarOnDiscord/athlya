/**
 * Integration-style tests for the JWT rotation admin router
 * (Sprint 12 / Slice 12.7, Epic B3.1).
 *
 * Pattern mirrors `dlq-routes.test.ts`: build a fresh Hono app per
 * test, seed `authClaims` + `traceId` via a pre-middleware, mount
 * the router under test.
 *
 * Three asserted shapes per route:
 *   1. No auth claims → 403.
 *   2. Non-admin role → 403.
 *   3. Admin role → success.
 *
 * Plus rotation-specific shape assertions:
 *   - Pre-condition fail (missing JWT_KID etc.) → 500
 *     `jwt_rotation_precondition_failed`.
 *   - Successful rotation: response carries new kid, distinct from
 *     the old one, JWKS contains both keys, audit hook called once.
 */

import { Hono } from 'hono';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import {
    buildJwtRotateRouter,
    type JwtRotateAdminEnv,
    type JwtRotateAuditWriter,
} from '../admin/jwt-rotate-routes.js';

import type { AthlyaBindings } from '../types.js';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                            */
/* ------------------------------------------------------------------ */

type Role = 'member' | 'admin' | 'coach';

interface PreparedKeypair {
    readonly kid: string;
    readonly privatePem: string;
    readonly publicPem: string;
}

/** Generate an RS256 keypair + export both halves as PEM. */
async function makeRealKeypair(kid: string): Promise<PreparedKeypair> {
    const { privateKey, publicKey } = await generateKeyPair('RS256', {
        modulusLength: 2048,
        extractable: true,
    });
    const [privatePem, publicPem] = await Promise.all([
        exportPKCS8(privateKey),
        exportSPKI(publicKey),
    ]);
    return { kid, privatePem, publicPem };
}

/** Build a Hono app with a seeded auth claim + the router under test. */
function buildApp(
    role: Role | null,
    deps: Parameters<typeof buildJwtRotateRouter>[0] = {},
): { app: Hono<JwtRotateAdminEnv>; auditCalls: AuditCall[] } {
    const auditCalls: AuditCall[] = [];
    const auditWriter: JwtRotateAuditWriter = {
        async appendRotationPrep(input) {
            auditCalls.push(input);
        },
    };

    const app = new Hono<JwtRotateAdminEnv>();
    app.use('*', async (c, next) => {
        c.set('traceId', 'trace-test');
        if (role !== null) {
            c.set('authClaims', {
                userId: '00000000-0000-4000-8000-000000000001',
                studioId: '00000000-0000-4000-8000-000000000002',
                role,
            });
        }
        // Lightweight logger so warn() during audit failure does
        // not crash. Mirrors what `worker.ts` installs.
        c.set('logger', {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        });
        await next();
    });

    app.route(
        '/',
        buildJwtRotateRouter({
            auditWriter,
            ...deps,
        }),
    );

    return { app, auditCalls };
}

interface AuditCall {
    readonly actorId: string;
    readonly kidOld: string;
    readonly kidNew: string;
    readonly graceSec: number;
}

/** Build a minimally-populated Bindings for tests. */
function buildEnv(
    overrides: Partial<AthlyaBindings> = {},
): AthlyaBindings {
    return {
        ENVIRONMENT: 'dev',
        EVENTS_QUEUE: {
            send: vi.fn().mockResolvedValue(undefined),
        } as unknown as AthlyaBindings['EVENTS_QUEUE'],
        EVENTS_DLQ: {
            send: vi.fn().mockResolvedValue(undefined),
        } as unknown as AthlyaBindings['EVENTS_DLQ'],
        DB_URL: '',
        REDIS_URL: '',
        REDIS_TOKEN: '',
        JWT_JWKS_URL: '',
        VERSION: 'test',
        ...overrides,
    };
}

/* ------------------------------------------------------------------ */
/*  GET /admin/jwt/state                                                */
/* ------------------------------------------------------------------ */

describe('GET /admin/jwt/state', () => {
    it('returns 403 Problem Details when no auth claims are set', async () => {
        const { app } = buildApp(null);
        const res = await app.request(
            '/admin/jwt/state',
            { method: 'GET' },
            buildEnv({
                JWT_KID: 'k1',
                JWKS_JSON: '{"keys":[]}',
            } as unknown as Partial<AthlyaBindings>),
        );

        expect(res.status).toBe(403);
        expect(res.headers.get('content-type')).toBe(
            'application/problem+json',
        );
    });

    it('returns 403 for member role', async () => {
        const { app } = buildApp('member');
        const res = await app.request(
            '/admin/jwt/state',
            { method: 'GET' },
            buildEnv({
                JWT_KID: 'k1',
                JWKS_JSON: '{"keys":[]}',
            } as unknown as Partial<AthlyaBindings>),
        );
        expect(res.status).toBe(403);
    });

    it('returns 200 with currentKid + JWKS for admin', async () => {
        const { app } = buildApp('admin');
        const jwksJson = '{"keys":[{"kty":"RSA","kid":"k1","alg":"RS256"}]}';
        const res = await app.request(
            '/admin/jwt/state',
            { method: 'GET' },
            buildEnv({
                JWT_KID: 'k1',
                JWKS_JSON: jwksJson,
            } as unknown as Partial<AthlyaBindings>),
        );

        expect(res.status).toBe(200);
        const body = ((await res.json() as any));
        expect(body.currentKid).toBe('k1');
        expect(body.jwks.keys).toHaveLength(1);
        expect(body.jwks.keys[0]?.kid).toBe('k1');
    });

    it('returns 500 jwt_state_unavailable when JWT_KID is missing', async () => {
        const { app } = buildApp('admin');
        const res = await app.request(
            '/admin/jwt/state',
            { method: 'GET' },
            buildEnv(),
        );
        expect(res.status).toBe(500);
        const body = ((await res.json() as any));
        expect(body.code).toBe('jwt_state_unavailable');
    });

    it('returns 500 jwt_state_unavailable on malformed JWKS_JSON', async () => {
        const { app } = buildApp('admin');
        const res = await app.request(
            '/admin/jwt/state',
            { method: 'GET' },
            buildEnv({
                JWT_KID: 'k1',
                JWKS_JSON: 'not-json',
            } as unknown as Partial<AthlyaBindings>),
        );
        expect(res.status).toBe(500);
    });
});

/* ------------------------------------------------------------------ */
/*  POST /admin/jwt/rotate-prepare                                       */
/* ------------------------------------------------------------------ */

describe('POST /admin/jwt/rotate-prepare', () => {
    it('returns 403 for non-admin role', async () => {
        const { app } = buildApp('coach');
        const res = await app.request(
            '/admin/jwt/rotate-prepare',
            { method: 'POST' },
            buildEnv(),
        );
        expect(res.status).toBe(403);
    });

    it('returns 500 precondition_failed when JWT_KID is missing', async () => {
        const { app } = buildApp('admin');
        const res = await app.request(
            '/admin/jwt/rotate-prepare',
            { method: 'POST' },
            buildEnv(),
        );
        expect(res.status).toBe(500);
        const body = ((await res.json() as any));
        expect(body.code).toBe('jwt_rotation_precondition_failed');
    });

    it(
        'returns 200 with a fresh keypair + JWKS bundle for admin',
        { timeout: 30_000 },
        async () => {
            const { app, auditCalls } = buildApp('admin');

            // Pre-generate a real keypair so `loadKeyPairFromPem`
            // accepts it. The router will demote it to "previous".
            const old = await makeRealKeypair('athlya-old');

            const res = await app.request(
                '/admin/jwt/rotate-prepare',
                { method: 'POST' },
                buildEnv({
                    JWT_KID: old.kid,
                    JWT_PRIVATE_KEY_PEM: old.privatePem,
                    JWT_PUBLIC_KEY_PEM: old.publicPem,
                } as unknown as Partial<AthlyaBindings>),
            );

            expect(res.status).toBe(200);
            const body = ((await res.json() as any));

            // New kid is distinct from the old one.
            expect(body.currentKid).toMatch(/^athlya-/);
            expect(body.currentKid).not.toBe('athlya-old');
            expect(body.previousKid).toBe('athlya-old');

            // PEM blobs are present (PKCS#8 + SPKI).
            expect(body.currentPrivatePem).toContain(
                '-----BEGIN PRIVATE KEY-----',
            );
            expect(body.currentPublicPem).toContain(
                '-----BEGIN PUBLIC KEY-----',
            );

            // JWKS contains BOTH keys (current + previous) for the
            // grace window.
            expect(body.jwks.keys).toHaveLength(2);
            const kids = body.jwks.keys.map((k: any) => k.kid);
            expect(kids).toContain(body.currentKid);
            expect(kids).toContain('athlya-old');

            // notAfter is a valid ISO 8601.
            expect(body.previousNotAfter).toMatch(/^\d{4}-\d{2}-\d{2}T/);

            // Default grace window from `@athlya/auth`.
            expect(body.graceSec).toBe(24 * 60 * 60);

            // Audit hook fired exactly once with PII-safe payload.
            expect(auditCalls).toHaveLength(1);
            const audit = auditCalls[0];
            expect(audit?.actorId).toBe(
                '00000000-0000-4000-8000-000000000001',
            );
            expect(audit?.kidOld).toBe('athlya-old');
            expect(audit?.kidNew).toBe(body.currentKid);
            expect(audit?.graceSec).toBe(24 * 60 * 60);
        },
    );

    it(
        'continues the rotation even when audit append fails',
        { timeout: 30_000 },
        async () => {
            const failingAudit: JwtRotateAuditWriter = {
                async appendRotationPrep() {
                    throw new Error('db down');
                },
            };
            const { app } = buildApp('admin', {
                auditWriter: failingAudit,
            });

            const old = await makeRealKeypair('athlya-old-2');

            const res = await app.request(
                '/admin/jwt/rotate-prepare',
                { method: 'POST' },
                buildEnv({
                    JWT_KID: old.kid,
                    JWT_PRIVATE_KEY_PEM: old.privatePem,
                    JWT_PUBLIC_KEY_PEM: old.publicPem,
                } as unknown as Partial<AthlyaBindings>),
            );

            // Rotation succeeded — audit failure does not block it.
            expect(res.status).toBe(200);
            const body = ((await res.json() as any));
            expect(body.currentKid).not.toBe('athlya-old-2');
        },
    );
});

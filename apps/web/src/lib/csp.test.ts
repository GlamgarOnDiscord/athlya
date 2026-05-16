/**
 * Unit tests for {@link generateCsp}.
 *
 * Validates the concrete security requirements of Req 25.3:
 *  - The per-request nonce appears in both `script-src` and `style-src`.
 *  - `frame-ancestors 'none'` is present (redundant-with-X-Frame-Options
 *    belt-and-braces hardening).
 *  - The Cloudflare Turnstile origin is whitelisted so task 10.2 can
 *    drop the widget in without touching the policy.
 *  - An empty nonce throws loudly — we never want to silently emit a
 *    weak policy.
 *
 * @see Req 25.3 — requirements.md
 *
 * Task 10.1.
 */
import { describe, expect, it } from 'vitest';

import { buildReportToHeader, CSP_REPORT_GROUP, generateCsp } from './csp';

describe('generateCsp', () => {
    const nonce = 'abc123XYZ';

    it('includes the nonce in both script-src and style-src', () => {
        const csp = generateCsp({ nonce });
        expect(csp).toContain(`script-src 'self' 'nonce-${nonce}'`);
        expect(csp).toContain(`style-src 'self' 'nonce-${nonce}'`);
    });

    it('forbids framing via frame-ancestors none', () => {
        const csp = generateCsp({ nonce });
        expect(csp).toContain("frame-ancestors 'none'");
    });

    it('whitelists the Cloudflare Turnstile origin in script-src, frame-src and connect-src', () => {
        const csp = generateCsp({ nonce });
        expect(csp).toMatch(/script-src[^;]*https:\/\/challenges\.cloudflare\.com/u);
        expect(csp).toMatch(/frame-src[^;]*https:\/\/challenges\.cloudflare\.com/u);
        expect(csp).toMatch(/connect-src[^;]*https:\/\/challenges\.cloudflare\.com/u);
    });

    it('disables object-src, upgrades insecure requests and locks base-uri / form-action', () => {
        const csp = generateCsp({ nonce });
        expect(csp).toContain("object-src 'none'");
        expect(csp).toContain('upgrade-insecure-requests');
        expect(csp).toContain("base-uri 'self'");
        expect(csp).toContain("form-action 'self'");
    });

    it('includes the provided apiUrl in connect-src when supplied', () => {
        const csp = generateCsp({ nonce, apiUrl: 'https://api.athlya.test' });
        expect(csp).toMatch(/connect-src[^;]*https:\/\/api\.athlya\.test/u);
    });

    it('omits an empty apiUrl from connect-src without breaking the directive', () => {
        const csp = generateCsp({ nonce, apiUrl: '' });
        expect(csp).toMatch(/connect-src 'self' https:\/\/challenges\.cloudflare\.com/u);
    });

    it('throws if the nonce is empty', () => {
        expect(() => generateCsp({ nonce: '' })).toThrow(TypeError);
    });

    describe('dev-mode unsafe-eval toggle', () => {
        it('does NOT emit unsafe-eval by default (production posture)', () => {
            const csp = generateCsp({ nonce });
            expect(csp).not.toContain("'unsafe-eval'");
        });

        it('does NOT emit unsafe-eval when dev is explicitly false', () => {
            const csp = generateCsp({ nonce, dev: false });
            expect(csp).not.toContain("'unsafe-eval'");
        });

        it("emits 'unsafe-eval' inside script-src only when dev is true", () => {
            const csp = generateCsp({ nonce, dev: true });
            // Present inside script-src...
            expect(csp).toMatch(/script-src[^;]*'unsafe-eval'/u);
            // ...but never leaks into style-src / other directives.
            expect(csp).not.toMatch(/style-src[^;]*'unsafe-eval'/u);
        });
    });

    describe('reporting directives', () => {
        it('omits report-to and report-uri when no reportUri is supplied', () => {
            const csp = generateCsp({ nonce });
            expect(csp).not.toContain('report-to');
            expect(csp).not.toContain('report-uri');
        });

        it('omits reporting directives on an empty reportUri', () => {
            const csp = generateCsp({ nonce, reportUri: '' });
            expect(csp).not.toContain('report-to');
            expect(csp).not.toContain('report-uri');
        });

        it('emits report-to and report-uri when reportUri is supplied', () => {
            const csp = generateCsp({
                nonce,
                reportUri: 'https://reports.athlya.test/csp',
            });
            expect(csp).toContain(`report-to ${CSP_REPORT_GROUP}`);
            expect(csp).toContain('report-uri https://reports.athlya.test/csp');
        });
    });
});

describe('buildReportToHeader', () => {
    it('returns undefined when no endpoint is supplied', () => {
        expect(buildReportToHeader(undefined)).toBeUndefined();
        expect(buildReportToHeader('')).toBeUndefined();
    });

    it('returns a JSON-stringified ReportingAPI payload when an endpoint is supplied', () => {
        const header = buildReportToHeader('https://reports.athlya.test/csp');
        expect(header).toBeDefined();
        const parsed = JSON.parse(header as string) as {
            group: string;
            max_age: number;
            endpoints: { url: string }[];
        };
        expect(parsed.group).toBe(CSP_REPORT_GROUP);
        expect(parsed.max_age).toBeGreaterThan(0);
        expect(parsed.endpoints).toEqual([
            { url: 'https://reports.athlya.test/csp' },
        ]);
    });
});

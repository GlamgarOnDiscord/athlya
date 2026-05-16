#!/usr/bin/env node
/**
 * Lighthouse accessibility budget guardrail.
 *
 * Task 10.7 requires an Accessibility score >= 95 on the five
 * member-facing pages. Lighthouse is enough of a guardrail for the
 * public pages (`/`, `/login`, `/register`) where the login form is
 * the richest interactive surface. The authenticated pages
 * (`/classes`, `/me`) are already covered by the axe sweep, and
 * automating a full auth flow inside Lighthouse for a CI guardrail
 * would be disproportionate.
 *
 * This script assumes a Next.js dev or prod server is reachable at
 * `LIGHTHOUSE_BASE_URL` (default `http://localhost:3000`). The
 * GitHub Actions workflow in `.github/workflows/axe.yml` runs
 * `pnpm --filter @athlya/web e2e` first, which leaves a dev server
 * running on :3000 via Playwright's `webServer` block, then runs
 * this script against the same server.
 *
 * @see Requirements 27.1, 27.2.
 */
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';

const PAGES = ['/', '/login', '/register'];
const BASE_URL = process.env.LIGHTHOUSE_BASE_URL ?? 'http://localhost:3000';
const MIN_ACCESSIBILITY = 95;

async function check() {
    const chrome = await launch({ chromeFlags: ['--headless'] });
    try {
        const scores = await Promise.all(
            PAGES.map(async (path) => {
                const url = `${BASE_URL}${path}`;
                const result = await lighthouse(url, {
                    port: chrome.port,
                    onlyCategories: ['accessibility'],
                    output: 'json',
                });
                const score = (result.lhr.categories.accessibility?.score ?? 0) * 100;
                console.log(`${path} accessibility score: ${score}`);
                return { path, score };
            }),
        );
        for (const { path, score } of scores) {
            if (score < MIN_ACCESSIBILITY) {
                console.error(
                    `FAIL: ${path} scored ${score}, expected >= ${MIN_ACCESSIBILITY}`,
                );
                process.exit(1);
            }
        }
        console.log('OK: all pages >= 95 accessibility.');
    } finally {
        await chrome.kill();
    }
}

void check().catch((err) => {
    console.error(err);
    process.exit(1);
});

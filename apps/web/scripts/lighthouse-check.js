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
 * This script assumes a Next.js prod server is reachable at
 * `LIGHTHOUSE_BASE_URL` (default `http://localhost:3000`). The
 * GitHub Actions workflow in `.github/workflows/axe.yml` starts
 * a long-lived `next start` in the background (a separate step
 * from the Playwright axe sweep, because Playwright tears its
 * own `webServer` down at the end of the run) and tears it
 * down after this script exits.
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
    // Sequential — running lighthouse in parallel against the
    // same Chrome instance trips a `start lh:driver:navigate`
    // performance-mark race in lighthouse 12 + Node 20 (see
    // https://github.com/GoogleChrome/lighthouse/issues/16401).
    // The serial loop costs a few extra seconds but never flakes.
    const scores = [];
    for (const path of PAGES) {
      const url = `${BASE_URL}${path}`;
      const result = await lighthouse(url, {
        port: chrome.port,
        onlyCategories: ['accessibility'],
        output: 'json',
      });
      const score = (result.lhr.categories.accessibility?.score ?? 0) * 100;
      console.log(`${path} accessibility score: ${score}`);
      scores.push({ path, score });
    }
    for (const { path, score } of scores) {
      if (score < MIN_ACCESSIBILITY) {
        console.error(`FAIL: ${path} scored ${score}, expected >= ${MIN_ACCESSIBILITY}`);
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

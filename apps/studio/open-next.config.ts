/**
 * OpenNext → Cloudflare Workers adapter config (issue #422).
 *
 * `opennextjs-cloudflare build` turns the `next build` output into a
 * Worker bundle under `.open-next/` (`worker.js` + static `assets/`);
 * `wrangler.jsonc` deploys it. No incremental cache is configured: every
 * route is rendered per request (CSP nonces are per request anyway).
 */
import { defineCloudflareConfig } from '@opennextjs/cloudflare';

export default defineCloudflareConfig({});

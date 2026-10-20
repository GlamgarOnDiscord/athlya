/**
 * Static security headers: the camera is allowed on the check-in kiosk
 * only, and every route gets exactly one Permissions-Policy.
 */
import { describe, expect, it } from 'vitest';

import nextConfig from '../next.config';

interface HeaderRule {
  readonly source: string;
  readonly headers: ReadonlyArray<{ readonly key: string; readonly value: string }>;
}

/** Same matching as Next.js for the two patterns used in next.config.ts. */
function matches(source: string, path: string): boolean {
  if (source.endsWith('/:path*')) {
    const base = source.slice(0, -'/:path*'.length);
    return path === base || path.startsWith(`${base}/`);
  }
  return new RegExp(`^${source}$`).test(path);
}

async function policiesFor(path: string): Promise<string[]> {
  const rules = (await nextConfig.headers?.()) as HeaderRule[];
  return rules
    .filter((rule) => matches(rule.source, path))
    .flatMap((rule) => rule.headers.filter((h) => h.key === 'Permissions-Policy'))
    .map((h) => h.value);
}

describe('Permissions-Policy', () => {
  it('allows the camera, same origin only, on the check-in kiosk', async () => {
    for (const path of ['/dashboard/checkin', '/dashboard/checkin/']) {
      const policies = await policiesFor(path);
      expect(policies).toHaveLength(1);
      expect(policies[0]).toContain('camera=(self)');
      expect(policies[0]).toContain('microphone=()');
    }
  });

  it('keeps the camera off everywhere else', async () => {
    for (const path of ['/', '/login', '/dashboard', '/dashboard/members', '/dashboard/checkins']) {
      const policies = await policiesFor(path);
      expect(policies).toHaveLength(1);
      expect(policies[0]).toContain('camera=()');
    }
  });
});

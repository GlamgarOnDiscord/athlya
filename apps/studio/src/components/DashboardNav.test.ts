/**
 * Studio navigation model: each role sees the pages the gate opens to it
 * and nothing else (issue #756). A coach and the front desk get their
 * home, the read-only schedule, the members directory and the kiosk; a
 * manager the admin navigation without billing and branding.
 */
import { describe, expect, it } from 'vitest';

import { canOpenRoute } from '../lib/auth/console-routes';
import { ownDocumentRoute } from '../lib/full-reload';
import { createTranslator } from '../lib/i18n/t';

import { pageLabelFor, sectionsFor, studioSections } from './DashboardNav';

import type { Role } from '@athlya/shared/roles';

const t = createTranslator('en');

function hrefs(sections: ReturnType<typeof studioSections>): string[] {
  return sections.flatMap((section) =>
    section.items.flatMap((item) =>
      item.kind === 'link' ? [item.href] : item.children.map((child) => child.href),
    ),
  );
}

describe('sectionsFor', () => {
  it('gives a coach home, schedule, members and check-in, in that order, without groups', () => {
    const sections = sectionsFor('coach', t);
    expect(hrefs(sections)).toEqual([
      '/dashboard',
      '/dashboard/planning',
      '/dashboard/members',
      '/dashboard/checkin',
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.items.every((item) => item.kind === 'link')).toBe(true);
    expect(pageLabelFor(sections, '/dashboard')).toBe('Home');
    expect(pageLabelFor(sections, '/dashboard/planning')).toBe('My schedule');
  });

  it('gives the front desk the same pages, the planning named for the whole studio', () => {
    const sections = sectionsFor('accueil', t);
    expect(hrefs(sections)).toEqual([
      '/dashboard',
      '/dashboard/planning',
      '/dashboard/members',
      '/dashboard/checkin',
    ]);
    expect(pageLabelFor(sections, '/dashboard/planning')).toBe('Planning');
  });

  it('gives a manager the admin navigation without billing and branding', () => {
    const links = hrefs(sectionsFor('manager', t));
    expect(links).toContain('/dashboard/classes');
    expect(links).toContain('/dashboard/team');
    expect(links).toContain('/dashboard/audit');
    expect(links).not.toContain('/dashboard/billing');
    expect(links).not.toContain('/dashboard/branding');
  });

  it('gives an admin every link', () => {
    expect(hrefs(sectionsFor('admin', t))).toEqual(hrefs(studioSections(t)));
  });

  it.each<Role>(['admin', 'manager', 'accueil', 'coach'])(
    'only links pages the dashboard gate opens to %s',
    (role) => {
      expect(hrefs(sectionsFor(role, t)).every((href) => canOpenRoute(role, href))).toBe(true);
    },
  );
});

describe('studioSections', () => {
  it('marks the kiosk link, and only that link, as its own document', () => {
    const links = studioSections(t).flatMap((section) =>
      section.items.flatMap((item) => (item.kind === 'link' ? [item] : item.children)),
    );
    for (const link of links) {
      expect(link.fullReload === true).toBe(ownDocumentRoute(link.href) !== null);
    }
    expect(links.some((link) => link.fullReload === true)).toBe(true);
  });
});

describe('pageLabelFor', () => {
  it('names the page from the longest matching link, nested ones included', () => {
    const sections = studioSections(t);
    expect(pageLabelFor(sections, '/dashboard')).toBe('Dashboard');
    expect(pageLabelFor(sections, '/dashboard/members')).toBe('Members');
    expect(pageLabelFor(sections, '/dashboard/audit')).toBe('Audit');
    expect(pageLabelFor(sections, '/dashboard/team')).toBe('Team');
    expect(pageLabelFor(sections, '/login')).toBeNull();
  });
});

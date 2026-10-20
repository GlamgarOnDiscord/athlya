/**
 * Studio navigation model: a coach sees their home, their schedule, the
 * members directory and the kiosk, and nothing the gate would refuse.
 */
import { describe, expect, it } from 'vitest';

import { ownDocumentRoute } from '../lib/full-reload';
import { createTranslator } from '../lib/i18n/t';

import { coachSections, pageLabelFor, studioSections } from './DashboardNav';
import { isCoachRoute } from './RequireAdmin';

const t = createTranslator('en');

function hrefs(sections: ReturnType<typeof studioSections>): string[] {
  return sections.flatMap((section) =>
    section.items.flatMap((item) =>
      item.kind === 'link' ? [item.href] : item.children.map((child) => child.href),
    ),
  );
}

describe('coachSections', () => {
  it('lists home, schedule, members and check-in, in that order, without groups', () => {
    const sections = coachSections(t);
    expect(hrefs(sections)).toEqual([
      '/dashboard',
      '/dashboard/planning',
      '/dashboard/members',
      '/dashboard/checkin',
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.items.every((item) => item.kind === 'link')).toBe(true);
  });

  it('names the coach pages for a coach', () => {
    const sections = coachSections(t);
    expect(pageLabelFor(sections, '/dashboard')).toBe('Home');
    expect(pageLabelFor(sections, '/dashboard/planning')).toBe('My schedule');
    expect(pageLabelFor(sections, '/dashboard/checkin')).toBe('Check-in');
  });

  it('only links pages the dashboard gate opens to a coach', () => {
    expect(hrefs(coachSections(t)).every(isCoachRoute)).toBe(true);
  });

  it('leaves the admin navigation untouched', () => {
    expect(hrefs(studioSections(t))).toContain('/dashboard/billing');
  });
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
    expect(pageLabelFor(sections, '/login')).toBeNull();
  });
});

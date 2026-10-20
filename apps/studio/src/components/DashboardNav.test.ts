/**
 * Studio navigation model: a coach only sees the check-in kiosk.
 */
import { describe, expect, it } from 'vitest';

import { needsFullReload } from '../lib/full-reload';
import { createTranslator } from '../lib/i18n/t';

import { coachSections, pageLabelFor, studioSections } from './DashboardNav';

const t = createTranslator('en');

function hrefs(sections: ReturnType<typeof studioSections>): string[] {
  return sections.flatMap((section) =>
    section.items.flatMap((item) =>
      item.kind === 'link' ? [item.href] : item.children.map((child) => child.href),
    ),
  );
}

describe('coachSections', () => {
  it('keeps only the check-in link and drops empty sections and groups', () => {
    const sections = coachSections(studioSections(t));
    expect(hrefs(sections)).toEqual(['/dashboard/checkin']);
    expect(sections).toHaveLength(1);
  });

  it('leaves the admin navigation untouched', () => {
    expect(hrefs(studioSections(t))).toContain('/dashboard/billing');
  });
});

describe('studioSections', () => {
  it('loads the kiosk link as a new document, and only that link', () => {
    const links = studioSections(t).flatMap((section) =>
      section.items.flatMap((item) => (item.kind === 'link' ? [item] : item.children)),
    );
    for (const link of links) {
      expect(link.fullReload === true).toBe(needsFullReload(link.href));
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

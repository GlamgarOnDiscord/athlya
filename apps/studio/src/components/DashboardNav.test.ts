/**
 * Studio navigation model: a coach only sees the check-in kiosk.
 */
import { describe, expect, it } from 'vitest';

import { createTranslator } from '../lib/i18n/t';

import { coachSections, studioSections } from './DashboardNav';

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

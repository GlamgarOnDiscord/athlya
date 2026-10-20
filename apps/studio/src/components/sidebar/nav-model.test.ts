/**
 * Own-document routes in the navigation model: a link that enters or
 * leaves one must load a new document.
 */
import { ScanIcon, UsersIcon } from '@phosphor-icons/react';
import { describe, expect, it } from 'vitest';

import { crossesDocument, ownDocumentAt, type SidebarSection } from './nav-model';

const kiosk = {
  kind: 'link',
  href: '/dashboard/checkin',
  label: 'Check-in',
  icon: ScanIcon,
  fullReload: true,
} as const;
const members = {
  kind: 'link',
  href: '/dashboard/members',
  label: 'Members',
  icon: UsersIcon,
} as const;
const sections: SidebarSection[] = [{ id: 'main', items: [members, kiosk] }];

describe('ownDocumentAt', () => {
  it('names the own-document route holding the page, or null', () => {
    expect(ownDocumentAt(sections, '/dashboard/checkin')).toBe('/dashboard/checkin');
    expect(ownDocumentAt(sections, '/dashboard/members')).toBeNull();
  });
});

describe('crossesDocument', () => {
  it('crosses when entering the kiosk from an ordinary page', () => {
    expect(crossesDocument(null, kiosk)).toBe(true);
  });

  it('crosses for every ordinary link while on the kiosk', () => {
    expect(crossesDocument('/dashboard/checkin', members)).toBe(true);
  });

  it('stays a client transition within the same document', () => {
    expect(crossesDocument(null, members)).toBe(false);
    expect(crossesDocument('/dashboard/checkin', kiosk)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { searchCommands, type CommandItem } from './command-search';

const ITEMS: CommandItem[] = [
  {
    id: 'm1',
    kind: 'member',
    label: 'Camille Durand',
    hint: 'camille.durand@example.com',
    href: '/dashboard/members?q=Camille%20Durand',
  },
  { id: 'p1', kind: 'page', label: 'Membres', hint: '', href: '/dashboard/members' },
  ...Array.from({ length: 8 }, (_, i): CommandItem => ({
    id: `c${String(i)}`,
    kind: 'class',
    label: 'Mobilité',
    hint: `jeu. ${String(22 + i)} oct.`,
    href: '/dashboard/classes',
  })),
];

describe('searchCommands', () => {
  it('orders pages before classes and members', () => {
    expect(searchCommands(ITEMS, 'm').map((i) => i.kind)[0]).toBe('page');
  });

  it('caps each kind at six and searches the hint too', () => {
    expect(searchCommands(ITEMS, 'mobilite').filter((i) => i.kind === 'class')).toHaveLength(6);
    expect(searchCommands(ITEMS, 'example.com').map((i) => i.id)).toEqual(['m1']);
  });
});

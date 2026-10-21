import { describe, expect, it, vi } from 'vitest';

import { fetchRooms, roomNames, staffOf } from './rooms';

import type { ApiClient } from './client';
import type { StudioMember } from './members';

function person(id: string, displayName: string, role: StudioMember['role']): StudioMember {
  return { id, email: `${id}@example.com`, displayName, role, avatarUrl: null, createdAt: '' };
}

describe('rooms', () => {
  it('reads the rooms list and maps ids to names', async () => {
    const room = {
      id: 'r1',
      studioId: 's',
      name: 'Studio 1',
      capacity: null,
      createdAt: '2026-10-01T08:00:00.000Z',
    };
    const get = vi.fn().mockResolvedValue({ items: [room] });
    const client: ApiClient = { get, post: vi.fn(), patch: vi.fn(), del: vi.fn() };
    const rooms = await fetchRooms(client);
    expect(get).toHaveBeenCalledWith('/v1/classes/rooms');
    expect(roomNames(rooms).get('r1')).toBe('Studio 1');
  });

  it('keeps coaches then admins, by name, and drops members', () => {
    const staff = staffOf([
      person('m', 'Mia', 'member'),
      person('a', 'Ana', 'admin'),
      person('c2', 'Zoe', 'coach'),
      person('c1', 'Leo', 'coach'),
    ]);
    expect(staff.map((p) => p.id)).toEqual(['c1', 'c2', 'a']);
  });
});

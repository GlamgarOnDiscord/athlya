/**
 * Rooms of the studio (`GET /v1/classes/rooms`, issue #748), read by the
 * admin planning, the coach schedule and the rooms settings page, and
 * the staff a class can be given to (coaches and admins from the member
 * directory).
 */
import { fetchMemberDirectory, type StudioMember } from './members';

import type { ApiClient } from './client';
import type { Room, RoomListResponse } from '@athlya/shared/schemas/api';

export async function fetchRooms(client: ApiClient): Promise<ReadonlyArray<Room>> {
  return (await client.get<RoomListResponse>('/v1/classes/rooms')).items;
}

/** Room id to name, for the planning tiles and filter. */
export function roomNames(rooms: ReadonlyArray<Room>): ReadonlyMap<string, string> {
  return new Map(rooms.map((room) => [room.id, room.name]));
}

/** Coaches first, then admins, each by name: the people a class can be assigned to. */
export function staffOf(members: ReadonlyArray<StudioMember>): StudioMember[] {
  const rank = (m: StudioMember): number => (m.role === 'coach' ? 0 : 1);
  return members
    .filter((m) => m.role === 'coach' || m.role === 'admin')
    .sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName));
}

export async function fetchStaff(client: ApiClient): Promise<StudioMember[]> {
  return staffOf((await fetchMemberDirectory(client)).items);
}

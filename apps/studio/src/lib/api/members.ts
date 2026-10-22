/**
 * Studio member directory reads shared by the dashboard (member count)
 * and the audit log (actor and target names).
 *
 * `GET /v1/members` is cursor-paginated and returns no total, so the
 * directory is walked page by page up to {@link MAX_MEMBER_PAGES}. When
 * the cap is reached before the last page, `complete` is false and the
 * caller shows the count as a lower bound.
 */
import type { ApiClient } from './client';
import type { Role } from '@athlya/shared/roles';

export interface StudioMember {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly avatarUrl: string | null;
  readonly createdAt: string;
}

interface MembersPage {
  readonly items: ReadonlyArray<StudioMember>;
  readonly nextCursor: string | null;
}

const MEMBERS_PAGE_LIMIT = 100;
const MAX_MEMBER_PAGES = 10;

interface MemberDirectory {
  readonly items: ReadonlyArray<StudioMember>;
  readonly complete: boolean;
}

export async function fetchMemberDirectory(client: ApiClient): Promise<MemberDirectory> {
  const items: StudioMember[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
    const params = new URLSearchParams({ limit: String(MEMBERS_PAGE_LIMIT) });
    if (cursor !== null) params.set('cursor', cursor);
    const result: MembersPage = await client.get<MembersPage>(`/v1/members?${params.toString()}`);
    items.push(...result.items);
    cursor = result.nextCursor;
    if (cursor === null) return { items, complete: true };
  }
  return { items, complete: false };
}

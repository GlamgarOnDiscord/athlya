import { describe, expect, it, vi } from 'vitest';

import { fetchMemberDirectory, type StudioMember } from './members';

import type { ApiClient } from './client';

function member(n: number): StudioMember {
  return {
    id: `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    email: `camille.durand+${String(n)}@example.com`,
    displayName: 'Camille Durand',
    role: 'member',
    avatarUrl: null,
    createdAt: '2026-09-02T09:15:00.000Z',
  };
}

function clientFor(get: ApiClient['get']): ApiClient {
  return { get, post: vi.fn(), patch: vi.fn(), del: vi.fn() };
}

describe('fetchMemberDirectory', () => {
  it('follows the cursor until the last page', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ items: [member(1)], nextCursor: 'c1' })
      .mockResolvedValueOnce({ items: [member(2)], nextCursor: null });
    const result = await fetchMemberDirectory(clientFor(get));
    expect(result.complete).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(get).toHaveBeenNthCalledWith(1, '/v1/members?limit=100');
    expect(get).toHaveBeenNthCalledWith(2, '/v1/members?limit=100&cursor=c1');
  });

  it('stops at the page cap and reports an incomplete directory', async () => {
    const get = vi.fn().mockResolvedValue({ items: [member(1)], nextCursor: 'more' });
    const result = await fetchMemberDirectory(clientFor(get));
    expect(result.complete).toBe(false);
    expect(get).toHaveBeenCalledTimes(10);
  });
});

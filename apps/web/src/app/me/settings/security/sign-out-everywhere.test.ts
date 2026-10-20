import { describe, expect, it, vi } from 'vitest';

import { signOutEverywhere } from './sign-out-everywhere';

describe('signOutEverywhere', () => {
  it('revokes every session, then signs out locally', async () => {
    const calls: string[] = [];
    const client = {
      post: vi.fn(async (path: string) => {
        calls.push(`post ${path}`);
        return undefined as never;
      }),
    };
    const signOutLocally = vi.fn(async () => {
      calls.push('local');
    });

    await expect(signOutEverywhere(client, signOutLocally)).resolves.toBe(true);
    expect(client.post).toHaveBeenCalledWith('/v1/auth/logout-all', {});
    expect(calls).toEqual(['post /v1/auth/logout-all', 'local']);
  });

  it('keeps the local session when the API call fails', async () => {
    const client = { post: vi.fn().mockRejectedValue(new Error('offline')) };
    const signOutLocally = vi.fn().mockResolvedValue(undefined);

    await expect(signOutEverywhere(client, signOutLocally)).resolves.toBe(false);
    expect(signOutLocally).not.toHaveBeenCalled();
  });

  it('reports success when the local sign-out fails after the revocation', async () => {
    const client = { post: vi.fn().mockResolvedValue(undefined) };
    const signOutLocally = vi.fn().mockRejectedValue(new Error('offline'));

    await expect(signOutEverywhere(client, signOutLocally)).resolves.toBe(true);
    expect(signOutLocally).toHaveBeenCalledTimes(1);
  });
});

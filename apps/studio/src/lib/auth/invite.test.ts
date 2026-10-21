import { describe, expect, it } from 'vitest';

import { inviteLink, readInviteToken } from './invite';

const TOKEN = 'a'.repeat(21) + '-' + 'B'.repeat(20) + '_';

describe('invitation links', () => {
  it('round-trips a token through the link fragment', () => {
    const link = inviteLink('https://studio.athlya.app', TOKEN);
    expect(link).toBe(`https://studio.athlya.app/login#invite=${TOKEN}`);
    expect(readInviteToken(new URL(link).hash)).toBe(TOKEN);
  });

  it('ignores a missing or malformed token', () => {
    expect(readInviteToken('')).toBeNull();
    expect(readInviteToken('#invite=short')).toBeNull();
    expect(readInviteToken('#other=1')).toBeNull();
  });
});

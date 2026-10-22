/**
 * Team invitation links (issue #756). The admin shares
 * `<console>/login#invite=<token>`: the token rides in the fragment, which
 * the browser never sends to a server nor puts in a Referer header.
 */
import { InvitationTokenSchema } from '@athlya/shared/schemas/api';

/** The invitation token of a URL fragment, or `null` when there is none. */
export function readInviteToken(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const parsed = InvitationTokenSchema.safeParse(params.get('invite'));
  return parsed.success ? parsed.data : null;
}

/** The link an invited person opens, on the console served at `origin`. */
export function inviteLink(origin: string, token: string): string {
  return `${origin}/login#invite=${encodeURIComponent(token)}`;
}

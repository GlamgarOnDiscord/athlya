# Studio team and roles

Who can do what in a studio, and how a person joins the team (issues #756
and #757). The capability matrix is `packages/shared/src/roles.ts`; the API
enforces it with `requireCapability(...)`, the RLS policies of migration
0052 mirror it, and the console reads it to gate its pages.

## Roles

| Capability                          | admin | manager | accueil | coach     |
| ----------------------------------- | ----- | ------- | ------- | --------- |
| Classes: create, edit, delete       | yes   | yes     | no      | no        |
| Planning                            | edit  | edit    | read    | read      |
| Programs: create, edit, archive     | yes   | yes     | no      | no        |
| Members directory                   | yes   | yes     | read    | read      |
| Member file                         | yes   | yes     | read    | no        |
| Roster and attendance               | all   | all     | all     | own class |
| Check-in kiosk                      | yes   | yes     | yes     | yes       |
| Audit log                           | yes   | yes     | no      | no        |
| Team: see                           | yes   | yes     | no      | no        |
| Team: invite, change a role, remove | yes   | no      | no      | no        |
| Billing, branding                   | yes   | no      | no      | no        |

Platform operations (`/admin/*`: outbox, DLQ, key rotation) stay behind
Cloudflare Access and the `admin` role; a manager never reaches them.

## Joining the team

1. An admin opens Configuration, Team, and invites an email with a role.
2. If an account of the studio already uses that email, the role applies
   at once. Otherwise the console shows an invitation link, once:
   `<console>/login#invite=<token>`. The token travels in the fragment,
   never in a server log; only its SHA-256 digest is stored. It expires
   after 7 days and a new invitation to the same email replaces it.
3. The invitee creates an account at the studio with the invited email
   (member app), opens the link and signs in: the console accepts the
   invitation and refreshes the session with the new role.

An admin cannot change their own role, so a studio always keeps one.
Removing a person sets their account back to `member`. Every role change
bumps `credentials_version`: the person's current access token can no
longer mutate, and the next refresh carries the new role (15 minutes at
most).

## Sessions (member settings)

`/me/settings/security` lists the member's active sessions (one per
refresh-token family in Redis) with a coarse device label and the last
activity, and revokes one (`DELETE /v1/auth/sessions/:id`). The id is a
truncated SHA-256 of the family root, never a session id. Sessions signed
in before this release show no device until they sign in again.

## Operator steps

- Apply migration `0052_team_roles.sql` (`node packages/db/scripts/migrate.mjs`)
  before deploying the Workers; it is expand-only.
- Rerun `node scripts/verify-role-contract.mjs` on staging: it now checks
  the four team functions are executable by `athlya_app`.

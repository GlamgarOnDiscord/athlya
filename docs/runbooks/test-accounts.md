# Test accounts (Studio Rive Gauche)

One account per studio role, in a fictional studio, to try the studio
console and the member app as each role (issue #758). The script is
`packages/db/scripts/seed-test-accounts.mjs`.

## Accounts

| Role    | Name           | Email                                    |
| ------- | -------------- | ---------------------------------------- |
| admin   | Camille Durand | `camille.durand@rive-gauche.athlya.test` |
| manager | Hugo Lefebvre  | `hugo.lefebvre@rive-gauche.athlya.test`  |
| accueil | Sarah Benali   | `sarah.benali@rive-gauche.athlya.test`   |
| coach   | Inès Garnier   | `ines.garnier@rive-gauche.athlya.test`   |
| member  | Léa Fontaine   | `lea.fontaine@rive-gauche.athlya.test`   |

The studio slug is `studio-rive-gauche`. `.test` is reserved (RFC 2606):
no email sent to these addresses (password reset, notifications) can reach
an inbox, so a password is changed by running the script again.

## Run it

1. Apply the migrations first, 0052 included (the `manager` and `accueil`
   roles).
2. Pick the password in a secret manager. It is never committed, never
   passed on the command line history of a shared machine, and at least
   12 characters (the register rule), at most 72 bytes (bcrypt).
3. Run, as the migration owner role (it bypasses RLS like the other seed
   scripts):

   ```sh
   # Both values are typed at a silent prompt, never on the command line,
   # so neither reaches the shell history.
   read -rs DATABASE_URL && export DATABASE_URL                     # migration owner role
   read -rs TEST_ACCOUNTS_PASSWORD && export TEST_ACCOUNTS_PASSWORD # from the secret manager
   APP_ENV=development node packages/db/scripts/seed-test-accounts.mjs
   ```

   `APP_ENV=staging` on the staging database.

The script is idempotent: the studio is matched by slug, each account by
email. A second run only reports `up to date`. A new password or a role
that drifted is written back and bumps `credentials_version`, so tokens
issued before stop mutating. An address already used by an account of
another studio stops the run and nothing is written (one transaction).

## Guards

- Only `APP_ENV=development` or `APP_ENV=staging` runs without
  `--allow-production`. An unset or unknown `APP_ENV` counts as
  production, since a tunnel to the production database looks local to
  the host guard. Seeding production needs Tom's or Pierre's agreement
  first.
- A non-local host needs `ATHLYA_ALLOW_DANGEROUS_WRITE=1`
  (`packages/db/scripts/_guard.mjs`), as for the other scripts.
- Neither the password nor the connection string is ever printed.

## Demo build

The Vercel demo build (`NEXT_PUBLIC_DEMO_MODE=1`, issue #750) has the same
five people, with `@example.com` addresses and no database: `/login`
offers one button per profile and an in-memory fake API answers with the
profile's role, so each one sees what its capabilities allow (issue #771).
The demo password is `demo`.

| Role    | Name           | Email                        | App            |
| ------- | -------------- | ---------------------------- | -------------- |
| admin   | Camille Durand | `camille.durand@example.com` | studio console |
| manager | Hugo Lefebvre  | `hugo.lefebvre@example.com`  | studio console |
| accueil | Sarah Benali   | `sarah.benali@example.com`   | studio console |
| coach   | Inès Garnier   | `ines.garnier@example.com`   | studio console |
| member  | Léa Fontaine   | `lea.fontaine@example.com`   | member app     |

A member cannot use the studio console, so the member profile is on the
member app's `/login`. The profiles live in
`apps/studio/src/components/demo/DemoRolePicker.tsx`,
`apps/studio/src/lib/demo/fixtures.ts` and `apps/web/src/lib/demo/`.

## Remove them

Soft-delete the five accounts from the studio console or with
`DELETE /v1/auth/me` signed in as each; the RGPD purge does the rest.

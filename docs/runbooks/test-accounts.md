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
   export DATABASE_URL=...            # migration owner role
   export TEST_ACCOUNTS_PASSWORD=...  # from the secret manager
   node packages/db/scripts/seed-test-accounts.mjs
   ```

The script is idempotent: the studio is matched by slug, each account by
email. A second run only reports `up to date`. A new password or a role
that drifted is written back and bumps `credentials_version`, so tokens
issued before stop mutating. An address already used by an account of
another studio stops the run and nothing is written (one transaction).

## Guards

- `APP_ENV=production` refuses to run unless `--allow-production` is
  passed. Seeding production needs Tom's or Pierre's agreement first.
- A non-local host needs `ATHLYA_ALLOW_DANGEROUS_WRITE=1`
  (`packages/db/scripts/_guard.mjs`), as for the other scripts.
- Neither the password nor the connection string is ever printed.

## Remove them

Soft-delete the five accounts from the studio console or with
`DELETE /v1/auth/me` signed in as each; the RGPD purge does the rest.

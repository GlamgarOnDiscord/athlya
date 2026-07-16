# Legal content checklist — before production deploy

**Issue #516.** Run `pnpm check:legal` to verify no bracket placeholders remain.
The production deploy workflow runs this check automatically and blocks on failure.

## Required fields in `apps/web/src/app/legal/page.tsx`

Replace every `[...]` placeholder with real, counsel-approved values:

| Placeholder                   | Required value                              |
| ----------------------------- | ------------------------------------------- |
| `[forme juridique]`           | Legal form (e.g. SAS, SARL, SA)             |
| `[montant]`                   | Share capital amount in EUR                 |
| `[Adresse du siège]`          | Registered office street address            |
| `[ville]`                     | City of RCS registration                    |
| `[numéro]` (RCS)              | RCS registration number                     |
| `[numéro]` (SIRET)            | SIRET number (14 digits)                    |
| `[numéro]` (TVA)              | EU VAT number                               |
| `[Nom du représentant légal]` | Full name of the publication director / CEO |

## Required fields in `apps/web/src/app/privacy/page.tsx`

| Placeholder          | Required value                                   |
| -------------------- | ------------------------------------------------ |
| `[adresse du siège]` | Registered office address of the data controller |

## Hosting disclosure

`legal/page.tsx` must accurately list every host with name, address, and telephone:

- Cloudflare Workers (API compute) — already filled
- Vercel (member web app frontend) — **add Vercel address and telephone**
- Neon Postgres — already filled
- Upstash Redis — already filled

## Review gate

- [ ] DPO / legal counsel has reviewed all values
- [ ] `pnpm check:legal` exits 0
- [ ] `/legal` and `/privacy` pages reviewed on staging (no `[` in rendered HTML)
- [ ] Hosting disclosure matches deployed architecture (Vercel + Cloudflare Workers)

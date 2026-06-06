# CI GitHub Actions — recovery (issue #123)

**Owner:** SRE / platform  
**Contexte:** quota Actions epuise ou runners indisponibles → checks `ci`, `pgtap`, `integration-docker` en echec immediat (~3s).

---

## Diagnostic rapide

```powershell
gh run list --branch master --limit 5
gh run view <run-id> --log-failed
```

Symptomes quota billing :

- Jobs echouent en quelques secondes sans logs de tests
- Message billing / spending limit dans Settings → Billing → Actions
- Tous les workflows echouent simultanement sur `master` et PRs

---

## Option A — Restaurer le quota GitHub (recommande)

1. **Settings → Billing and plans → Actions**
2. Augmenter spending limit ou acheter minutes supplementaires
3. Declencher un run manuel :
   ```powershell
   gh workflow run ci.yml --ref master
   gh workflow run pgtap.yml --ref master
   gh workflow run integration-docker.yml --ref master
   ```
4. Attendre 3 runs `master` consecutifs verts :
   ```powershell
   node scripts/verify-ci-health.mjs
   ```

---

## Option B — Self-hosted runners (Docker lourds)

1. VM EU (Ubuntu 22.04+) avec Docker + Node 20
2. **Settings → Actions → Runners → New self-hosted**
3. Labels : `self-hosted`, `linux`, `athlya-docker`
4. Adapter `integration-docker.yml` et `pgtap.yml` :

```yaml
runs-on: [self-hosted, linux, athlya-docker]
```

5. Securite : runner dedie repo, pas de PR forks sans approval.

---

## Option C — Reduction consommation

- Desactiver workflows non bloquants temporairement (`explain-analyze`, `axe`) via workflow_dispatch only
- Limiter `paths` triggers sur `pgtap.yml` / `integration-docker.yml` (deja partiel)
- Cache pnpm agressif (deja en place dans `ci.yml`)

---

## Branch protection (post-recovery)

Verifier [`branch-protection.md`](./branch-protection.md) :

| Check requis               | Workflow                 |
| -------------------------- | ------------------------ |
| Lint, typecheck, and tests | `ci.yml`                 |
| Property tests (Docker)    | `integration-docker.yml` |
| pgTAP RLS suite            | `pgtap.yml`              |

```powershell
gh api repos/GlamgarOnDiscord/athlya/branches/master/protection 2>$null
```

Si absent : appliquer manuellement dans Settings → Branches → `master`.

---

## Validation

```powershell
node scripts/verify-ci-health.mjs --strict
node scripts/verify-ci-provision-checklist.mjs
```

Critere issue #123 :

- [ ] 3 runs `master` verts consecutifs (`ci` + `pgtap` + `integration-docker`)
- [ ] Branch protection avec checks requis
- [ ] README badge CI a jour (ou note si billing limite)

---

## References

- `.github/workflows/ci.yml`
- `.github/workflows/pgtap.yml`
- `.github/workflows/integration-docker.yml`
- Issue #67, #123

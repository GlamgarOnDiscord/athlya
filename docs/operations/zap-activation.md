# OWASP ZAP baseline — activation procedure

**Sprint 14 / Slice 14.8 (Epic CN.3.3)**

Procédure ops pour activer le scan ZAP automatique sur chaque PR.

## Pré-requis

- Workflow `.github/workflows/zap-baseline.yml` déjà scaffoldé
  (Task 13.2, Sprint 1).
- Staging URL Cloudflare Workers stable + accessible publiquement
  sur HTTPS.
- Compte admin GitHub avec accès Settings → Secrets and variables.

## Activation step-by-step

### Step 1 — Vérifier le staging URL

Le workflow ZAP scan une seule URL (la racine `/`). Le spider
ZAP crawl les liens depuis cette racine.

```bash
# Vérifier que le staging répond proprement.
curl -I https://staging.api.athlya.app/health
# Doit retourner HTTP/2 200 + headers de sécurité.
```

### Step 2 — Provisionner la variable ZAP_TARGET_URL

GitHub Settings → Secrets and variables → Actions → Variables tab.

Créer une **repository variable** (PAS un secret — la URL est
publique) :

- **Name** : `ZAP_TARGET_URL`
- **Value** : `https://staging.api.athlya.app`

⚠️ **NE PAS** trailing slash — le baseline action le rajoute.

### Step 3 — Tester via workflow_dispatch

Avant d'activer sur les PRs, valider le scan tourne :

1. GitHub Actions tab → "OWASP ZAP Baseline" → "Run workflow"
2. Laisser `target_url` vide (utilise la variable provisionnée)
3. Run

Le workflow doit :
- Spider le staging
- Émettre un rapport HTML + JSON
- Fail si findings HIGH (les MEDIUM/LOW sont warning only)

### Step 4 — Validation des findings initiaux

Premier run typiquement remonte 5-15 findings :

| Type | Action standard |
|---|---|
| HSTS missing | Provisionner via `wrangler secret put` (déjà câblé en code, manque le binding) |
| CSP issues | Vérifier `packages/api/src/middleware/security-headers.ts` — si false positive, suppress dans `.zap/rules.tsv` |
| X-Content-Type-Options missing | Vérifier headers, suppress si false positive |
| Cookie without secure flag | Vérifier sur dev/staging → ne devrait JAMAIS arriver en prod |

Pour chaque finding :
1. **Code-fixable** → ouvrir une PR, le scan re-tournera dessus
2. **False positive** → ajouter une ligne dans `.zap/rules.tsv` :
   ```
   10038	IGNORE	# X-Content-Type-Options missing on /health → not applicable
   ```
3. **Accepted risk** → documenter dans `docs/security/risk-register.md` (slice future)

### Step 5 — Activer sur les PRs

Une fois le baseline initial validé (rapport HTML reviewable +
findings adressés), aucune action additionnelle n'est requise.
Le workflow tourne automatiquement sur **chaque PR**.

Si on veut désactiver temporairement (ex: maintenance staging) :
- Vider la variable `ZAP_TARGET_URL` (ne pas la supprimer — le
  guard step skip cleanly avec un message)
- Le workflow continue à tourner mais skip immédiatement.

## Rule customization

Le fichier `.zap/rules.tsv` contient des suppressions :

```tsv
# Plugin ID	Action	Comment
10020	IGNORE	# X-Frame-Options missing on /v1/* — API only, not embedded
10038	WARN	# CSP X-Content-Type-Options check — duplicated by 10021
```

Format : `<plugin-id>\t<IGNORE|WARN|FAIL>\t<comment>`. Les plugin
IDs ZAP sont documentés sur
<https://www.zaproxy.org/docs/alerts/>.

## Schedule scan complet (slice future)

Le baseline scan est passif (spider + headers check). Pour des
scans actifs (XSS / SQL injection submission), créer un workflow
séparé qui tourne sur un staging dédié (pas le staging shared)
toutes les semaines :

```yaml
# .github/workflows/zap-full-scan.yml
on:
  schedule:
    - cron: '0 4 * * 1'  # Monday 04:00 UTC
```

Out of scope Sprint 14.

## Alertes

Slack ops : configurer un webhook GitHub Actions sur le workflow
`zap-baseline` pour pinger #ops-athlya-alerts si un fail HIGH est
détecté en main.

## Provisioning checklist

| Item | Status | Owner |
|---|---|---|
| Staging URL stable | ⏳ | DevOps |
| Variable `ZAP_TARGET_URL` provisionnée | ⏳ | DevOps |
| Premier run validé manually | ⏳ | DevOps + Eng |
| Slack alert configuré | ⏳ | DevOps |
| Rules `.zap/rules.tsv` revues | ✅ scaffolded | Eng |

## Références

- `.github/workflows/zap-baseline.yml` — workflow scaffolded
- `.zap/rules.tsv` — suppressions
- ZAP docs: <https://www.zaproxy.org/docs/desktop/start/features/scanpolicy/>

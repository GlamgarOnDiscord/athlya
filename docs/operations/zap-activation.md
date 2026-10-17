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

| Type                           | Action standard                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| HSTS missing                   | Provisionner via `wrangler secret put` (déjà câblé en code, manque le binding)                                 |
| CSP issues                     | Vérifier `packages/api/src/middleware/security-headers.ts` — si false positive, suppress dans `.zap/rules.tsv` |
| X-Content-Type-Options missing | Vérifier headers, suppress si false positive                                                                   |
| Cookie without secure flag     | Vérifier sur dev/staging → ne devrait JAMAIS arriver en prod                                                   |

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

**Fail-closed (issue #340)** : une variable `ZAP_TARGET_URL` vide fait
**échouer** le job sur toute exécution de confiance (PR du même dépôt,
`workflow_dispatch`). Seules les PR issues de forks sautent le scan
proprement (pas d'accès aux variables ni à l'environnement de scan).
Pour une maintenance du staging, utiliser `workflow_dispatch` avec un
`target_url` alternatif plutôt que vider la variable.

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

## Scan actif hebdomadaire

`.github/workflows/zap-active.yml` lance chaque lundi 02:00 UTC un scan
**actif** (`zaproxy/action-full-scan`, épinglé par SHA) contre
`ZAP_ACTIVE_TARGET_URL`. Cette cible doit être un environnement **dédié,
peuplé de données synthétiques** : le scan envoie de vrais payloads
d'attaque. Une variable vide fait **échouer** le run planifié.

## Couverture — ce que les scans prouvent (et ne prouvent pas)

| Couvert                                                                   | Non couvert                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Baseline : en-têtes de sécurité, cookies, fuites d'info dans les réponses | Routes authentifiées (aucun login scripté : seules les pages publiques)  |
| Baseline : pages atteignables par le spider depuis la cible               | Endpoints JSON non liés depuis une page (`/v1/*` hors spider)            |
| Actif : injections (SQLi, XSS, path traversal) sur les URLs découvertes   | Logique métier (IDOR, isolation multi-tenant) — couverte par pgTAP/tests |
| Actif : findings HIGH/MEDIUM ouverts automatiquement en issues GitHub     | Webhooks signés (Stripe) et flux asynchrones (Queues, cron)              |

La preuve d'exécution est l'artefact `zap-baseline-report` /
`zap-active-report-<run_id>` (rapports HTML + JSON) attaché au run.

## Alertes

Slack ops : configurer un webhook GitHub Actions sur le workflow
`zap-baseline` pour pinger #ops-athlya-alerts si un fail HIGH est
détecté en main.

## Provisioning checklist

| Item                                        | Status        | Owner        |
| ------------------------------------------- | ------------- | ------------ |
| Staging URL stable                          | ⏳            | DevOps       |
| Variable `ZAP_TARGET_URL` provisionnée      | ⏳            | DevOps       |
| Env de scan dédié + `ZAP_ACTIVE_TARGET_URL` | ⏳            | DevOps       |
| Premier run validé manually                 | ⏳            | DevOps + Eng |
| Slack alert configuré                       | ⏳            | DevOps       |
| Rules `.zap/rules.tsv` revues               | ✅ scaffolded | Eng          |

## Références

- `.github/workflows/zap-baseline.yml` — scan passif sur chaque PR
- `.github/workflows/zap-active.yml` — scan actif hebdomadaire
- `.zap/rules.tsv` — suppressions
- ZAP docs: <https://www.zaproxy.org/docs/desktop/start/features/scanpolicy/>

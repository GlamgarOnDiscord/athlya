# CSP report-uri provisioning

**Sprint 15 / Slice 15.2 (Epic SP5.9 + SP6.8)**

Procédure ops pour activer `report-uri` sur la directive CSP du
gateway Athlya — collecte les violations CSP en prod pour
détecter les XSS attempts et les false positives de la policy.

## Contexte

Le middleware `packages/api/src/middleware/security-headers.ts`
émet une CSP stricte avec `script-src 'nonce-…'` + `style-src
'self' 'nonce-…'` etc. Quand un script bloqué tente de s'exécuter,
le browser POST un rapport JSON sur l'URL configurée dans
`report-uri`. Sans cette URL, on n'a aucune visibilité sur les
violations.

## Pré-requis

- Service de réception des reports CSP (3 options ci-dessous)
- Variable Next.js `NEXT_PUBLIC_CSP_REPORT_URI` provisionnée par
  environnement (staging + production)

## Option A — Sentry CSP report endpoint (recommandé)

Sentry expose nativement un endpoint qui parse les reports CSP et
les agrège dans la dashboard Issues.

### Setup

1. Sentry UI → Project Settings → Security Headers
2. Copier l'endpoint personnalisé (forme :
   `https://o123.ingest.sentry.io/api/456/security/?sentry_key=…`)
3. Provisionner :
   ```bash
   # Staging
   wrangler secret put NEXT_PUBLIC_CSP_REPORT_URI --env staging
   # > paste the Sentry endpoint
   ```
4. Idem prod.

### Avantages

- Inclus dans le plan Sentry existant (pas de coût additionnel)
- Group by source-file + browser → réduit le bruit
- Alerts sur spike (intégré aux règles Sentry)

## Option B — Endpoint custom Cloudflare Worker

Si on ne veut pas envoyer les reports à Sentry (privacy stricte),
on peut héberger l'endpoint dans un Worker dédié :

```ts
// packages/csp-collector/src/worker.ts
export default {
    async fetch(request: Request, env: { CSP_REPORTS: KVNamespace }) {
        if (request.method !== 'POST') return new Response('', { status: 405 });

        const body = await request.json();
        const key = `csp-${Date.now()}-${crypto.randomUUID()}`;
        await env.CSP_REPORTS.put(key, JSON.stringify(body), { expirationTtl: 7 * 86400 });

        return new Response('', { status: 204 });
    },
};
```

Slice future si on en arrive là. Pour Sprint 15, **Option A
(Sentry)** est l'approche par défaut.

## Option C — report-uri.com (public service)

<https://report-uri.com/> offre un free tier (10k reports/jour).
Setup en 5 min, pas de code à écrire. Mais : data envoyée à un
tiers US — RGPD-pas-idéal pour un studio européen.

Acceptable pour staging, pas pour production.

## Activation step-by-step (Option A)

### Step 1 — Provisionner la variable

```bash
# Récupérer l'endpoint Sentry CSP via UI.
SENTRY_CSP_URL='https://o123.ingest.sentry.io/api/456/security/?sentry_key=abcdef'

# Staging
wrangler secret put NEXT_PUBLIC_CSP_REPORT_URI --env staging <<< "$SENTRY_CSP_URL"

# Production
wrangler secret put NEXT_PUBLIC_CSP_REPORT_URI --env production <<< "$SENTRY_CSP_URL"
```

### Step 2 — Vérifier le wirering existant

Le middleware `security-headers.ts` lit déjà la variable et
l'inclut dans la directive CSP quand elle est définie :

```ts
const reportUri = env.NEXT_PUBLIC_CSP_REPORT_URI;
if (reportUri) {
    cspDirectives.push(`report-uri ${reportUri}`);
    cspDirectives.push(`report-to csp-endpoint`);
}
```

(Vérifier la présence en grep sur `report-uri` dans le middleware
avant de redéployer — slice future si manquant.)

### Step 3 — Test manuel

Forcer une violation CSP en injectant un script inline non-noncé
dans une page test :

```html
<!-- staging only, à retirer après test -->
<script>console.log('csp-test')</script>
```

Le browser DevTools → Console doit montrer "Refused to execute
inline script". Sentry → Issues doit recevoir un report dans la
minute.

### Step 4 — Configurer alerting Sentry

Créer une alert rule dans Sentry :
- Fires when : CSP violation rate > 10/min
- Action : Slack #ops-athlya-alerts

CSP violations en steady state devraient être ~0 (les pages prod
sont noncées proprement). Une spike = soit un XSS attempt, soit
un browser plugin qui pollue (typique : extensions Chrome qui
injectent du CSS).

## Provisioning checklist

| Item | Status | Owner |
|---|---|---|
| Sentry project provisionné (Option A) | ⏳ | DevOps |
| Endpoint URL récupéré | ⏳ | DevOps |
| `NEXT_PUBLIC_CSP_REPORT_URI` staging | ⏳ | DevOps |
| `NEXT_PUBLIC_CSP_REPORT_URI` production | ⏳ | DevOps |
| Test manuel violation CSP | ⏳ | DevOps + Eng |
| Sentry alert rule créée | ⏳ | DevOps |

## Références

- `packages/api/src/middleware/security-headers.ts` — directive CSP
- Sentry Security Headers docs:
  <https://docs.sentry.io/product/security-policy-reporting/>
- MDN Content-Security-Policy directive:
  <https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy>
- Audit finding S6-006 (Sprint 1 audit) — résolution

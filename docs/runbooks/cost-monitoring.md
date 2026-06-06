# Cost monitoring — Athlya ops

Runbook pour surveiller les coûts récurrents avant scale multi-studios (issue #82).

## Estimation rapide (req / membre / jour)

| Flux               | Redis cmds / action | Notes                         |
| ------------------ | ------------------- | ----------------------------- |
| Login              | ~3                  | rate limit + session          |
| Booking            | ~5–8                | lock + capacity + idempotency |
| Refresh token      | ~2                  | rotate Lua                    |
| Health (synthetic) | 0                   | pas de Redis si probe seule   |

Ordre de grandeur pilote (50 membres actifs, 2 sessions/jour) :

- **~500–1500** commandes Redis/jour → sous free tier 10k
- **~2000–5000** requêtes Workers/jour → sous free tier 100k
- **Neon** : compute proportionnel aux connexions Hyperdrive + requêtes SQL

Au-delà de **5 studios** ou **500 membres** : budget **150–250 €/mois** (voir README TCO).

## Seuils d'alerte (à configurer dans chaque console)

| Provider           | Métrique           | Seuil recommandé          | Action                                      |
| ------------------ | ------------------ | ------------------------- | ------------------------------------------- |
| Upstash            | commands/day       | 80 % quota plan           | Vérifier rate limit + booking hot keys      |
| Neon               | compute hours / CU | 80 % plan                 | Index lents, pool Hyperdrive                |
| Cloudflare Workers | requests + CPU ms  | Paid tier cap             | OTel sampling (#83), health probe frequency |
| Cloudflare Queues  | backlog depth      | > 1000 5 min              | `docs/runbooks/outbox-ops.md`               |
| Upstash QStash     | messages/day       | 80 % quota (400/500 free) | `docs/runbooks/qstash-quota.md`             |
| Resend             | emails/month       | 80 % quota                | Désactiver digests non critiques            |
| Axiom              | ingest GB/month    | 80 % quota                | Baisser `OTEL_SAMPLE_RATE` si besoin        |

## Upstash — alerte commands/day

1. Console Upstash → Database → **Usage** → alerte email à 80 % du quota journalier.
2. Si alerte récurrente : audit des clés `ratelimit:*`, `session:*`, `booking:*` dans les logs Worker.
3. **Fail-open rate limit** (#6) : quota dépassé → plus de trafic accepté + facture surprise. Monter de plan ou activer politique stricte côté ops.

## Upstash QStash — messages/day (issue #126)

1. Console Upstash → **QStash** → Usage → alerte **80 %** quota journalier (500/j free → seuil 400).
2. Monitor Axiom **A14** sur logs `qstash.publish.failed` / `qstash.quota.degraded` (voir `docs/operations/axiom-alerts.md`).
3. **Upgrade plan** dès 2e studio pilote ou sustained >400 msg/j.
4. Projection **5 studios** : ~1000+ msg/j → tier payant obligatoire (~10–20 €/mois) — détail [`qstash-quota.md`](./qstash-quota.md).

Checklist : `node scripts/verify-qstash-quota-checklist.mjs`

## Neon — compute

1. Neon console → **Monitoring** → alerte sur compute hours.
2. Corréler avec pics `reservations.book` p99 (`docs/operations/axiom-alerts.md` A2).
3. Preview PR : un worker par PR — ne pas laisser d'orphelins (`docs/runbooks/preview-pr.md`).

## Cloudflare Workers + Queues

1. Dashboard → Workers & Pages → **athlya-api-production** → Analytics.
2. Alerte billing account sur dépassement included requests (Paid plan).
3. Queues : consumer lag → `docs/runbooks/event-bus.md`.

## Axiom / OTel

Prod : `OTEL_SAMPLE_RATE=0.1`, probes `/health*` ~1 %, 5xx toujours exportés.

Alerte Axiom : ingest > 80 % quota → `#ops-athlya-alerts` (voir aussi `docs/operations/axiom-alerts.md`).

## Revue hebdomadaire (15 min)

1. TCO README vs factures (Neon, Upstash, CF, Resend).
2. Delta > 20 % → ticket infra.
3. Workers preview orphelins.

## Références

- README § Coûts opérationnels
- `docs/operations/axiom-alerts.md`
- `docs/runbooks/qstash-quota.md` (issue #126)
- Issues #6 (rate limit fail-closed), #83 (OTel sampling)

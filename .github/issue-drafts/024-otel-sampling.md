## Résumé

`wrangler.toml` `[observability] head_sampling_rate = 1.0` — **100% traces** exportées OTel jusqu'à trafic sustained. Commentaire : « dial down per environment once OTel wired » — jamais fait.

## Impact

- Coût Axiom ingest à l'échelle
- Overhead Worker middleware otel.ts par request
- Storage explosion traces non pertinentes (health checks)

## Solution proposée

### Par environnement

| Env        | Sampling                          |
| ---------- | --------------------------------- |
| dev        | 1.0                               |
| staging    | 0.5                               |
| production | 0.1 (ou tail-based via collector) |

### Implementation

`middleware/otel.ts` — `Math.random() < sampleRate` before export.

Ou Cloudflare observability config si supporté.

### Exclusions

Never sample : `/health`, `/health/ready` (ou sample 0.01)

Always sample : 5xx responses (tail-based)

## Critères d'acceptation

- [ ] production sample rate ≤ 0.2
- [ ] 5xx toujours traced (test)
- [ ] Doc ops Axiom budget
- [ ] Pas de perte debug capability (traceId toujours loggé)

## Priorité

**P2** — avant trafic > 100k req/jour

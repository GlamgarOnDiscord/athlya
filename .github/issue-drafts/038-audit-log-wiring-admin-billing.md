## Résumé

Actions admin sensibles (JWT rotate prep, webhook Stripe) **n'écrivent pas** dans `audit_log` de façon fiable. `appendAudit` no-op ou non branché sur ces chemins. TODO commenté `worker.ts` ~L1156.

**Finding audit** : C2 — gravité **High**, priorité **P1**.

Couplé à issue #87/#88 (audit INSERT policy).

## Chemins concernés

| Action                    | État audit trail                                    |
| ------------------------- | --------------------------------------------------- |
| `POST /admin/jwt/prepare` | TODO / no-op                                        |
| Stripe webhook processed  | reason parfois générique (#56 fermée partiellement) |
| Consent PATCH             | dépend cutover athlya_app                           |

## Impact production

- Conformité : pas de traçabilité actions admin / billing
- Incident forensics **impossible**
- CNIL / audit sécurité : finding majeur

## Solution proposée

1. Résoudre #88 (policy INSERT audit_log)
2. Brancher `appendAudit` sur :
   - JWT rotate prepare/confirm
   - Stripe webhook success/failure (actor = system, metadata event id)
   - DLQ replay/discard (actor = admin user id)
3. Tests intégration : action → row audit_log queryable

## Critères d'acceptation

- [ ] JWT rotate laisse trace audit
- [ ] Webhook Stripe trace avec stripe_event_id
- [ ] DLQ admin actions tracées
- [ ] pgTAP + test API verts

## Références

- `packages/api/src/worker.ts` admin routes
- Issue #56 (Stripe audit reason)
- Audit prod 2026-05-27 — C2

## Priorité

**P1** — compliance ops

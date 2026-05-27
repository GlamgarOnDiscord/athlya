# Hardening Plan — Phase 1 décisions

> Inséré entre l'Epic 8 (gateway middleware) et l'Epic 10 (clients). **Ne change pas la direction** — consolide les fondations avant d'empiler les apps.

## Décisions arrêtées

### H1. Audit log anonymisation (Req 5.3 vs 22.2)

**Décision** : `SECURITY DEFINER` function PostgreSQL.

- La policy RLS refuse `UPDATE`/`DELETE` sur `audit_log` pour **tous** les rôles applicatifs, y compris `admin` et `athlya_cron`.
- Seule la fonction `anonymize_user_audit(user_id uuid)`, owned par `athlya_owner`, peut muter la table.
- `EXECUTE` sur la fonction est granté uniquement à `athlya_cron`, le rôle du worker de cron RGPD J+30.
- Si un bug middleware force accidentellement le rôle `athlya_cron`, il accède à UNE fonction scoped, pas à `UPDATE audit_log SET *`.

**Livrables** :
- Migration `0003_audit_anonymization.sql` (fonction + REVOKE ALL + GRANT EXECUTE).
- Test pgTAP : UPDATE direct refusé, appel de la fonction accepté, fonction produit bien `actor_id = NULL` + metadata stripped.
- Update de Req 5.3 et 22.2 : ✅ fait (voir requirements.md).

### H3. Circuit breaker — per-isolate assumé (issue #73)

**Décision** : état per-isolate, documenté comme best-effort local. **Pas** de breaker Redis global (Option A issue #73 rejetée).

Raison :
- Les isolates Workers sont courts (éviction ~15 s idle). La dérive multi-isolates se corrige vite d'elle-même.
- La valeur du breaker = "arrêter de taper un service mort pendant 60 s" reste préservée par-isolate.
- La coordination globale d'une dépendance morte est déjà assurée par Cloudflare fast-fail + Hyperdrive + Upstash SLA.
- Redis-backed state ajouterait +5–10 ms sur chaque downstream call et contredirait le SLO p99 < 500 ms.

**ADR** : `docs/security/circuit-breaker-adr.md`

**Livrables** (faits) :
- JSDoc « Semantics under Cloudflare Workers » dans `circuit-breaker.ts`.
- Test `isolate independence (H3 invariant)` + property open short-circuit.
- Pas de changement runtime supplémentaire.

### H6. Axiom au lieu de Baselime

**Décision** : Axiom comme target OTLP par défaut.

- Axiom (axiom.co) accepte OTLP/HTTP JSON exactement comme Baselime le faisait.
- Free tier : 500 GB/mois ingest, rétention 30 jours.
- Endpoint : `https://api.axiom.co/v1/traces`.
- Auth : header `Authorization: Bearer <API_TOKEN>` + `X-Axiom-Dataset: athlya-api`.

**Livrables** :
- Remplacer toutes les occurrences `baselime` dans les sources (JSDoc, tests, types) par `axiom` ou par un terme neutre "OTLP endpoint".
- `wrangler.toml` : commentaire expliquant quelle valeur mettre.
- Pas de changement de code actif — l'exporter est agnostique.

### H8. README opérationnel honnête

**Décision** : ajouter un `README.md` racine qui dit la vérité.

Contient :
- **TCO réaliste** : ~150-250 €/mois pour staging + prod dès le premier utilisateur payant (Neon, Upstash, Sentry, Axiom, Resend au-delà du free tier).
- **Limites assumées v0.1** :
  - Circuit breaker best-effort per-isolate.
  - DLQ queue : drain manuel, visibilité via `/admin/dlq/stats`, alerte manuelle.
  - Testcontainers skippés sans Docker (suites marquées `describe.skipIf(!dockerReady)`).
  - OTel exporter hand-rolled (pas de SDK officiel).
  - Sentry envelope minimal (pas de breadcrumbs, pas de session tracking).
- **Procédure incident** : `x-trace-id` → Axiom query → Sentry event → log Worker Tail.
- **Matrice fournisseurs** + chemins d'éjection : Neon → PG standard, Upstash → Redis self-hosted, Resend → SMTP, Cloudflare Queues → RabbitMQ / SQS.

## Tâches d'implémentation (Phase 2-3)

| Tâche | Type | Subagent |
|---|---|---|
| H1-code | migration SQL + pgTAP test | 1 subagent |
| H2 | `drain-dlq.ts` + endpoint `/admin/dlq/*` | 1 subagent |
| H3-code | JSDoc update + isolate independence test | 1 subagent (léger) |
| H4 | Middleware chain integration tests in-process Hono | 1 subagent |
| H5 | Extraire `@athlya/ratelimit` (casser le cycle) | 1 subagent |
| H6-code | Remplacer "baselime" → "axiom" dans sources | 1 subagent (léger) |
| H7 | `down.sql` pour migrations 0000/0001/0002 + nouvelle 0003 | 1 subagent |
| H8-code | Écrire `README.md` racine | doc directe |

**Exécution prévue** : 2 vagues de ~4 subagents en parallèle, puis finalisation doc.

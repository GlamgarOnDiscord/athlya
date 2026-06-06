# QStash quota — alerting et escalation (issue #126)

**Owner:** SRE / platform  
**Contexte:** free tier Upstash QStash **500 messages/jour**. Les rappels cours (`reservation.reminder`, 1h avant) consomment ~1 message QStash par booking confirmé. Saturation silencieuse = rappels non envoyés sans signal ops.

**État code v1.0:** l'adapter `@upstash/qstash` n'est pas encore branché en prod (`cascade-deps` stub, scheduler reminders non câblé). Ce runbook couvre le **provisioning alertes** et le contrat logs pour le wiring futur.

---

## Charge projetée

| Scénario                     | Msgs QStash / jour   | Verdict                     |
| ---------------------------- | -------------------- | --------------------------- |
| 1 studio, 50 bookings/j      | ~50                  | OK free tier                |
| 1 studio, 100 membres actifs | **200+**             | OK mais marge faible        |
| 2 studios pilotes            | **400+**             | Alerte 80 % (~400)          |
| **5 studios** × 100 membres  | **1000+**            | **Tier payant obligatoire** |
| + anonymisation J+30 (RGPD)  | +faible vs reminders | Négligeable au début        |

**Règle ops:** upgrade plan QStash dès le **2e studio** ou si sustained **>400 msg/j** pendant 3 jours.

Budget 5 studios (ordre de grandeur): **~10–20 €/mois** QStash pay-as-you-go + marge — voir [`cost-monitoring.md`](./cost-monitoring.md).

---

## Prérequis

- [ ] Compte Upstash avec QStash activé (même org que Redis Athlya).
- [ ] Slack `#ops-athlya-alerts` opérationnel (cf. [`axiom-alerts-provision.md`](./axiom-alerts-provision.md)).
- [ ] Dataset Axiom `athlya-logs` reçoit les logs Worker prod/staging.

---

## Étape 1 — Alerte console Upstash (80 % quota)

1. [Upstash Console](https://console.upstash.com/) → **QStash** → **Usage**.
2. **Alerts** → email + (si dispo) webhook Slack à **80 %** du quota journalier (400/500 sur free tier).
3. Noter la date de configuration dans le tableau de suivi ci-dessous.

| Env     | Quota plan             | Alerte 80 % | Date config | Owner |
| ------- | ---------------------- | ----------- | ----------- | ----- |
| prod    | 500/j (free) ou payant | [ ]         |             |       |
| staging | partagé ou dédié       | [ ]         |             |       |

---

## Étape 2 — Alerte Axiom A14 (échecs publish QStash)

Monitor logs Worker — déclenche si des échecs ou skips quota apparaissent (adapter branché ou mode dégradé).

**Query APL (A14):**

```apl
['athlya-logs']
| where _time > now(-1h)
| where ['message'] in ("qstash.publish.failed", "qstash.schedule.skipped", "qstash.quota.degraded")
| summarize events = count() by ['message']
| where events > 5
```

**Trigger:** ≥ 1 row / heure.  
**Route:** Slack `#ops-athlya-alerts`.  
**Cooldown:** 60 min.

Définition complète: [`docs/operations/axiom-alerts.md`](../operations/axiom-alerts.md) § A14.

---

## Étape 3 — Contrat logs (Worker)

Messages structurés émis par les adapters QStash (ou stubs dégradés) :

| Message                   | Niveau | Quand                         |
| ------------------------- | ------ | ----------------------------- |
| `qstash.publish.ok`       | info   | Publish QStash réussi         |
| `qstash.publish.failed`   | warn   | HTTP 4xx/5xx Upstash          |
| `qstash.quota.degraded`   | warn   | Quota dépassé / rate limit    |
| `qstash.schedule.skipped` | warn   | Binding absent (mode dégradé) |

**Invariant:** jamais de silence — tout skip ou échec doit loguer l'un de ces messages.

---

## Test staging — simulation dépassement

1. **Sans adapter branché:** vérifier que `auth.user.deleted` en queue RGPD émet `qstash.schedule.skipped` dans Tail / Axiom :
   ```powershell
   wrangler tail --env staging --format json | Select-String "qstash.schedule.skipped"
   ```
2. **Avec adapter (post-wiring):** script charge `scripts/simulate-qstash-volume.mjs` (optionnel) — publie N messages test vers endpoint staging ; confirmer alerte Upstash ou A14.
3. **Rollback test:** supprimer les schedules test dans console QStash.

---

## Escalation

| Niveau | Condition                                     | Action                                                    |
| ------ | --------------------------------------------- | --------------------------------------------------------- |
| Sev3   | Alerte 80 % Upstash                           | Vérifier volume bookings ; batch reminders si > N cours/h |
| Sev2   | Quota 100 % / messages dropped                | Upgrade plan QStash ; désactiver scheduling non critique  |
| Sev1   | Rappels prod absents > 1h avec trafic booking | Page on-call ; activer tier payant immédiat               |

**Batch reminders (future):** 1 message QStash → N emails même créneau si > 20 cours/h (cf. critique spec § QStash).

---

## Checklist opérateur

```powershell
node scripts/verify-qstash-quota-checklist.mjs
```

Cocher manuellement dans ce runbook après chaque item.

---

## Références

- `.kiro/specs/athlya-platform/critique.md` § QStash 500 msg/j
- [`cost-monitoring.md`](./cost-monitoring.md)
- `packages/notifications/src/scheduler.ts` (reminder 1h)
- `packages/api/src/adapters/cascade-deps.ts` (stub anonymisation)
- Issue #126 — audit prod A5

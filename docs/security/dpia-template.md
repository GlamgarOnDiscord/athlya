# DPIA — Athlya MVP (template)

**Sprint 5 / Vague 33 — finding S5-011 + S5-012**

Document préparatoire à l'analyse d'impact relative à la protection des données (DPIA / EIVP) prévue à l'article 35 RGPD. À remplir et valider par le DPO avant la mise en production.

## 1. Description du traitement

### 1.1 Finalité

Plateforme SaaS de gestion d'adhérents de salles de sport et de coachs : inscription, authentification, réservation de cours, suivi de séances, abonnements payants.

### 1.2 Catégories de données collectées

| Catégorie        | Champ                                                              | Sensibilité     | Base légale                                  |
| ---------------- | ------------------------------------------------------------------ | --------------- | -------------------------------------------- |
| Identification   | email, displayName, avatar (optionnel)                             | Standard        | Contrat (Art 6.1.b)                          |
| Authentification | password_hash (bcrypt cost 12)                                     | Sensible (cred) | Contrat                                      |
| Préférences      | locale, consents (marketing/analytics/thirdParty + version)        | Standard        | Consentement (Art 6.1.a) pour optionnels     |
| Activité métier  | reservations, workout_sessions, check-ins                          | Standard        | Contrat                                      |
| Sécurité         | audit_log (actor_id, action, metadata, IP-derived rate-limit hash) | Sensible        | Intérêt légitime (Art 6.1.f) — sécurité      |
| Logs techniques  | traceId, http.path, http.status_code, duration                     | Pseudonymisé    | Intérêt légitime — observabilité             |
| Paiement         | clientReference (Stripe customer id)                               | Standard        | Contrat — données paiement gérées par Stripe |

**Pas de données de santé** (Art 9§2.h n'est pas mobilisé). **Pas de géolocalisation précise**.

### 1.3 Catégories de personnes concernées

- Adhérents (membres) : utilisateurs finaux des salles partenaires.
- Coachs : staff des salles, rôle élevé.
- Admins : staff Athlya / staff salle.

### 1.4 Durées de conservation

| Catégorie          | Durée active                       | Post-suppression                     |
| ------------------ | ---------------------------------- | ------------------------------------ |
| Compte             | Durée de l'abonnement              | Anonymisation in-place J+30 (S5-004) |
| audit_log          | 12 mois                            | Anonymisation actor_id J+30 (S5-003) |
| outbox             | 7 jours après publication (S5-005) | —                                    |
| export_jobs        | 90 jours après completion (S5-006) | —                                    |
| Logs Sentry / Tail | 30 jours (Cloudflare default)      | —                                    |
| Factures Stripe    | 10 ans (Art L123-22 Code commerce) | —                                    |

## 2. Sous-traitants (Art 28 RGPD)

| Sous-traitant   | Service                                                                     | Localisation                                 | Contrat                                                                                       |
| --------------- | --------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Cloudflare Inc. | Workers, R2, KV, Queues, Tail Workers                                       | EU (Smart Placement)                         | DPA Cloudflare Standard                                                                       |
| Neon Inc.       | Postgres managé                                                             | aws-eu-central-1                             | DPA Neon                                                                                      |
| Upstash Inc.    | Redis managé                                                                | eu-west-1                                    | DPA Upstash                                                                                   |
| Stripe Inc.     | Paiements + webhooks                                                        | EU (Stripe Atlas EU si activé — voir S5-012) | DPA Stripe                                                                                    |
| Resend Inc.     | Emails transactionnels                                                      | EU si activé                                 | DPA Resend                                                                                    |
| Expo Inc.       | Push notifications mobile                                                   | US (Expo Push)                               | **Note S5-012** : transfert hors UE — clauses contractuelles types requises ou alternative EU |
| Sentry          | Error tracking (DSN EU `*.de.sentry.io` — vérifié au boot Vague 33 / SP5.1) | EU (sentry.io DE)                            | DPA Sentry                                                                                    |

**Action S5-012** : valider que la résidence EU est explicitement contractuelle pour Stripe (Stripe Atlas EU activé) et Resend, et documenter Expo Push comme transfert hors UE avec safeguards (SCC).

## 3. Mesures techniques et organisationnelles (Art 32 RGPD)

### 3.1 Confidentialité

- TLS 1.3 enforced (Cloudflare).
- HSTS `max-age=63072000; includeSubDomains; preload`.
- RLS Postgres forcée sur toutes tables sensibles (`users`, `reservations`, `workout_sessions`, `audit_log`, etc.).
- Hashage bcrypt cost 12 + HIBP fail-closed (S2-009 distincte).
- JWT RS256 + JWKS rotation + iss/aud enforcement (Sprint 1 SP1.6).
- Refresh token : HttpOnly + Secure + SameSite=Lax + Path=/api/auth + family-tree revoke (Sprint 2 SP2.1).
- Sliding-window rate limit hashé `auth:login:<sha256(ip:email):24>` (Sprint 3 SP3.2 / S5-007).
- Auto-redact logger (Sprint 3 SP3.2 / S5-008).
- CSP nonce-strict + COOP + CORP + Permissions-Policy (Sprint 3 SP3.1).

### 3.2 Intégrité

- Audit log immutable (trigger Postgres `audit_log_immutable`).
- `audit_log` SECURITY DEFINER pinned + `OWNER athlya_owner BYPASSRLS`.
- Outbox transactionnel + DLQ Cloudflare Queues + admin replay endpoint (Sprint 1 SP1.6).

### 3.3 Disponibilité

- Cloudflare Workers : auto-failover global.
- Neon : multi-AZ avec point-in-time recovery.
- Cloudflare Queues : retry budget × 5 + DLQ tracker Redis.

### 3.4 Pseudonymisation

- audit_log anonymisation J+30 via `anonymize_user_audit` (S5-003 — câblage cron pending).
- users anonymisation in-place J+30 (S5-004 livré Sprint 2).
- Throttle key sha256 (S5-007 livré Sprint 3).

### 3.5 Tests réguliers

- pgTAP RLS policies sur chaque PR migrations.
- Property tests (P1-P8) capacity, idempotence, monotonicité, cascade RGPD, FIFO, JWT, tenant isolation, rate-limit.
- Audit Sprint 1 + Sprint 2 + Sprint 3 + Sprint 4 livré (74 findings → 26 résolus).

## 4. Évaluation de la nécessité et de la proportionnalité

- Toutes les données collectées sont nécessaires au service (contrat).
- Données optionnelles (marketing/analytics/thirdParty) gardées sous consentement explicite avec version trackée + re-consent helper (Sprint 4 SP4.2).
- Minimisation : audit log entries ne portent pas IP/UA/email (Vague 29 SP2.1).

## 5. Risques pour les droits et libertés

| Risque                          | Probabilité                   | Gravité | Mitigation principale                                              |
| ------------------------------- | ----------------------------- | ------- | ------------------------------------------------------------------ |
| Vol de cookies (XSS)            | Faible                        | Modérée | CSP nonce-strict + HttpOnly + SameSite + COOP + family-tree revoke |
| Vol refresh token + replay      | Faible                        | Élevée  | Family-tree revoke + atomic rotate (Sprint 2 SP2.1)                |
| Cross-tenant data leak          | Très faible                   | Élevée  | RLS forcée + tenantClaimGuard (Sprint 1 SP1.5)                     |
| Brute force login               | Faible                        | Modérée | Sliding-window 5 tentatives / 15 min hashé                         |
| Fuite Redis                     | Faible                        | Faible  | Clés pseudonymisées + TTL court + auto-redact logger               |
| Data subject request non honoré | Faible                        | Modérée | Cascade automatique J+30 + helper export RGPD                      |
| Transfert hors UE non sécurisé  | Faible (Expo Push uniquement) | Modérée | SCC + monitoring Sentry EU au boot                                 |

## 6. Mesures envisagées pour faire face aux risques

Voir "Mesures techniques" ci-dessus + roadmap audit Sprint 5+ (S2-006 forgot-password, S5-009 cookie banner futur, S4-009 HSTS preload soumission).

## 7. Validation

- DPO : ****\*\*\*\*****\_\_****\*\*\*\***** Date : \***\*\_\_\*\***
- CTO / Resp. Tech : \***\*\_\_\_\_\*\*** Date : \***\*\_\_\*\***
- Direction : **\*\*\*\***\_\_**\*\*\*\*** Date : \***\*\_\_\*\***

---

_Vague 33 — Sprint-5 SP5.3 (audit findings S5-011 + S5-012). Template à compléter et valider avant prod. Mise à jour à chaque évolution majeure du traitement (Art 35§11)._

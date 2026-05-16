# Runbook — Breach notification

**Sprint 5 / Vague 33 — finding S5-019**

Procédure d'incident pour une violation de données personnelles au sens de l'article 4§12 RGPD. Active dès qu'une fuite, accès non autorisé, perte ou destruction accidentelle de données personnelles est suspectée.

## TL;DR — délais légaux

- **CNIL** : 72 heures après la prise de connaissance (Art 33§1 RGPD).
- **Personnes concernées** : sans délai si risque élevé (Art 34§1).

## Étape 0 — Détection (T+0)

Sources de signal :

- Alerte Sentry sur exception non gérée touchant `users.*` ou `audit_log.*`.
- Alerte Cloudflare Tail Workers : `code: 'configuration_error'` sur `CORS_ORIGIN`, `SENTRY_DSN` ou `JWT_JWKS_URL` en staging/production.
- Audit log query : `SELECT count(*) FROM audit_log WHERE action LIKE 'rls.violation%'` retourne > 0 sur la dernière heure.
- Notification fournisseur (Cloudflare, Neon, Upstash, Stripe, Resend, Sentry).
- Signalement utilisateur ou tiers.
- Découverte interne (DevOps, Sec, support).

**Premier réflexe** : ne PAS éteindre l'incident, le DOCUMENTER. Capture d'écran, logs `wrangler tail`, dump des paramètres Redis suspects, etc.

## Étape 1 — Triage (T+0 à T+1h)

Membre on-call de l'équipe sécurité :

1. Ouvrir un ticket `#breach-YYYYMMDD` dans le canal interne (Slack / GitHub Issues).
2. Évaluer la **portée** :
   - Combien d'utilisateurs sont potentiellement concernés ?
   - Quelles catégories de données personnelles : email, adresse, données de santé (ne s'applique pas aujourd'hui), données de paiement (Stripe gère via tokenisation), géolocalisation précise (non collectée), audit log actor_id ?
   - Données déjà exfiltrées vers l'extérieur, ou simplement exposées en lecture interne ?
3. Évaluer la **gravité** (échelle CNIL : faible / modérée / élevée / très élevée) :
   - Type de données : email + name = modérée ; password_hash bcrypt = faible (déjà hashé) ; actuelles données de paiement = très élevée mais hors scope (Stripe).
   - Possibilité de ré-identification.
   - Conséquences pour les personnes (usurpation, discrimination, perte financière, atteinte réputation).
4. Notifier immédiatement le DPO (`dpo@[à-configurer]`) et la direction.

## Étape 2 — Confinement (T+1h à T+4h)

Selon la nature de la fuite :

- **Compromission cred admin** : rotate immédiat du JWKS via `wrangler secret put JWT_JWKS_URL --env production`, déclenche `revokeAllForUser` sur tous les comptes admin (audit log entry `breach.containment.jwks-rotated`).
- **Fuite Redis** : rotate `REDIS_TOKEN` via `wrangler secret put REDIS_TOKEN --env production`. Toutes les sessions actives sont effectivement invalidées (sliding-window rate-limit perd son état mais c'est acceptable).
- **Fuite Postgres** : alerter Neon, rotate `DB_URL` (le mot de passe du rôle `athlya_app`), forcer une re-authentification via JWKS rotation.
- **Fuite Sentry** (US dataset accidental, S5-010) : pause Sentry via DSN vide `wrangler secret put SENTRY_DSN --env production` et purger le projet US.
- **Fuite côté tiers** (Cloudflare/Stripe/Resend) : suivre la procédure du fournisseur ; obtenir la liste exacte des données concernées.

Documenter chaque action dans le ticket avec timestamp UTC.

## Étape 3 — Évaluation des risques (T+4h à T+24h)

Conduire une **EIVP** (étude d'impact sur la vie privée) abrégée :

1. Quels droits/libertés sont menacés (vie privée, droit à l'image, sécurité financière) ?
2. Probabilité de matérialisation du risque (faible / probable / certaine).
3. Gravité de l'impact (négligeable / limitée / importante / maximale).

Le produit `probabilité × gravité` détermine si la notification aux personnes concernées est requise (Art 34 : "risque élevé pour les droits et libertés").

## Étape 4 — Notification CNIL (T+24h à T+72h)

Formulaire en ligne : <https://notifications.cnil.fr/notifications/index>.

Contenu requis (Art 33§3) :

- Description de la violation : nature, catégories de données, nombre approximatif de personnes et de données.
- Coordonnées du DPO : `dpo@[à-configurer]` + téléphone.
- Conséquences probables.
- Mesures prises ou envisagées pour traiter la violation et atténuer ses effets.

Notification incomplète ? Permis : compléter sans tarder (Art 33§4).

## Étape 5 — Notification aux personnes concernées (si requis, ASAP)

Si le risque est ÉLEVÉ (Art 34§1) :

- Email transactionnel **clair et compréhensible** (pas de jargon juridique). Template à valider avec le DPO.
- Sujet : `[Athlya] Information importante concernant la sécurité de votre compte`.
- Contenu : description en termes simples, conséquences possibles, mesures prises, conseils (changer mot de passe si applicable, surveillance bancaire si data paiement, etc.), point de contact `dpo@athlya.app`.

Exceptions (Art 34§3) :

- Mesures techniques préalables (chiffrement) rendent les données incompréhensibles pour un non-autorisé → bcrypt password hashes éligibles.
- Mesures ultérieures empêchent le risque élevé.
- Communication individuelle exigerait des efforts disproportionnés → communication publique alternative possible.

## Étape 6 — Post-mortem (T+1 semaine)

- Réunion post-mortem **blameless** dans la semaine.
- Document `docs/security/postmortems/breach-YYYY-MM-DD.md` avec :
  - Timeline détaillée.
  - Cause racine.
  - Actions correctives (court / moyen / long terme).
  - Mises à jour de ce runbook si besoin.
- Mise à jour du registre des violations (Art 33§5) — tenu par le DPO.

## Annexe — Contacts

- DPO : `dpo@[à-configurer]`
- CNIL : <https://www.cnil.fr> · [03 44 58 14 30](tel:+330344581430)
- Hébergeurs (escalation) :
  - Cloudflare Enterprise support : ticket via dashboard
  - Neon support : `support@neon.tech`
  - Upstash : `support@upstash.com`
  - Stripe : `compliance@stripe.com`
  - Resend : `support@resend.com`
  - Sentry : portail dashboard

---

_Vague 33 — Sprint-5 SP5.2 (audit finding S5-019). Document à valider par le DPO + counsel légal avant publication interne._

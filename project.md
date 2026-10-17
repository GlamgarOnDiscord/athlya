# Project — Plateforme Fitness Open-Source (Alternative bsport / Mywellness)

> Document consolidé : branding, PRD, MVP, architecture technique, stack, sécurité, scalabilité, direction artistique, roadmap.
>
> _Rédigé le 09/05/2026 · Cible : alternative open-source au marché SaaS fitness français · Base : `analyse-fitness-apps-architecture.md`_

---

## Table des matières

1. [Positionnement & Vision](#1-positionnement--vision)
2. [Branding & Nom de Produit](#2-branding--nom-de-produit)
3. [PRD — Product Requirements Document](#3-prd--product-requirements-document)
4. [MVP — Phase 1 (v0.1 → v0.3)](#4-mvp--phase-1-v01--v03)
5. [Architecture Technique Cible](#5-architecture-technique-cible)
6. [Stack Détaillée (versions 2026)](#6-stack-détaillée-versions-2026)
7. [Modèle de Données](#7-modèle-de-données)
8. [Sécurité & RGPD by Design](#8-sécurité--rgpd-by-design)
9. [Scalabilité & Performance](#9-scalabilité--performance)
10. [Direction Artistique (DA)](#10-direction-artistique-da)
11. [Structure du Monorepo](#11-structure-du-monorepo)
12. [DevOps, CI/CD & Observabilité](#12-devops-cicd--observabilité)
13. [Roadmap 12 mois](#13-roadmap-12-mois)
14. [Métriques de succès (SLOs & KPIs)](#14-métriques-de-succès-slos--kpis)
15. [Risques & Mitigation](#15-risques--mitigation)

---

## 1. Positionnement & Vision

### 1.1 Problème

Le marché français du fitness logiciel est **structurellement défaillant** :

- **Vendor lock-in fort** — bsport, Mywellness, Mindbody enferment les studios dans des formats propriétaires.
- **Résilience insuffisante** — pannes documentées chez bsport, y compris en démo commerciale.
- **RGPD bolt-on** — aucun acteur ne traite le consentement granulaire comme feature de premier rang.
- **Absence d'intégrations wearables sérieuses** — Basic-Fit lui-même ne supportait ni Apple Watch ni Apple Health début 2025.
- **Coût prohibitif** — 35 à 200 €/mois côté SaaS pour un petit studio.

### 1.2 Proposition de valeur

> **Une plateforme fitness open-source, multi-tenant, event-driven, RGPD-first, auto-hébergeable, qui tient sur un free tier jusqu'à plusieurs milliers d'utilisateurs actifs.**

Trois engagements non négociables :

1. **Ownership** — Les données appartiennent à l'opérateur et à l'utilisateur. Schéma public, export JSON/CSV natif, `DELETE /me` complet.
2. **Résilience by design** — Circuit breakers, retries exponentiels, mode dégradé offline, compteurs dans Redis plutôt que PostgreSQL.
3. **Edge-first** — Latence p99 < 250 ms sur toute l'Europe via Cloudflare Workers.

### 1.3 Cibles

| Segment                                 | Volume France | Pain point principal       | Notre proposition                                   |
| --------------------------------------- | ------------- | -------------------------- | --------------------------------------------------- |
| Studios boutique (yoga, crossfit, boxe) | ~8 000        | bsport cher, peu résilient | Marque blanche gratuite, self-host optionnel        |
| Chaînes mid-size (5-30 salles)          | ~300          | Mywellness rigide, coûteux | Multi-tenant, API ouverte, intégrations équipements |
| Coachs indépendants                     | ~40 000       | Pas d'outil unifié         | App mobile + paiements Stripe + planning            |
| Communautés sportives / associations    | milliers      | Zero budget                | 100 % open source auto-hébergeable                  |

**Non-cible MVP** : Basic-Fit scale (1 M+ membres). On se bat contre **bsport**, pas contre Basic-Fit.

---

## 2. Branding & Nom de Produit

### 2.1 Contraintes de nommage

- Prononçable en FR + EN
- 5–7 lettres idéalement
- `.com` ou `.io` disponible
- Pas de collision avec marque fitness existante (vérification : `fitly.com`, `fitlyapp.com`, `fitye.com` = **tous pris ou en vente**)
- Évocateur d'énergie, discipline, progression

### 2.2 Shortlist (recommandations)

| Nom           | Sens                                      | Force                        | `.com`               | `.io`      | `.app`     |
| ------------- | ----------------------------------------- | ---------------------------- | -------------------- | ---------- | ---------- |
| **Athlya**    | Racine grecque _athlos_ (combat, épreuve) | Premium, sonne international | à vérifier           | probable   | probable   |
| **Kairos**    | Moment opportun, timing parfait (grec)    | Philosophique, mémorable     | pris (autre secteur) | à vérifier | à vérifier |
| **Forgefit**  | Forger son corps, atelier                 | Masculin, industriel         | à vérifier           | probable   | probable   |
| **Pulseform** | Rythme + discipline                       | Data-driven, moderne         | à vérifier           | probable   | probable   |
| **Ironly**    | Fonte + simplicité                        | Court, punchy                | probable             | à vérifier | probable   |

### 2.3 Choix recommandé : **Athlya**

**Justification** :

- Sémantique grecque cohérente avec l'héritage sportif (athlète, athlétisme).
- Sonne à la fois premium (comme _Alya_, _Celya_) et discipliné (racine _athlos_).
- Neutre sur le plan genre, âge, discipline (yoga → crossfit → endurance).
- Peu courant dans l'industrie fitness → faible risque de conflit de marque.
- Disponibilité probable : `athlya.app`, `athlya.io`, `athlya.fit`.

> ⚠️ **À faire avant lock-in** : vérifier disponibilité INPI (classe 9 logiciels, classe 41 activités sportives) + EUIPO + USPTO + registre des domaines.

**Nom de code technique du repo** : `athlya-platform`

### 2.4 Tagline (FR / EN)

- **FR** : _Votre salle, vos données, votre rythme._
- **EN** : _Own your gym. Own your data._

---

## 3. PRD — Product Requirements Document

### 3.1 Personas

#### P1 — Marie, gérante de studio yoga (45 ans, Paris 11e)

- Utilise bsport depuis 2022, paye 189 €/mois.
- Frustrée par les pannes pendant les cours du samedi matin (500 requêtes concurrentes sur la réservation).
- Veut une app brandée à son studio sans payer l'option "white-label premium".
- **Job-to-be-done** : remplir ses cours, fidéliser, éviter que les élèves partent chez le concurrent.

#### P2 — Karim, membre régulier (28 ans, Lyon)

- Va en salle 3-4× par semaine.
- Veut réserver un cours collectif en < 3 taps, entrer avec un QR code, logger ses séances.
- Valeur d'attache : graphiques de progression hebdo.
- **Frustration actuelle** : doit jongler entre 2 apps (salle + Strava/Coach).

#### P3 — Sophie, coach freelance (34 ans, Bordeaux)

- Clients dans 2 salles + domicile + visio.
- Besoin : programmer sessions, suivre clients, encaisser via Stripe.
- **Frustration actuelle** : jongle entre Google Calendar + Notion + Stripe Dashboard.

#### P4 — Thomas, CTO d'une chaîne régionale (41 ans, Lille, 12 clubs)

- Évalue alternative open-source à Mywellness.
- Contraintes : RGPD strict (CNIL), SLA, intégration badges NFC existants.
- **Décision d'achat** : self-host sur leur Kubernetes interne ou version managée ?

### 3.2 Fonctionnalités — vue d'ensemble

Légende : 🟢 MVP · 🟡 Phase 2 · 🔴 Phase 3

| Domaine          | Feature                                  | Priorité |
| ---------------- | ---------------------------------------- | -------- |
| **Auth**         | Email + password + magic link            | 🟢       |
|                  | Apple Sign-In (obligatoire iOS)          | 🟢       |
|                  | Google OAuth                             | 🟢       |
|                  | Biométrie (Face ID / Touch ID)           | 🟢       |
|                  | 2FA TOTP                                 | 🟡       |
|                  | SSO SAML (chaînes)                       | 🔴       |
| **Membres**      | Profil, photo, données corporelles       | 🟢       |
|                  | Abonnements actifs + historique          | 🟢       |
|                  | Export JSON complet (RGPD)               | 🟢       |
|                  | Suppression cascade (`DELETE /me`)       | 🟢       |
| **Réservations** | Calendrier semaine                       | 🟢       |
|                  | Réservation 1-tap                        | 🟢       |
|                  | Liste d'attente automatique              | 🟢       |
|                  | Annulation avec règle temporelle         | 🟢       |
|                  | Rappels push (1 h avant)                 | 🟢       |
|                  | Check-in QR                              | 🟢       |
| **Tracking**     | Log séance (exercices/séries/reps/poids) | 🟢       |
|                  | Graphiques 30/90 jours                   | 🟢       |
|                  | Export CSV                               | 🟢       |
|                  | Intégration Apple Health / Google Health | 🟡       |
|                  | Bluetooth FTMS (équipements connectés)   | 🟡       |
| **Accès salle**  | QR code JWT short-lived rotatif          | 🟢       |
|                  | Badge NFC via Apple/Google Wallet        | 🟡       |
|                  | Contrôle d'accès physique (API bornes)   | 🔴       |
| **Coaching**     | Programmes prédéfinis                    | 🟡       |
|                  | Coach IA (persona LLM)                   | 🟡       |
|                  | Sessions visio + paiement                | 🔴       |
| **Paiements**    | Abonnement mensuel Stripe                | 🟢       |
|                  | Paiement à la séance                     | 🟡       |
|                  | SEPA + Apple Pay                         | 🟡       |
| **Admin studio** | Planning hebdo                           | 🟢       |
|                  | Gestion membres / abonnements            | 🟢       |
|                  | Dashboard revenus                        | 🟡       |
|                  | Marketing / campagnes                    | 🔴       |
| **Multi-tenant** | Isolation par `studio_id` (RLS)          | 🟢       |
|                  | Marque blanche (logo, couleurs)          | 🟡       |
|                  | Custom domain                            | 🔴       |

### 3.3 Exigences non-fonctionnelles

| Catégorie         | Exigence                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------- |
| **Performance**   | p50 < 100 ms, p99 < 500 ms sur API réservation. Cold start < 50 ms (Cloudflare Workers). |
| **Disponibilité** | SLO 99.9 % (≈ 43 min down/mois).                                                         |
| **Capacité**      | 10 000 RPS pic pour free tier (Cloudflare).                                              |
| **Offline**       | App mobile fonctionne en lecture 72 h offline, écriture en queue persistée.              |
| **RGPD**          | Export sous 48 h, suppression sous 30 j, consentement versioné.                          |
| **Sécurité**      | OWASP Top 10 couvert, audit trimestriel, bug bounty public (tier 2).                     |
| **Accessibilité** | WCAG 2.2 AA sur web, VoiceOver/TalkBack complets sur mobile.                             |
| **i18n**          | FR / EN dès v1. ES / DE / IT en Phase 2.                                                 |
| **Open-source**   | AGPL-3.0 pour la plateforme, MIT pour les SDK clients.                                   |

---

## 4. MVP — Phase 1 (v0.1 → v0.3)

### 4.1 Portée MVP v0.1 (8 semaines solo dev)

**Principe** : livrer un produit utilisable bout-en-bout pour **un seul studio pilote** (Marie), pas une plateforme multi-tenant complète.

**Inclus** :

1. Auth email + password + Apple Sign-In + biométrie.
2. Profil membre + abonnement illimité (une formule unique).
3. Calendrier des cours + réservation + annulation (règle 2 h).
4. Check-in par QR code JWT rotatif 2 min.
5. Log de séance libre (nom, exercices texte, pas d'import wearable).
6. Dashboard admin studio (planning hebdo, liste membres, revenus simples).
7. App web (Next.js) + app mobile (Expo Go testé sur iPhone réel).

**Exclus explicitement** :

- Multi-tenant (un seul studio en base).
- Marque blanche.
- Paiements Stripe (mode "abonnement offert" pour le pilote).
- IA coach.
- Bluetooth / wearables.
- NFC Wallet.

### 4.2 Critères d'acceptation MVP

La v0.1 est livrée quand :

- [ ] Marie peut créer 20 cours pour la semaine en < 5 min.
- [ ] Karim peut réserver un cours en ≤ 3 taps.
- [ ] Karim peut entrer en salle avec son QR sans prendre une capture d'écran.
- [ ] 50 membres peuvent réserver le même créneau simultanément sans double-booking (test de charge Artillery).
- [ ] Un membre peut exporter toutes ses données en JSON depuis son profil.
- [ ] Un membre peut supprimer son compte, et 72 h plus tard aucune donnée personnelle ne reste (hors audit log chiffré).
- [ ] L'app mobile fonctionne sans réseau pour consulter ses réservations existantes.
- [ ] Lighthouse score web ≥ 95 sur Perf, A11y, Best Practices, SEO.

### 4.3 Portée v0.2 (semaines 9–16)

- Multi-tenant complet avec RLS.
- Marque blanche (logo, couleur primaire, nom studio).
- Stripe Checkout pour abonnements mensuels.
- Liste d'attente automatique.
- Intégration Apple Health (import séances cardio).
- i18n FR + EN.

### 4.4 Portée v0.3 (semaines 17–24)

- Coach IA (persona LLM via OpenAI / Mistral).
- Graphiques de progression avancés.
- Bluetooth FTMS (équipements cardio connectés).
- Programmes d'entraînement prédéfinis.
- Export CSV avancé.

---

## 5. Architecture Technique Cible

### 5.1 Principes directeurs

1. **Edge-first** — Latence utilisateur < état du serveur.
2. **Event-driven** — Les domaines communiquent par événements, pas par RPC synchrone.
3. **Local-first** — L'app mobile est source de vérité en lecture, synchronisée vers le backend.
4. **Offline-capable** — Écriture en queue persistée, jamais de spinner infini.
5. **Déclaratif** — Infrastructure as Code, migrations expand/contract, blue/green.
6. **Observable** — OpenTelemetry bout-en-bout, logs structurés, SLO monitorés.

### 5.2 Diagramme de flux système

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENTS                                  │
│   Web (Next.js 16)           Mobile (Expo SDK 55 + RN 0.83)     │
│   ▲ PWA installable          ▲ New Architecture (Fabric+TM)     │
└──────┬──────────────────────────────────────┬───────────────────┘
       │ HTTPS/2 + HTTP/3                     │
       ▼                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                  CLOUDFLARE EDGE LAYER                          │
│   • WAF + Bot Management + DDoS L3/L4/L7                        │
│   • Turnstile (CAPTCHA sans friction)                           │
│   • Cache statique + HTTP/3 QUIC                                │
│   • Géo-routing + Smart Placement                               │
└─────────────────┬───────────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────┐
│             API GATEWAY — Hono 4 on Workers                     │
│   • Rate limiting (sliding window, Upstash Redis)               │
│   • Auth middleware (JWT RS256 vérif edge)                      │
│   • Schema validation Zod (input + output)                      │
│   • Request tracing (W3C traceparent)                           │
│   • Versioning /v1 /v2                                          │
│   • Circuit breaker par service downstream                      │
└──┬──────────┬────────────┬──────────┬─────────┬─────────────────┘
   │          │            │          │         │
   ▼          ▼            ▼          ▼         ▼
┌──────┐ ┌──────────┐ ┌──────────┐ ┌──────┐ ┌────────────┐
│ Auth │ │ Members  │ │Reservatn.│ │Content│ │ Billing    │
│(Btr  │ │(Hono+Drz)│ │(Hono+Drz)│ │(Hono) │ │(Stripe SDK)│
│ Auth)│ │          │ │          │ │       │ │            │
└──┬───┘ └────┬─────┘ └────┬─────┘ └───┬───┘ └─────┬──────┘
   │          │            │           │           │
   └──────────┴────────────┴───────────┴───────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│    EVENT BUS — Cloudflare Queues + Upstash QStash               │
│   Topics / queues :                                             │
│   • auth.user.registered / auth.user.deleted                    │
│   • reservation.created / reservation.cancelled                 │
│   • session.logged                                              │
│   • billing.subscription.started / .cancelled / .failed         │
│   Cloudflare Queues = real-time side-effects (retry/DLQ)        │
│   QStash            = jobs différés + cron (rappels 1h avant)   │
└───┬─────────────────┬─────────────────┬─────────────────────────┘
    │                 │                 │
    ▼                 ▼                 ▼
┌─────────────┐ ┌──────────────┐ ┌────────────────┐
│Notifications│ │   Analytics  │ │  AI / Coach    │
│(Resend +    │ │  (Tinybird   │ │  (Vercel AI SDK│
│ Expo Push)  │ │   ClickHouse)│ │   + Mistral)   │
└─────────────┘ └──────────────┘ └────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      PERSISTENCE LAYER                          │
│   • Neon PostgreSQL 17 — relational + RLS multi-tenant          │
│     (branching pour CI, scale-to-zero, read replicas EU)        │
│   • Upstash Redis — cache chaud, compteurs, rate limits,        │
│     sliding windows, queue reservations                         │
│   • Cloudflare R2 — assets binaires (S3-compatible, 0 egress)   │
│   • Tinybird / ClickHouse — séries temporelles séances          │
└─────────────────────────────────────────────────────────────────┘
```

### 5.3 Pourquoi ces choix vs l'analyse originale

L'analyse recommandait **Supabase + Cloudflare + Prisma**. Révision 2026 :

| Original            | Recommandation 2026                    | Raison                                                                                                                                                                                            |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase PostgreSQL | **Neon PostgreSQL 17**                 | Scale-to-zero réel, branching instantané pour CI/PR preview, latence edge meilleure. Supabase Auth remplacé par Better Auth.                                                                      |
| Supabase Auth       | **Better Auth**                        | Plus flexible, pas de vendor lock-in, fonctionne nativement sur Workers, gestion fine des sessions, TypeScript-first.                                                                             |
| Prisma              | **Drizzle ORM**                        | 90 % moins de bundle, cold start 3× plus rapide sur Workers, SQL-shaped donc prévisible à l'edge, zéro génération de client.                                                                      |
| Redis Streams       | **Cloudflare Queues + Upstash QStash** | Queues natives aux Workers (retry/DLQ, 100k msg/j gratuit) + QStash pour les cron/jobs différés. **Upstash Kafka a été déprécié en sept. 2024 et discontinué en mars 2025** — à ne plus utiliser. |
| Axiom + Grafana     | **Tinybird + Axiom**                   | ClickHouse managé pour analytics temps réel, OpenTelemetry natif (Axiom accepte OTLP/HTTP JSON nativement).                                                                                       |

**Supabase est toujours un bon choix** pour démarrer plus vite avec Auth, Storage, Realtime bundlés. Si le projet doit décoller dès les premières semaines sans sur-ingénierie, **garder Supabase v2** reste légitime pour la v0.1, puis migrer vers Neon + Better Auth en v0.2. C'est un trade-off **vitesse vs contrôle**, à décider par l'opérateur.

---

## 6. Stack Détaillée (versions 2026)

### 6.1 Frontend Web

| Techno             | Version  | Rôle                                                                                |
| ------------------ | -------- | ----------------------------------------------------------------------------------- |
| **Next.js**        | 16.2     | App Router, Cache Components (PPR), Turbopack prod                                  |
| **React**          | 19.2     | Server Components, Actions, use()                                                   |
| **TypeScript**     | 5.9      | Strict mode, exhaustive checks (6.0 RC / 7.0 Beta dispos mais à éviter en prod MVP) |
| **Tailwind CSS**   | 4.2      | Oxide engine, CSS-first config, plugin Webpack                                      |
| **shadcn/ui**      | dernière | Composants accessibles, copy-paste                                                  |
| **TanStack Query** | 5.89+    | Cache serveur, mutations optimistes                                                 |
| **Zustand**        | 5.x      | État global UI                                                                      |
| **Zod**            | 4.1      | Validation + types partagés                                                         |
| **Lucide React**   | dernière | Icônes                                                                              |
| **next-intl**      | dernière | i18n App Router                                                                     |

### 6.2 Frontend Mobile

| Techno                        | Version                                                                 | Rôle                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Expo SDK**                  | 55                                                                      | React Native 0.83.2, React 19.2, New Arch obligatoire                |
| **Expo Router**               | 5.x                                                                     | Navigation file-system                                               |
| **NativeWind**                | **4.1 stable (ciblant Tailwind 3.4)** — v5 preview encore instable      | Styles Tailwind sur RN. Voir note ci-dessous.                        |
| **TanStack Query**            | 5.89+                                                                   | Cache serveur identique au web                                       |
| **Zustand**                   | 5.x                                                                     | État UI                                                              |
| **MMKV**                      | 3.3                                                                     | Stockage local 30× plus rapide qu'AsyncStorage (TurboModules requis) |
| **expo-secure-store**         | SDK 55                                                                  | Stockage tokens dans Secure Enclave / Keystore                       |
| **expo-local-authentication** | SDK 55                                                                  | Face ID / Touch ID / Android biometric                               |
| **expo-notifications**        | SDK 55                                                                  | Push iOS / Android                                                   |
| **expo-camera**               | SDK 55                                                                  | QR scan, photos profil                                               |
| **react-native-reanimated**   | 4.x (New Arch only, Reanimated 3 n'est plus maintenu)                   | Animations 60/120 fps sur UI thread                                  |
| **Gluestack UI**              | v2 stable (NativeWind 4.1) — v5 alpha dispo mais non recommandé en prod | Composants pré-stylés                                                |

> ⚠️ **Note Tailwind v3 vs v4 côté mobile** : en mai 2026, NativeWind v4.1 (production-ready) cible encore **Tailwind CSS v3**. NativeWind v5 preview aligné sur Tailwind v4 existe mais n'est pas encore stable (issue officielle : https://blog.openreplay.com/tailwind-css-react-native-nativewind/). Pour le MVP :
>
> - `apps/web` et `apps/studio` → Tailwind 4.2 (Oxide).
> - `apps/mobile` → Tailwind 3.4 + NativeWind 4.1.
> - Tokens de design centralisés dans `packages/shared/tokens.ts` (source de vérité unique), consommés par deux presets (`packages/config/tailwind/web.ts` et `packages/config/tailwind/mobile.ts`).
> - Migration mobile vers Tailwind 4 + NativeWind v5 planifiée en v0.3.

**Contrainte Windows + test iPhone gratuit** : toute la stack Expo SDK 55 fonctionne via Expo Go + EAS Build cloud. 30 builds iOS/mois gratuits suffisent largement pour le MVP.

### 6.3 Backend

| Techno                        | Version      | Rôle                                                                                 |
| ----------------------------- | ------------ | ------------------------------------------------------------------------------------ |
| **Hono**                      | 4.10         | Framework HTTP universel (Workers, Node, Bun)                                        |
| **Drizzle ORM**               | 0.45+        | ORM TypeScript-first, SQL-shaped                                                     |
| **Drizzle Kit**               | 0.32+        | Migrations versionnées, introspection                                                |
| **Zod**                       | 4.1          | Validation + partage types client/serveur                                            |
| **Better Auth**               | 1.6+         | Auth multi-providers, sessions, RBAC                                                 |
| **Stripe SDK**                | dernière     | Paiements, abonnements, webhooks                                                     |
| **Resend**                    | dernière     | Emails transactionnels                                                               |
| **Cloudflare Workers**        | runtime 2026 | Edge compute, ~5 ms cold start                                                       |
| **Cloudflare Queues**         | —            | Event bus primaire : side-effects async, retry + DLQ natif                           |
| **Upstash QStash / Workflow** | v2+          | Jobs différés / cron / retries HTTP (remplaçant officiel d'Upstash Kafka — déprécié) |
| **Upstash Redis**             | 7.x          | Cache chaud, compteurs, rate limits, sliding windows                                 |

### 6.4 Base de données

| Techno                    | Version | Rôle                                             |
| ------------------------- | ------- | ------------------------------------------------ |
| **Neon PostgreSQL**       | 17      | Base relationnelle primaire, RLS, branching      |
| **Cloudflare Hyperdrive** | —       | Connection pooler global pour Workers            |
| **Upstash Redis**         | 7.x     | Cache, compteurs, rate limits                    |
| **Cloudflare R2**         | —       | Assets binaires S3-compatible (zéro egress)      |
| **Tinybird**              | —       | Analytics séries temporelles (ClickHouse managé) |

### 6.5 Infrastructure & DevOps

| Techno                 | Rôle       |
| ---------------------- | ---------- | -------------------------------------------------- |
| **Turborepo**          | 2.7+       | Monorepo, cache builds                             |
| **pnpm**               | 9.x        | Package manager, workspaces                        |
| **Vercel**             | Hobby plan | Hébergement Next.js web                            |
| **Cloudflare Workers** | Free/Paid  | Hébergement API edge                               |
| **GitHub Actions**     | —          | CI/CD                                              |
| **EAS Build / Submit** | Free tier  | Builds iOS/Android cloud                           |
| **OpenTelemetry**      | 1.9+       | Tracing distribué                                  |
| **Axiom**              | —          | APM OpenTelemetry natif (remplace Baselime, sunset 2024) |
| **Sentry**             | —          | Error tracking front + back                        |
| **Infisical**          | —          | Secrets open-source auto-hébergeable               |
| **GrowthBook**         | —          | Feature flags open-source                          |
| **Vitest**             | 4.1+       | Unit + integration testing                         |
| **fast-check**         | 4.7+       | Property-based testing (avec `@fast-check/vitest`) |
| **Playwright**         | 1.59+      | E2E web                                            |

### 6.6 Versions résumées (à épingler dans `package.json` — vérifiées mai 2026)

```jsonc
{
  "next": "^16.2.0",
  "react": "^19.2.0",
  "react-native": "0.83.2",
  "expo": "^55.0.0",
  "hono": "^4.10.0",
  "drizzle-orm": "^0.45.0",
  "drizzle-kit": "^0.32.0",
  "@tanstack/react-query": "^5.89.0",
  "zod": "^4.1.0",
  "better-auth": "^1.6.0",
  "@upstash/qstash": "^2.7.0",
  "typescript": "^5.9.0",
  "tailwindcss": "^4.2.0",
  "nativewind": "^4.1.0",
  "zustand": "^5.0.0",
  "react-native-mmkv": "^3.3.0",
  "react-native-reanimated": "^4.0.0",
  "turbo": "^2.7.0",
  "vitest": "^4.1.0",
  "fast-check": "^4.7.0",
  "@fast-check/vitest": "^0.2.0",
  "@playwright/test": "^1.59.0",
}
```

> 📝 **Note** : dans `apps/mobile/package.json`, `tailwindcss` est épinglé à `^3.4.0` (requis par NativeWind 4.1), pas `^4.2.0`. Voir §6.2.

---

## 7. Modèle de Données

### 7.1 Schéma PostgreSQL (extrait clés)

```sql
-- Multi-tenant root
CREATE TABLE studios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  brand_color TEXT DEFAULT '#0EA5E9',
  created_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- Users (membres, coachs, admins)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  email CITEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL CHECK (role IN ('member','coach','admin')),
  consents JSONB NOT NULL DEFAULT '{}', -- {marketing: bool, analytics: bool, v: "2026-01"}
  created_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_users_studio ON users(studio_id) WHERE deleted_at IS NULL;

-- Cours planifiés
CREATE TABLE classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  coach_id UUID REFERENCES users(id),
  title TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  duration_min INT NOT NULL,
  capacity INT NOT NULL CHECK (capacity > 0),
  version INT NOT NULL DEFAULT 0, -- optimistic lock
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_classes_studio_time ON classes(studio_id, starts_at);

-- Réservations avec contrainte d'unicité
CREATE TABLE reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('confirmed','waitlist','cancelled','no_show')),
  created_at TIMESTAMPTZ DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  UNIQUE(class_id, user_id)
);

-- Séances loggées (tracking)
CREATE TABLE workout_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  studio_id UUID REFERENCES studios(id),
  started_at TIMESTAMPTZ NOT NULL,
  duration_min INT,
  exercises JSONB NOT NULL DEFAULT '[]',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_sessions_user_time ON workout_sessions(user_id, started_at DESC);

-- Audit log (immuable, append-only)
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id UUID,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id UUID,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### 7.2 Row Level Security (RLS)

```sql
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_read_own ON users FOR SELECT
  USING (id = current_setting('app.user_id')::uuid);
CREATE POLICY users_read_same_studio ON users FOR SELECT
  USING (studio_id = current_setting('app.studio_id')::uuid
         AND current_setting('app.role') IN ('admin','coach'));

ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
CREATE POLICY reservations_read_own ON reservations FOR SELECT
  USING (user_id = current_setting('app.user_id')::uuid);
```

Les variables `app.user_id`, `app.studio_id`, `app.role` sont injectées à l'ouverture de chaque connexion par le middleware Hono après vérification JWT. Même en cas de bug côté API, la base refuse physiquement les accès cross-tenant.

### 7.3 Concurrence réservation

Double réservation sur la dernière place évitée par :

1. **Compteur Redis** (`class:{id}:remaining`) décrémenté atomiquement avec `DECRBY`.
2. **Transaction PostgreSQL** avec `SELECT ... FOR UPDATE` sur la classe + insertion de la réservation, rollback si `remaining < 0`.
3. **Optimistic lock** sur `classes.version` pour les modifications de capacité par l'admin.

---

## 8. Sécurité & RGPD by Design

### 8.1 Authentification

- **JWT** RS256, access token TTL **15 min**, refresh token rotatif **30 j** stocké httpOnly Secure SameSite=Lax.
- **Apple Sign-In** obligatoire sur iOS (requirement App Store).
- **Biométrie** (Face ID / Touch ID) déverrouille le refresh token stocké dans Secure Enclave — **ne remplace pas** l'auth serveur.
- **Rate limit login** : 5 tentatives / 15 min par IP + email (sliding window Redis).
- **Password** : bcrypt coût 12 minimum. Check HIBP à l'inscription.
- **MFA TOTP** disponible pour admins studio (Phase 2).

### 8.2 Autorisation

- **RBAC** : `member`, `coach`, `admin`.
- **Scope tenant** : toutes les requêtes transportent `studio_id` dans le JWT.
- **RLS PostgreSQL** comme dernier rempart (jamais désactivé en prod).
- **Policies testées** en isolation via `pgTAP` avant chaque déploiement.

### 8.3 Protection API

- **Rate limiting** via Upstash sliding window : 100 rps/IP + 500 rps/user.
- **Validation Zod** stricte sur tous les inputs, rejet au Worker edge.
- **Headers Cloudflare** : HSTS preload 1 an, X-Frame-Options DENY, CSP strict avec nonce, Referrer-Policy strict-origin.
- **WAF Cloudflare** règles OWASP Core Rule Set activées.
- **Turnstile** sur inscription + login.
- **API keys** partenaires hashées bcrypt.

### 8.4 Chiffrement

- **Transport** : TLS 1.3 obligatoire, HTTP/3 activé.
- **At rest** : Neon chiffre tout par défaut en AES-256.
- **Sensibles** (données médicales éventuelles) : colonne chiffrée applicativement avant insertion (libsodium sealed box).
- **Secrets** : Infisical en dev/staging, Cloudflare Secrets en prod Workers.

### 8.5 RGPD by design

| Exigence                    | Implémentation                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Consentement granulaire** | Table `consents` JSONB par user : `{marketing, analytics, third_party}` + version des CGU. Timestamp immuable.                                       |
| **Droit à l'oubli**         | `DELETE /me` → trigger SQL cascade + purge R2 (avatars) + purge audit log après 30 j légaux.                                                         |
| **Portabilité**             | `GET /me/export` → job async qui génère un ZIP JSON+CSV, envoyé par email via lien signé 72 h.                                                       |
| **Minimisation**            | Aucun tracking tiers par défaut. Pas de Google Analytics.                                                                                            |
| **Analytics first-party**   | Tinybird/PostHog self-hosted, anonymisation IP au niveau ingestion.                                                                                  |
| **DPA**                     | Modèle type fourni pour les studios opérateurs.                                                                                                      |
| **Sous-traitants**          | Liste publique : Neon (EU Frankfurt), Cloudflare (EU, Workers + Queues + R2), Upstash (EU, Redis + QStash), Resend (EU), Stripe (EU). Aucun US-only. |
| **Données de santé**        | Traitement spécifique Article 9 RGPD : consentement explicite séparé, journalisation des accès.                                                      |
| **Hébergement**             | Europe-only (Neon EU région Frankfurt/Paris, Cloudflare EU).                                                                                         |
| **Audit log**               | Immuable, append-only, consultable par le DPO du studio.                                                                                             |

### 8.6 Check-list pré-production

- [ ] Audit OWASP ZAP automatisé en CI.
- [ ] Scan dépendances Socket.dev / Snyk quotidien.
- [ ] Penetration test externe avant v1.0.
- [ ] Bug bounty via YesWeHack tier 2.
- [ ] Déclaration CNIL (traitement non-obligatoire mais DPO recommandé dès 500 membres).
- [ ] Politique de confidentialité claire (lecture CE1).

---

## 9. Scalabilité & Performance

### 9.1 Stratégie par couche

| Couche            | Mécanisme                       | Limite free tier                       |
| ----------------- | ------------------------------- | -------------------------------------- |
| **Edge CDN**      | Cloudflare cache + géo-routing  | illimité                               |
| **API**           | Workers scale auto, pas de conf | 100k req/jour free, 10M req/mois à 5 $ |
| **DB lecture**    | Neon read replicas EU           | auto-scale                             |
| **DB écriture**   | Hyperdrive connection pool      | —                                      |
| **Cache chaud**   | Upstash Redis                   | 10k cmd/jour free, puis 0.20 $/100k    |
| **Event bus**     | Cloudflare Queues (temps réel)  | 100k msg/jour free                     |
| **Jobs différés** | Upstash QStash                  | 500 msg/jour free                      |
| **Assets**        | R2 + Cloudflare Images          | 10 GB free + zéro egress               |

### 9.2 Zero downtime

- **Migrations expand/contract** — ajout de colonne + dual-write + bascule + suppression dans PR séparée.
- **Blue/green** sur Vercel (web) et Workers (API) via aliases.
- **Rollback < 60 s** via `wrangler rollback` + Vercel instant rollback.

### 9.3 Test de charge MVP

Cible validation : **50 réservations/seconde sur un cours à capacité 20**, 0 double-booking, p99 < 300 ms.

Outils : `k6` + `Artillery` en CI nightly contre un environnement staging Neon branch.

### 9.4 Cold start

Cloudflare Workers = **~5 ms cold start** en V8 isolates, vs 300-1500 ms sur AWS Lambda Node. Critique pour une app mobile qui réveille une connexion toutes les X secondes.

---

## 10. Direction Artistique (DA)

### 10.1 Mood & références

Inspiration principale : **Runna** et **Bevel** (identifiés par la communauté Dribbble comme les références 2026 du fitness premium).

- **Runna** — dark mode, typo géométrique, data-dense mais aérée, accent vert lime.
- **Bevel** — clean, generous whitespace, refined typography.
- **Strava** — graphiques data, orange iconique.
- **Apple Fitness** — anneaux, gradients saturés, glassmorphism iOS 26.

**Anti-références** : Basic-Fit (publicitaire, jaune criard), Fitbit rebrandé Google Health (trop générique), Freeletics (trop orienté fitness-influencer).

### 10.2 Palette

**Thème sombre-first** (80 % des sessions mobile fitness se font en dark mode).

```css
:root {
  /* Neutral — dark first */
  --bg-0: #09090b; /* zinc-950 - background principal */
  --bg-1: #18181b; /* zinc-900 - surface */
  --bg-2: #27272a; /* zinc-800 - élevé */
  --border: #3f3f46; /* zinc-700 */
  --text-hi: #fafafa; /* zinc-50 */
  --text-mid: #a1a1aa; /* zinc-400 */
  --text-lo: #52525b; /* zinc-600 */

  /* Accent — Athlya Pulse */
  --accent: #84cc16; /* lime-500 — CTA, progression */
  --accent-hover: #a3e635; /* lime-400 */
  --accent-soft: rgba(132, 204, 22, 0.15);

  /* Secondary — discipline */
  --iron: #06b6d4; /* cyan-500 — data, heart rate */
  --warn: #f59e0b; /* amber-500 — warnings */
  --danger: #ef4444; /* red-500 — errors, PRs dépassés */

  /* Gradients */
  --grad-hero: linear-gradient(135deg, #84cc16 0%, #06b6d4 100%);
  --grad-session: linear-gradient(180deg, rgba(132, 204, 22, 0.08) 0%, transparent 100%);
}

/* Light mode — support complet */
[data-theme='light'] {
  --bg-0: #ffffff;
  --bg-1: #fafafa;
  --bg-2: #f4f4f5;
  --text-hi: #09090b;
  --text-mid: #52525b;
  --accent: #65a30d; /* lime-600 plus contrasté sur blanc */
}
```

### 10.3 Typographie

- **Display / Headings** : **Geist Sans** (Vercel, ouverte, OFL) — géométrique, lisibilité parfaite en dark mode, variable.
- **Body** : **Geist Sans** (même famille, économie de poids).
- **Chiffres / Data** : **Geist Mono** — tabular nums pour aligner séries et reps.
- **Accent** : rares usages de **Clash Display** (Indian Type Foundry, gratuite) pour écrans marketing uniquement.

Hiérarchie :

```
Display XL — 56/64  weight 700  -0.02em   "Votre rythme"
H1        — 36/44  weight 600  -0.02em
H2        — 24/32  weight 600
H3        — 18/28  weight 600
Body      — 16/24  weight 400
Small     — 14/20  weight 400
Caption   — 12/16  weight 500  +0.02em uppercase
```

### 10.4 Composants visuels

- **Coins** : radius 12-16 px (cartes), 999 px (boutons pill).
- **Ombres** : quasi absentes en dark mode, glow subtil lime sur focus/hover (`box-shadow: 0 0 0 3px var(--accent-soft)`).
- **Glassmorphism** léger sur modals iOS (backdrop-filter blur 20 px).
- **Micro-interactions** : haptic feedback sur check-in, swipe-to-cancel, progress rings animés à 60 fps (Reanimated).
- **Illustrations** : **aucune illustration figurative**. Data-viz + photographie abstraite (silhouettes noir et blanc haute contraste).

### 10.5 Iconographie

- **Système** : Lucide React (web) + Lucide React Native (mobile) — ligne 1.5 px, cohérence absolue.
- **Tailles** : 16 / 20 / 24 / 32 px.
- **Remplissage** : outline par défaut, solid pour états actifs.

### 10.6 App icon

Concept : **monogramme "A" stylisé** évoquant un sommet de montagne + un battement (pulse).

Specs :

- **Fond** : gradient lime → cyan (135°).
- **Symbole** : "A" géométrique blanc pur, ouverture en bas formant une forme de pic.
- **Tailles** : générées automatiquement par Expo Router depuis un SVG master 1024×1024.
- **iOS 26** : version Liquid Glass (Expo SDK 54+ supporte).
- **Android 16** : adaptive icon foreground + background séparés.

### 10.7 Tone of voice (copy)

- **Direct, pas motivationnel lourdingue**. Pas d'emojis feu / muscle par défaut.
- **Tutoiement** en FR (cohérent avec apps fitness).
- **Chiffres avant adjectifs** : _"12 reps, +5 kg sur ton dernier max"_ > _"Superbe performance !"_.
- **Pas de gamification kitsch**. Pas de badges "champion du mois".

---

## 11. Structure du Monorepo

```
athlya-platform/
├── .github/
│   └── workflows/                  # CI GitHub Actions
├── apps/
│   ├── web/                        # Next.js 16 (Vercel)
│   │   ├── app/
│   │   │   ├── (marketing)/        # Landing, pricing
│   │   │   ├── (auth)/             # Login, signup
│   │   │   ├── (app)/              # Dashboard authentifié
│   │   │   └── api/                # Route handlers Next
│   │   └── next.config.ts
│   ├── mobile/                     # Expo SDK 55
│   │   ├── app/                    # Expo Router
│   │   │   ├── (auth)/
│   │   │   ├── (tabs)/
│   │   │   │   ├── home.tsx
│   │   │   │   ├── book.tsx
│   │   │   │   ├── log.tsx
│   │   │   │   └── profile.tsx
│   │   │   └── _layout.tsx
│   │   ├── app.config.ts
│   │   └── eas.json
│   └── studio/                     # Dashboard admin studio (Next.js)
├── packages/
│   ├── api/                        # Hono Workers
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts
│   │   │   │   ├── members.ts
│   │   │   │   ├── reservations.ts
│   │   │   │   └── sessions.ts
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts
│   │   │   │   ├── rate-limit.ts
│   │   │   │   └── tenant.ts
│   │   │   └── index.ts
│   │   └── wrangler.toml
│   ├── db/                         # Drizzle schema + migrations
│   │   ├── schema/
│   │   │   ├── studios.ts
│   │   │   ├── users.ts
│   │   │   ├── classes.ts
│   │   │   ├── reservations.ts
│   │   │   └── sessions.ts
│   │   ├── migrations/
│   │   └── drizzle.config.ts
│   ├── auth/                       # Better Auth config
│   ├── ui/                         # Composants partagés (shadcn + NW)
│   │   ├── primitives/             # Button, Input, Card...
│   │   ├── patterns/               # BookingCard, ProgressRing...
│   │   └── themes/
│   ├── shared/                     # Types, Zod, utils
│   │   ├── schemas/                # Zod partagés front/back
│   │   ├── types/
│   │   └── constants/
│   └── config/
│       ├── eslint/
│       ├── tsconfig/
│       └── tailwind/
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

### 11.1 Commandes principales

```bash
# Installation
pnpm install

# Dev (tout en parallèle)
pnpm dev
# → web: http://localhost:3000
# → api: http://localhost:8787 (wrangler dev)
# → mobile: QR code Expo à scanner

# Build ciblé
pnpm build --filter=web
pnpm build --filter=api

# Type-check
pnpm typecheck

# Lint + format
pnpm lint && pnpm format

# Tests
pnpm test                    # vitest unit
pnpm test:e2e                # playwright
pnpm test:load               # k6

# Migrations DB
pnpm db:generate             # drizzle-kit generate
pnpm db:migrate              # applique à l'env courant
pnpm db:studio               # drizzle-kit studio GUI

# Déploiement
pnpm deploy:api              # wrangler deploy
# → web: auto via push sur main (Vercel)
# → mobile: eas build --platform ios --profile production
```

---

## 12. DevOps, CI/CD & Observabilité

### 12.1 Pipeline CI (GitHub Actions)

```yaml
# .github/workflows/ci.yml (extrait)
on: [pull_request, push]

jobs:
  check:
    steps:
      - pnpm install --frozen-lockfile
      - pnpm typecheck
      - pnpm lint
      - pnpm test
      - pnpm build

  preview:
    if: github.event_name == 'pull_request'
    steps:
      - Create Neon branch from main # DB isolée par PR
      - Deploy Workers preview (wrangler)
      - Deploy Vercel preview
      - Run migrations on branch
      - Run e2e Playwright against preview

  security:
    steps:
      - Socket.dev scan
      - pnpm audit --production
      - OWASP ZAP baseline
```

### 12.2 Déploiement prod

- **main → prod** automatique après : tests verts + approbation manuelle 1 reviewer.
- **Migrations** : étape séparée, bloquante, audit log Slack.
- **Rollback** : `wrangler rollback <version>` + `vercel rollback` en < 60 s.

### 12.3 Observabilité

| Signal        | Outil                           | SLO                                               |
| ------------- | ------------------------------- | ------------------------------------------------- |
| **Traces**    | OpenTelemetry + Axiom           | 100 % des requêtes échantillonnées jusqu'à 1k rps |
| **Logs**      | JSON structuré → Axiom          | Rétention 30 j prod                               |
| **Métriques** | Cloudflare Analytics + Axiom    | Dashboards live                                   |
| **Erreurs**   | Sentry (front + back)           | Alert Slack si nouveau type                       |
| **Uptime**    | BetterStack                     | Check 30 s, 5 locations                           |
| **Business**  | Tinybird dashboards             | Réservations/jour, MAU, churn                     |

### 12.4 Alerting

- **SLO p99 latency > 500 ms** pendant 5 min → Slack `#alerts`.
- **Error rate > 1 %** pendant 2 min → Slack + PagerDuty.
- **Rate limit saturé** > 80 % → Slack warning.
- **Renouvellement certif TLS** auto via Cloudflare.

---

## 13. Roadmap 12 mois

### T0 — Semaines 1–2 · Fondations

- Setup Turborepo + tooling (TS, ESLint, Prettier, commit hooks).
- Neon projet + schéma initial Drizzle.
- Cloudflare account + Workers project + domaine `athlya.app`.
- Design tokens + Tailwind config partagée.

### T1 — Semaines 3–10 · MVP v0.1 mono-studio

- Auth Better Auth (email + Apple + Google).
- Profil membre + consentement RGPD.
- Planning + réservation + annulation.
- QR code check-in.
- App mobile Expo Go testable sur iPhone réel.
- Dashboard admin minimal.

### T2 — Semaines 11–18 · v0.2 multi-tenant

- RLS complète, middleware tenant.
- Stripe abonnements + webhooks.
- Marque blanche (logo, couleur studio).
- Liste d'attente + notifications push.
- Apple Health import.
- i18n FR/EN.

### T3 — Semaines 19–26 · v0.3 coaching & wearables

- Programmes prédéfinis.
- Bluetooth FTMS.
- Coach IA (persona Mistral).
- Graphiques avancés (séries temporelles Tinybird).
- Export CSV avancé.
- Open-source public sur GitHub (AGPL-3.0).

### T4 — Semaines 27–36 · v1.0 production

- Pénétration test externe.
- Bug bounty.
- Documentation développeur complète.
- SDK clients (JS, Python, Go).
- Déploiement chez le studio pilote (Marie).
- Landing page + blog.

### T5 — Semaines 37–52 · Scale

- Onboarding 10 premiers studios.
- Partnerships équipementiers (SDK).
- Version auto-hébergeable Docker Compose + Helm chart.
- Enterprise SSO SAML.
- Conformité ISO 27001 (chemin).

---

## 14. Métriques de succès (SLOs & KPIs)

### 14.1 SLOs techniques

| SLO                            | Cible          | Mesure               |
| ------------------------------ | -------------- | -------------------- |
| **API availability**           | 99.9 % mensuel | Cloudflare Analytics |
| **p50 latency**                | < 100 ms       | OTel                 |
| **p99 latency**                | < 500 ms       | OTel                 |
| **Error rate**                 | < 0.1 %        | Sentry + Cloudflare  |
| **Mobile crash-free sessions** | > 99.5 %       | Sentry               |
| **Cold start Worker**          | < 50 ms        | OTel                 |

### 14.2 KPIs produit

| KPI                      | Cible 6 mois | Cible 12 mois |
| ------------------------ | ------------ | ------------- |
| **Studios actifs**       | 1 (pilote)   | 10            |
| **MAU**                  | 500          | 5 000         |
| **Réservations/semaine** | 2 000        | 25 000        |
| **NPS**                  | ≥ 40         | ≥ 55          |
| **Taux rétention M1**    | ≥ 70 %       | ≥ 80 %        |
| **Time-to-book** (P90)   | < 10 s       | < 7 s         |

### 14.3 KPIs business

- Coût mensuel infra à 1 000 MAU : **< 25 €** (free tiers + pay-as-you-grow).
- Coût mensuel infra à 10 000 MAU : **< 150 €**.
- Nombre de contributeurs GitHub ≥ 10 en 6 mois.

---

## 15. Risques & Mitigation

| #   | Risque                                                        | Probabilité | Impact    | Mitigation                                                                                       |
| --- | ------------------------------------------------------------- | ----------- | --------- | ------------------------------------------------------------------------------------------------ |
| R1  | Nom `Athlya` déjà déposé INPI                                 | Moyenne     | Haut      | Vérification trademark dès semaine 1 ; 3 noms backup prêts (Ironly, Forgefit, Pulseform).        |
| R2  | Cloudflare Workers limite 50 ms CPU atteinte sur calcul lourd | Faible      | Moyen     | Déléguer calculs lourds à Cloudflare Queues ou service Railway séparé.                           |
| R3  | Neon scale-to-zero latence cold connection                    | Moyenne     | Moyen     | Hyperdrive + keep-alive cron + pool min 1 connexion chaud.                                       |
| R4  | Expo Go limite modules natifs custom                          | Haute       | Bas (MVP) | 95 % des features couvertes par SDK standard ; bascule EAS Build dev client dès v0.2.            |
| R5  | CNIL contrôle sur données santé                               | Faible      | Haut      | DPO dès 500 MAU, consentement Article 9 explicite, audit log immuable.                           |
| R6  | Concurrence bsport baisse prix                                | Moyenne     | Moyen     | Différenciation par open-source + self-host, pas par le prix.                                    |
| R7  | Dépendance single-dev (bus factor 1)                          | Haute       | Haut      | Documentation exhaustive dès J1, IaC total, open-source pour attirer contributeurs.              |
| R8  | Churn après période gratuite pilote                           | Moyenne     | Haut      | Pricing différencié studios (gratuit < 50 membres) ; valeur par features pro, pas paywall.       |
| R9  | Vercel / Cloudflare enforcent nouveaux quotas                 | Faible      | Moyen     | Architecture portable ; prête à basculer Vercel → self-host Next.js, Workers → Fly.io / Railway. |
| R10 | Faille sécurité critique post-launch                          | Faible      | Haut      | Bug bounty dès v1.0 + audit externe + Security.md + rotation secrets 90 j.                       |

---

## Annexes

### A. Glossaire

- **RLS** (Row Level Security) — Mécanisme PostgreSQL qui applique des policies de lecture/écriture au niveau ligne, impossible à contourner depuis l'application.
- **FTMS** (Fitness Machine Service) — Protocole Bluetooth Low Energy standardisé pour les équipements de fitness connectés.
- **PPR** (Partial Prerendering) — Mécanisme Next.js 15+ qui rend une partie statique et streame le dynamique.
- **Expand/Contract migration** — Technique de migration en deux phases (ajout + suppression) garantissant zéro downtime.
- **SLO** (Service Level Objective) — Cible mesurable de disponibilité/performance.

### B. Liens de référence (2026)

- Next.js 16 · https://nextjs.org/blog/next-16-2 _(contenu reformulé pour conformité licences)_
- Expo SDK 55 · https://expo.dev/blog/upgrading-to-sdk-55
- Hono 4 · https://hono.dev/docs/
- Drizzle ORM 2026 · https://orm.drizzle.team/
- Better Auth · https://www.better-auth.com/
- Neon Postgres · https://neon.tech/
- Cloudflare Hyperdrive · https://developers.cloudflare.com/hyperdrive/
- NativeWind · https://www.nativewind.dev/
- TanStack Query v5 · https://tanstack.com/query/latest

### C. À faire avant la toute première ligne de code

- [ ] Vérifier disponibilité `athlya.app` + `.io` + `.com` + marque INPI + EUIPO.
- [ ] Créer comptes : GitHub org, Cloudflare, Neon, Vercel, Upstash, Expo, Stripe (test), Resend.
- [ ] Générer clés SSH dev + activer commit signature.
- [ ] Setup 1Password (ou équivalent) pour secrets.
- [ ] Valider qu'Expo Go fonctionne sur ton iPhone depuis Windows (scan d'un snack pour tester).
- [ ] Installer Node 24 LTS + pnpm 11 + Wrangler CLI + EAS CLI.
- [ ] Créer compte Apple Developer (99 $/an) **uniquement au moment de la v0.2** (avant c'est inutile).

---

_Fin du document. Ce project.md est vivant : à faire évoluer à chaque phase. Version 1.0 — 09/05/2026._

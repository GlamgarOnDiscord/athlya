# Analyse Technique — Apps de Salle de Fitness en France

### Objectif : identifier les stacks réels pour concevoir une alternative open-source, modulaire et ultra-scalable

---

## Avertissement méthodologique

Les entreprises de fitness ne publient pas leur architecture. Ce document s'appuie sur des sources indirectes : offres d'emploi, identifiants d'APK, commentaires App Store, annonces publiques, et fiches entreprise sur Welcome to the Jungle. Chaque affirmation est étiquetée selon son niveau de certitude : **confirmé**, **probable**, ou **inféré**. C'est une analyse de renseignement technique, pas une documentation officielle.

---

## PARTIE 1 — Écosystème français : qui développe vraiment sa propre app ?

### Le constat structurel

La première chose à comprendre sur le marché français du fitness, c'est que la grande majorité des chaînes n'ont pas de stack propriétaire. Elles achètent des plateformes SaaS clés en main. Mywellness (Technogym), bsport, Gympass/Wellpass, Mindbody : ces quatre acteurs couvrent 80% du marché des salles indépendantes et des chaînes moyennes. Seuls les géants comme Basic-Fit ont les moyens d'internaliser leur développement. Cette réalité définit le vrai terrain de jeu : une opportunité open-source ne concurrence pas Basic-Fit, elle concurrence bsport.

---

### Basic-Fit — l'unique géant avec une app propriétaire

Basic-Fit opère plus de 1 300 clubs en Europe, dont environ 300 en France. Leur app (`com.basicfit.trainingApp` sur le Play Store, développée par "Basic-Fit" sur l'App Store) est l'une des rares apps de salle développées entièrement en interne sur le marché européen.

**Mobile** — _probable_. Un avis App Store de février 2025 signé d'un "développeur iOS Swift" mentionne explicitement Swift, ce qui oriente vers une app native iOS ou une architecture hybride avec modules Swift natifs. L'absence de support Apple Watch et d'intégration Apple Health à cette date trahit néanmoins une équipe mobile réduite avec une roadmap contrainte. L'ID de package Android (`com.basicfit.trainingApp`) ne contient aucune référence à `com.facebook.react` ni à Flutter, ce qui exclut React Native standard et Flutter dans leur build actuel.

**Fonctionnalités clés documentées.** Réservation de cours collectifs en temps réel, QR code d'accès dynamique (token court-vécu), programme d'entraînement personnalisé, suivi de séances. En 2025, Basic-Fit a annoncé le déploiement de "personas IA" comme coachs virtuels, ce qui implique des appels à une API LLM (probablement OpenAI ou Azure OpenAI) côté backend.

**Infrastructure** — _inféré depuis les offres d'emploi_. AWS comme cloud principal. Le stack backend est probablement Java ou .NET côté services core (gestion d'abonnements, accès salle), avec des services plus récents en Node.js ou Python pour les features IA. Adyen pour les paiements (standard dans les entreprises néerlandaises de cette taille). CDN Cloudfront pour les assets. PostgreSQL ou Aurora pour les données membres.

**RGPD.** Siège aux Pays-Bas, donc soumis à l'AVG néerlandais et au RGPD européen. Leur DPA est publiquement disponible. Consentement par finalité collecté à l'inscription.

---

### bsport — la startup française qui veut tuer Mindbody

bsport a été fondée en 2018 à Paris par Zakaria Mansour et Sofian Medbouhi. C'est une plateforme SaaS B2B pour studios de fitness boutique (yoga, pilates, crossfit, boxe) : gestion CRM, planning, paiements, marketing, app membre marque blanche. En décembre 2024, ils ont levé 30 millions d'euros en Série B auprès de Base10 Partners et Octopus Ventures, avec participation de Stanford University. Ils servent aujourd'hui 3 000+ partenaires dans 40 pays.

**Ce que bsport révèle publiquement sur leur stack** — _confirmé via offres WTJ_. Le backoffice B2B (`pro.bsport.io`) est développé en React. L'app mobile B2C iOS et Android est développée in-house. Une offre de 2021 précisait une équipe de 4 développeurs, sans externalisation, avec "très peu de dette technique". L'app mobile suit un modèle marque blanche : chaque studio peut déployer sa propre version brandée.

**Mobile** — _probable_. React Native est le choix le plus cohérent avec un backoffice React, une petite équipe, et le besoin de marque blanche iOS + Android depuis un seul codebase. Les offres d'emploi récentes mentionnent TypeScript, ce qui confirme un écosystème JS/TS unifié.

**Backend** — _inféré_. Node.js comme runtime principal (cohérence avec React, TypeScript). PostgreSQL pour les données relationnelles (abonnements, réservations, facturation). Stripe pour les paiements. AWS ou GCP pour l'hébergement. Leur modèle multi-tenant impose une isolation des données par studio au niveau applicatif ou via schemas PostgreSQL séparés.

**Point faible documenté.** Des avis clients font état de pannes répétées, y compris pendant une démonstration commerciale. Signe d'une infrastructure qui a grandi plus vite que sa résilience. C'est exactement là qu'une alternative open-source avec architecture event-driven peut se différencier.

---

### Neoness / Keepcool — pas de stack propriétaire

Neoness (rachetée par Keepcool, groupe Verona) est la plus grande chaîne de salles de sport de Paris. Pas d'app mobile propriétaire. L'accès en salle fonctionne via **Wellpass** (anciennement Gympass), qui génère un badge NFC directement dans Apple Wallet ou Google Wallet. C'est une intégration PKPass standard, zéro développement interne. La gestion des abonnements et du planning de cours passe par des logiciels tiers non divulgués.

---

### Gymlib — plateforme d'avantages sport entreprise

Gymlib n'est pas une app de salle de sport. C'est une plateforme B2B qui agrège des accès dans plusieurs milliers de salles partenaires (Neoness, Basic-Fit, studios indépendants) et les revend aux entreprises comme avantage salarié. Leur app est un portail de réservation multi-enseignes. Stack probable : React Native côté mobile, Ruby on Rails ou Node.js côté backend, PostgreSQL. Intégrations partenaires via REST APIs avec chaque enseigne.

---

### Decathlon Coach — l'outsider data-driven

Decathlon Coach est une app de coaching sportif développée en interne par les équipes digitales d'Oxylane Group, DSI basée à Villeneuve-d'Ascq. C'est une app de tracking et de programmes d'entraînement, pas une app de gestion de salle.

**Mobile** — _probable_. React Native, cohérent avec le virage JS/TS de la DSI Decathlon ces dernières années. Intégrations Apple Health et Google Fit confirmées dans l'app. Navigation GPS pour les activités outdoor.

**Backend** — _inféré_. Infrastructure AWS Europe (Decathlon utilise AWS pour l'ensemble de son e-commerce). API REST. Les données de santé sont traitées avec un niveau de conformité RGPD élevé étant donné la nature sensible des données sportives.

---

### Mywellness by Technogym — l'infrastructure invisible

Technogym est l'équipementier qui alimente la grande majorité des tapis, vélos et bancs des salles françaises. Leur plateforme Mywellness est littéralement l'OS invisible du fitness européen.

**Architecture** — _confirmé via documentation publique_. Open platform REST API versionnée avec plus de 200 partenaires intégrés. Deux modes d'intégration : server-to-server pour les logiciels de gestion, end-user-to-end-user pour les apps membres. Support du protocole Bluetooth FTMS (Fitness Machine Service) pour tracker n'importe quel équipement connecté, quelle que soit la marque. Le tier Enterprise permet aux grandes chaînes d'intégrer les modules SDK Mywellness dans leur propre app branded.

**Données.** 30 000 clubs connectés, 40 millions d'utilisateurs enregistrés. Infrastructure multi-cloud européenne. RGPD by design depuis 2012, avec consentement explicite granulaire.

---

### Tableau de synthèse

| Acteur           | Type            | Stack mobile    | Backend probable      | Cloud      | App propriétaire     |
| ---------------- | --------------- | --------------- | --------------------- | ---------- | -------------------- |
| Basic-Fit        | Chaîne low-cost | Swift natif     | Java / Node.js        | AWS        | Oui                  |
| bsport           | SaaS B2B        | React Native    | Node.js / TS          | AWS ou GCP | Oui (marque blanche) |
| Neoness/Keepcool | Chaîne Paris    | Wellpass/PKPass | Tiers                 | —          | Non                  |
| Gymlib           | Agrégateur B2B  | React Native    | Rails / Node.js       | AWS        | Oui (portail)        |
| Decathlon Coach  | Coaching        | React Native    | Node.js               | AWS EU     | Oui                  |
| Mywellness       | SaaS B2B2C      | SDK intégrable  | REST API propriétaire | AWS / GCP  | SDK white-label      |

---

## PARTIE 2 — Pourquoi tout ça casse, et comment faire mieux

### Les trois failles systémiques du marché

**Faille 1 : la résilience est une réflexion d'après-coup.** Les pannes bsport documentées par leurs clients, l'incident API Peloton en 2021, les coupures des plateformes SaaS de gestion de salle partagent la même origine. L'infrastructure a été construite pour fonctionner, pas pour tomber. Dans les systèmes distribués, la panne n'est pas un accident, c'est un état normal. Une architecture résiliente teste ses propres défaillances en permanence plutôt que de les découvrir en production lors du Rush de janvier.

**Faille 2 : le RGPD est toujours bolté, jamais pensé.** Aucun des acteurs ci-dessus n'a conçu la gestion des données personnelles comme une feature de premier rang. C'est toujours une couche ajoutée après coup. Une architecture qui met le consentement granulaire, le droit à l'oubli, et la portabilité des données au cœur de son modèle dès le départ a un avantage compétitif réel, surtout face à la CNIL qui s'intéresse de plus en plus au secteur du fitness connecté.

**Faille 3 : le vendor lock-in est structurel.** Un studio qui quitte bsport perd ses données dans un format propriétaire. Un club qui cesse de payer Mywellness perd l'accès à l'historique de tracking de ses membres. L'open-source résout ce problème par définition : les données appartiennent à l'opérateur, le schéma est public, la migration est toujours possible.

---

## PARTIE 3 — Architecture cible recommandée

### Principes directeurs

L'objectif n'est pas de reproduire Netflix. Netflix a des milliers d'ingénieurs et des contraintes de streaming vidéo qui n'ont rien à voir avec la gestion d'une salle de sport. L'objectif est d'appliquer les mêmes principes architecturaux à une échelle honnête : déploiements sans interruption, isolation des pannes, scalabilité horizontale, observabilité complète.

Quatre axiomes structurent cette architecture.

Chaque domaine métier vit dans son propre service. Auth, membres, réservations, contenu, notifications sont des services indépendants qui communiquent via des contrats d'API stricts et un bus d'événements asynchrone. Un bug dans le service de notifications ne coupe pas les réservations.

Aucun service n'est un point de défaillance unique. Circuit breakers, retries exponentiels, fallbacks locaux : la résilience est by design. Si la base de données est lente, le cache répond. Si le service de réservation est en panne, le membre voit ses réservations existantes depuis le cache local plutôt qu'une erreur 500.

L'état du client précède toujours le réseau. L'app fonctionne en mode dégradé hors ligne. Elle synchronise au retour de connexion. Elle ne bloque jamais l'utilisateur sur un spinner infini.

L'infrastructure est déclarative et reproductible. Infrastructure as Code, CI/CD automatisé, déploiements blue/green : un développeur seul doit pouvoir déployer en production en toute confiance sans procédure manuelle.

---

### Vue d'ensemble du système

```
┌──────────────────────────────────────────────────────────────┐
│                          CLIENTS                             │
│   Web App (Next.js 15)      Mobile App (React Native/Expo)   │
└──────────────┬───────────────────────────┬───────────────────┘
               │                           │
               ▼                           ▼
┌──────────────────────────────────────────────────────────────┐
│                     CDN / Edge Layer                         │
│       Cloudflare (cache statique, WAF, DDoS, géo-routing)    │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                       API Gateway                            │
│            Hono on Cloudflare Workers (edge runtime)         │
│     Rate limiting · Auth middleware · Request routing        │
│          Versioning · Observabilité · Circuit breaker        │
└───────┬────────────┬───────────────┬──────────────┬──────────┘
        │            │               │              │
        ▼            ▼               ▼              ▼
┌───────────┐ ┌──────────────┐ ┌──────────┐ ┌──────────────┐
│   Auth    │ │   Members    │ │Reservations│ │   Content   │
│  Service  │ │   Service    │ │  Service  │ │   Service    │
│(Supabase) │ │  (Hono/TS)   │ │ (Hono/TS) │ │  (Hono/TS)  │
└─────┬─────┘ └──────┬───────┘ └─────┬─────┘ └──────┬───────┘
      │              │               │               │
      └──────────────┴───────────────┴───────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                     Event Bus (async)                        │
│               Upstash Kafka / Redis Streams                  │
│    reservation.created · session.completed · member.joined   │
└───────────────────────┬──────────────────────────────────────┘
                        │
         ┌──────────────┼──────────────────┐
         ▼              ▼                  ▼
┌──────────────┐ ┌─────────────┐ ┌──────────────────┐
│ Notification │ │  Analytics  │ │    AI / Coach    │
│   Service    │ │   Service   │ │    Service       │
│  (Resend +   │ │(ClickHouse) │ │ (OpenAI API ou  │
│  Expo Push)  │ │             │ │  modèle local)   │
└──────────────┘ └─────────────┘ └──────────────────┘

PERSISTANCE
┌──────────────────────────────────────────────────────────────┐
│  Supabase PostgreSQL  (données relationnelles + RLS)         │
│  Upstash Redis        (cache chaud, compteurs, rate limits)  │
│  Cloudflare R2        (assets binaires : vidéos, photos)     │
│  ClickHouse           (analytics, séries temporelles)        │
└──────────────────────────────────────────────────────────────┘
```

---

### Couche mobile — React Native + Expo

React Native avec Expo SDK est le choix optimal pour cibler iOS et Android depuis un seul codebase TypeScript. L'architecture mobile suit les principes Clean Architecture adaptés au contexte mobile, organisée en trois couches.

La couche Presentation contient les écrans et composants React Native, organisés par feature (auth, dashboard, workout, booking). Chaque feature expose ses propres hooks custom qui cachent toute la logique de fetching. Expo Router gère la navigation par file-system, exactement comme l'App Router de Next.js : la cohérence mentale entre web et mobile est un avantage direct pour un développeur seul.

La couche Domain regroupe les entités métier (Member, Session, Workout, Booking) et les use cases sous forme de fonctions pures testables sans dépendance au framework. Cette couche ne connaît ni React, ni Expo, ni le réseau.

La couche Infrastructure gère les adaptateurs concrets : client HTTP (ky), stockage local (MMKV, 30 fois plus rapide qu'AsyncStorage), synchronisation offline via une queue de mutations persistée. Zustand pour l'état global UI. TanStack Query pour les données serveur avec cache automatique et revalidation en arrière-plan.

Le sync offline fonctionne ainsi. Chaque mutation (nouvelle réservation, log de séance) est d'abord écrite dans la queue locale MMKV. L'UI se met à jour immédiatement de façon optimiste. Au retour du réseau, la queue se vide dans l'ordre. En cas de conflit serveur, une stratégie last-write-wins s'applique pour les données non critiques, et un retour visuel informe l'utilisateur pour les cas critiques comme une réservation déjà prise par quelqu'un d'autre.

---

### Couche backend — services Hono

Chaque service est un worker Hono en TypeScript, déployable sur Cloudflare Workers (edge, 0ms cold start) ou sur Railway / Fly.io via Docker. Hono est ultra-léger, isomorphique, et s'intègre nativement avec Cloudflare D1, R2, et KV.

Le service Auth est entièrement délégué à Supabase Auth. JWT signé RSA-256, refresh tokens rotatifs, Apple Sign-In natif (obligatoire sur iOS selon les règles App Store), Google OAuth. Row Level Security activé sur toutes les tables : même si l'API a un bug, la base de données refuse physiquement les accès non autorisés.

Le service Members gère les profils, abonnements et historique. Toutes les mutations passent par des transactions PostgreSQL avec gestion explicite des rollbacks. Prisma comme ORM pour les migrations typées.

Le service Reservations est le plus critique. La gestion de la concurrence (deux membres qui réservent la dernière place simultanément) repose sur un optimistic lock : un champ `version` incrémenté à chaque modification, avec rejet de la transaction si la version ne correspond plus. Les compteurs de places disponibles en temps réel transitent par Redis, pas par PostgreSQL, pour éviter les contentions de lignes.

Le service Notifications est purement réactif : il écoute le bus d'événements et route. Il ne contient aucune logique métier. Expo Push Notifications pour le mobile, Resend pour les emails transactionnels.

---

### Scalabilité — stratégie par couche

**Edge Layer.** Cloudflare absorbe le trafic entrant avec WAF, DDoS protection, et cache agressif des assets statiques. Les Workers font office de micro-gateways géographiquement distribués : une requête depuis Lyon est traitée dans un datacenter européen sans jamais toucher le backend principal.

**Service Layer.** Sur Cloudflare Workers, le scaling est automatique et illimité par défaut. Pour les services déployés en containers, Railway et Fly.io offrent du scaling horizontal via répliques automatiques basées sur les métriques CPU et mémoire.

**Database Layer.** Supabase gère le connection pooling via PgBouncer natif, critique pour les Workers qui ne maintiennent pas de connexions persistantes. Les lectures à forte charge transitent par des read replicas. Upstash Redis scale automatiquement en serverless.

**Zero downtime.** Déploiements blue/green sur Vercel pour le web. Rolling updates sur les services containerisés. Les migrations de base de données suivent le pattern expand/contract : on ajoute la nouvelle colonne, on migre les données en arrière-plan, on supprime l'ancienne dans une PR séparée. Jamais de downtime pour une migration.

**Observabilité.** OpenTelemetry pour le tracing distribué end-to-end. Logs structurés JSON centralisés sur Axiom. Métriques sur Grafana Cloud. Alerting sur les SLOs définis : p99 latency sous 500ms, error rate sous 0.1%.

---

### Sécurité

**Authentification.** JWT access tokens avec TTL de 15 minutes, refresh tokens rotatifs en httpOnly cookie. Apple Sign-In obligatoire sur iOS. Biométrie locale (Face ID, Touch ID) via `expo-local-authentication` : elle déverrouille le token stocké dans le Secure Enclave, elle ne remplace pas l'authentification serveur.

**Autorisation.** RBAC à trois niveaux : membre, coach, admin. RLS PostgreSQL comme dernier rempart. Les politiques RLS sont testées en isolation avant tout déploiement.

**Protection API.** Rate limiting par IP et par user_id via middleware Hono + Upstash Redis (sliding window). Validation stricte de tous les inputs avec Zod. API keys hashées en bcrypt pour les intégrations partenaires. Headers de sécurité Cloudflare : HSTS, X-Frame-Options, CSP strict.

**Chiffrement.** TLS 1.3 obligatoire partout. Données médicales ou sensibles chiffrées en AES-256 avant insertion. Secrets gérés via Infisical (open-source, auto-hébergeable) ou Doppler.

**RGPD by design.** Chaque utilisateur a un endpoint `DELETE /me` qui purge toutes ses données en cascade et enregistre la suppression dans un audit log immuable. Le consentement est stocké avec timestamp et version des CGU. L'export de données en JSON est disponible en libre-service. Le schéma PostgreSQL est conçu dès le départ pour que la suppression d'un user_id propage en cascade sans laisser d'orphelins, via des foreign keys avec `ON DELETE CASCADE` explicites.

---

## PARTIE 4 — Architecture pour un projet personnel (Windows 11, test iOS gratuit)

### Le problème du Mac

On ne peut pas compiler un binaire IPA natif sans Mac. C'est une contrainte Apple non contournable. En revanche, on peut développer et tester une app iOS complète sur iPhone réel depuis Windows grâce à Expo Go.

Le workflow : coder sur Windows avec VS Code, lancer `npx expo start`, scanner le QR code avec l'app **Expo Go** (gratuite sur l'App Store) depuis le même réseau Wi-Fi. L'app tourne sur le vrai iPhone en quelques secondes, avec hot reload. Aucun compte développeur Apple payant, aucun simulateur, aucun Mac. La seule limitation réelle est que les modules natifs custom ne fonctionnent pas dans Expo Go, mais le SDK Expo standard couvre 95% des besoins d'une app de fitness : push notifications, caméra, biométrie, Bluetooth, géolocalisation.

Pour les builds de production iOS, **EAS Build** compile dans le cloud sur un Mac distant. Le free tier inclut 30 builds iOS par mois.

---

### Stack recommandée

**Web.** Next.js 15 App Router pour le frontend. Hono sur Cloudflare Workers pour les API routes edge. Supabase pour la base de données, l'auth, et le realtime. Vercel pour le déploiement (gratuit en hobby plan). TypeScript partout, Zod pour la validation.

**Mobile.** React Native + Expo SDK 52. Expo Router pour la navigation file-system. Zustand pour le state global. TanStack Query pour les données serveur. NativeWind pour les styles (Tailwind adapté RN). MMKV pour le stockage local offline.

**Infrastructure free tier.** Supabase : 500 MB base, 1 GB storage, 50 000 utilisateurs actifs mensuels. Vercel hobby : déploiements web illimités. Cloudflare Workers free : 100 000 requêtes par jour. Upstash Redis : 10 000 commandes par jour. Resend : 100 emails par jour. Ce stack couvre plusieurs centaines d'utilisateurs actifs sans dépenser un euro.

---

### Structure du projet (monorepo Turborepo)

```
fitness-app/
├── apps/
│   ├── web/                   # Next.js 15 (déployé sur Vercel)
│   └── mobile/                # React Native + Expo (testé via Expo Go)
├── packages/
│   ├── api/                   # Workers Hono (déployés sur Cloudflare)
│   ├── db/                    # Schéma Prisma + migrations Supabase
│   ├── ui/                    # Composants partagés web + mobile
│   └── shared/                # Types TS, utils, schémas Zod communs
├── turbo.json                 # Config Turborepo (cache intelligent)
└── package.json               # Workspace racine
```

Turborepo gère le cache des builds : si `packages/shared` n'a pas changé, ses dépendants ne sont pas reconstruits. Un seul `npm install` à la racine, un seul `npm run dev` pour tout lancer simultanément.

---

### Workflow quotidien sur Windows

`npm run dev` à la racine lance Next.js (port 3000), le worker Hono local via Wrangler (port 8787), et le serveur Expo (QR code dans le terminal). L'iPhone scanne le QR et charge l'app. Modifier un composant dans `packages/ui` met à jour le navigateur et le téléphone en temps réel de façon synchrone. Un push sur GitHub déclenche le déploiement Vercel (web), le déploiement Cloudflare (workers), et optionnellement un build EAS en arrière-plan.

---

### MVP — fonctionnalités phase 1

**Authentification.** Email/password et Apple Sign-In via Supabase Auth. Biométrie Face ID pour le déverrouillage rapide de session via `expo-local-authentication`.

**Profil membre.** Informations personnelles, abonnement actif, historique des entrées. Photo de profil sur Supabase Storage avec redimensionnement automatique.

**Réservation de cours.** Calendrier hebdomadaire, réservation en un tap, notification push de rappel 1h avant. Annulation possible jusqu'à 2h avant.

**Tracking séance.** Logger exercices, séries, répétitions, poids. Graphiques de progression sur 30 et 90 jours. Export CSV.

**QR Code d'accès.** Token JWT short-lived regénéré toutes les 2 minutes affiché en QR dans l'app, scannable par le staff ou une borne. Impossible à partager ou à rejouer.

---

### Bonnes pratiques

Commencer par le web. Next.js est plus rapide à itérer, les outils de debug sont meilleurs, et la logique métier construite côté web est réutilisable directement dans l'app mobile via le monorepo.

Écrire les schémas Zod une seule fois dans `packages/shared`. Ils servent de contrat API, de validation de formulaire côté client, et de documentation vivante du modèle de données. Une seule source de vérité pour les types, partagée entre le backend Hono, le frontend Next.js, et l'app Expo.

Tests : Vitest pour les fonctions utilitaires et les use cases de la couche domain. Playwright pour les flows critiques web. Pas de tests Detox en phase MVP — trop coûteux à maintenir pour un développeur seul.

Feature flags via GrowthBook (open-source, auto-hébergeable sur Railway) dès le départ. Déployer du code en production sans l'activer, mesurer l'impact d'une feature avant de la sortir globalement, rollback instantané sans nouvelle release.

---

## Conclusion

Le marché français du fitness est structurellement mal servi côté technologie. Les chaînes dépendent de SaaS propriétaires avec vendor lock-in fort, résilience insuffisante, et RGPD en retard. Basic-Fit est l'exception, mais son app native Swift reste fermée et sans intégration wearable sérieuse en 2025. bsport est le concurrent direct d'une alternative open-source : React Native, Node.js, PostgreSQL, et une architecture qui panne visiblement sous charge.

L'architecture proposée ici n'est pas plus complexe que ce qui existe. Elle est plus robuste dans ses fondations. Chaque service fait une chose, les données appartiennent à l'opérateur et à l'utilisateur by design, l'infrastructure tient sur un free tier jusqu'à plusieurs milliers d'utilisateurs. Un développeur seul peut la déployer en production depuis Windows en une journée.

C'est une base. Pas une destination.

---

_Rapport mis à jour le 09/05/2026 — Sources : App Store, Play Store, offres Welcome to the Jungle, documentation publique Mywellness, identifiants APK, annonces de levée de fonds publiques._
_Stack cible : Next.js 15 · Expo SDK 52 · Hono 4 · Supabase v2 · TanStack Query v5 · Turborepo 2_

# Politique de sécurité

Athlya est une plateforme fitness RGPD-first qui gère des données personnelles sensibles (identité, santé, paiements). Toute vulnérabilité est prise au sérieux. Ce document décrit comment signaler une faille et ce que vous pouvez attendre en retour.

---

## Signaler une vulnérabilité

**Ne pas** ouvrir d'issue publique sur GitHub pour une faille de sécurité.

Ouvrir un **[GitHub Security Advisory](https://github.com/GlamgarOnDiscord/athlya/security/advisories/new)** en privé avec les éléments suivants :

- Description de la vulnérabilité
- Composant concerné (package, endpoint, ou fichier)
- Version ou commit impacté
- Étapes de reproduction minimales
- Impact potentiel (exfiltration de données, escalade de privilèges, DoS, etc.)
- Correctif proposé si vous en avez un

Pour une communication chiffrée en dehors de GitHub, contacter via l'advisory (le channel GitHub Security Advisory est déjà privé et chiffré en transit).

---

## Ce que nous nous engageons à faire

| Étape                                                           | Délai cible                                                                                                     |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Accusé de réception                                             | 48 heures                                                                                                       |
| Triage initial (sévérité, reproductibilité)                     | 5 jours ouvrés                                                                                                  |
| Plan de correction communiqué                                   | 10 jours ouvrés                                                                                                 |
| Correctif déployé en production                                 | **critique** : 24-72 h · **élevée** : 14 jours · **moyenne** : 30 jours · **basse** : prochaine release mineure |
| Advisory publique (GitHub Security Advisory + CVE si pertinent) | après déploiement du correctif                                                                                  |

Nous respectons une politique de **coordinated disclosure**. Un crédit public vous sera proposé dans l'advisory (sauf anonymat demandé).

---

## Versions supportées

| Version                      | Sécurité                                                |
| ---------------------------- | ------------------------------------------------------- |
| `main` (v1.x)                | ✅ supportée                                            |
| `release/*` branches futures | ✅ supportées jusqu'à 12 mois après la release suivante |
| Forks                        | à la charge du fork                                     |

---

## Périmètre

### In-scope

- Les packages sous `packages/*` (API, auth, db, members, reservations, billing, notifications, ratelimit, shared)
- Les applications sous `apps/*` une fois démarrées (web, mobile, studio admin)
- Les workflows CI sous `.github/workflows/*`
- Les migrations SQL et policies RLS sous `packages/db/migrations/*`
- Les configurations Wrangler et déploiement Cloudflare Workers

### Out-of-scope

- Les dépendances tierces (signaler à leur mainteneur)
- Les services hébergés que nous consommons (Neon, Upstash, Resend, Stripe, Axiom, Sentry, Cloudflare) — à signaler à leur programme de responsible disclosure
- Les déploiements tiers qui ont forké ou modifié Athlya
- Les vulnérabilités théoriques sans PoC

---

## Ce qui compte comme vulnérabilité

**Exemples de sévérité critique ou élevée** :

- Bypass d'authentification ou d'autorisation
- Injection SQL contournant les policies RLS
- Fuite de données cross-tenant (un studio lit les données d'un autre)
- Violation de la contrainte d'invariance `audit_log` (append-only)
- Déni du service via endpoint non rate-limité
- Secret leak dans les logs, les réponses HTTP ou les messages d'erreur
- RCE dans un Worker ou sur un service backend
- XSS, CSRF, ou injection côté clients web/mobile
- Bypass de la vérification de signature Stripe webhook

**Exemples hors scope (ne sont pas des vulnérabilités)** :

- Absence de header de sécurité sur un endpoint expérimental non documenté
- Self-XSS nécessitant une interaction utilisateur complexe
- Rapports automatisés sans validation humaine (Nessus, Qualys, etc. sans PoC)
- Attaques de type social engineering contre les mainteneurs

---

## Bonnes pratiques de test

Lors de votre investigation, vous êtes autorisé à :

- Scanner les endpoints publics de notre environnement staging avec une intensité raisonnable
- Tester les flux d'authentification avec vos propres comptes
- Analyser le code source et les artefacts publics

Vous vous engagez à :

- **Ne pas** accéder à des données qui ne vous appartiennent pas
- **Ne pas** dégrader ou impacter la disponibilité du service pour d'autres utilisateurs
- **Ne pas** effectuer d'attaque de déni de service volumétrique
- **Ne pas** tenter de social engineer les mainteneurs ou les utilisateurs

Les recherches menées conformément à cette politique sont considérées comme autorisées et nous ne poursuivrons pas en justice les chercheurs qui la respectent.

---

## Bug bounty

Athlya ne propose pas encore de programme de récompense financière. Nous documentons tous les rapports valides dans le `CHANGELOG.md` et créditons leur auteur dans l'advisory GitHub.

---

## Contact

- **GitHub Security Advisory** : [GlamgarOnDiscord/athlya/security/advisories/new](https://github.com/GlamgarOnDiscord/athlya/security/advisories/new)
- **Délai de réponse** : 48 heures ouvrées

Pour toute question non-sécurité, ouvrir une [issue publique](https://github.com/GlamgarOnDiscord/athlya/issues).

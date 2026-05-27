# Expo Push — transferts hors UE (Art. 44 RGPD)

Issue **#86**. Infrastructure Expo Push (US). À finaliser **avant** activation push prod mobile ([`docs/roadmap/post-1.0.md`](../roadmap/post-1.0.md) v1.1).

## Données concernées

- Expo push token (device)
- Titre / corps notification (doit rester **sans PII** — IDs + libellés génériques)
- Métadonnées techniques (platform, projectId)

## Actions legal / ops

- [ ] Signer **DPA Expo** + **SCC 2021** (Module 2 ou équivalent)
- [ ] Archiver PDF dans vault ops + entrée registre traitements
- [ ] Cocher Phase 9 [`runbook-production-deploy.md`](../security/runbook-production-deploy.md) une fois signé

## Actions techniques

- [ ] Payload audit : pas d'email, nom, téléphone dans `body` push
- [ ] Respect `consents.pushNotifications` avant envoi (consumer notifications)
- [ ] Documenter dans [`dpia-template.md`](../security/dpia-template.md) § transferts (ligne Expo)

## Alternative long terme

FCM/APNs direct avec hébergement EU ou push self-hosted — effort élevé, hors v1.1.

## Références

- Expo privacy / DPA : https://expo.dev/privacy
- Issue #70 mobile epic (prérequis fonctionnel)

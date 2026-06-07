## Résumé

Expo Push notifications transitent par infrastructure **US** (Expo). Runbook production Phase 9 : « Notification Expo Push transfert hors-UE → SCC en place » — **non fait**.

## Impact

- **Sévérité** : Low-Medium / P3 compliance
- Art. 44 RGPD si push tokens / contenu notification = donnée personnelle
- DPIA template incomplet sans SCC Expo

## Solution proposée

### 1. Legal

- Signer DPA Expo + SCC Module 2021
- Documenter dans registre traitements

### 2. Technique (mitigation)

- Minimiser payload push (IDs only, pas email/nom)
- Consent `pushNotifications` granulaire (existe consents JSON)

### 3. Alternative long terme

FCM direct EU ou self-hosted push (effort 🔴)

## Critères d'acceptation

- [ ] DPA Expo signé + archivé ops
- [ ] DPIA section transferts Expo complétée
- [ ] Payload push audit — zero PII in notification body
- [ ] Runbook Phase 9 checkbox ✅

## Priorité

**P3** — avant activation push prod mobile (#11)

## Références

- `docs/security/runbook-production-deploy.md` Phase 9
- `docs/security/dpia-template.md`

## Résumé

La « résidence EU » repose sur Neon/Upstash EU + Smart Placement Cloudflare. **Pas de pin région Workers** (`region_exclusive_eu` absent — commentaire wrangler.toml L28-39). JWT claims, traceId, paths peuvent transiter par PoP hors UE.

## Impact

- **Sévérité** : High / P1 compliance
- Art. 44 RGPD — transfert sans garanties explicites compute edge
- Promesse README « Données hébergées exclusivement en UE » **incomplète** pour le compute

## Solution proposée

### Court terme

1. DPIA mise à jour — documenter Smart Placement vs hard pin
2. Vérifier DPA Cloudflare (data localization addendum)
3. Sentry EU déjà checké (S5-010) — étendre audit aux logs Axiom

### Long terme

- Workers Enterprise + `compatibility_flags = ["region_exclusive_eu"]` si budget
- Hyperdrive config région EU explicite
- Alternative : API gateway EU-only (Fly.io EU, etc.) — éjection path

## Critères d'acceptation

- [ ] DPIA template complété section transferts
- [ ] Décision documentée go/no-go Smart Placement
- [ ] Si Enterprise : wrangler.toml pin EU staging+prod

## Priorité

**P1** — validation DPO avant prod

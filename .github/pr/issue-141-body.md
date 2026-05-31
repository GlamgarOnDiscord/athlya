## Contexte

Audit P6 (Low–Medium, issue #141) : `ClassCapacityDO` = 1 WebSocket par cours. Un *hot class* (50+ connexions) concentre tout sur **un seul DO mono-thread** → broadcast O(abonnés) par booking + mémoire connexions bornée par l'isolate. Limite CF non gérée.

## Changements

- **Cap abonnés** `CLASS_CAPACITY_MAX_WS` (var Worker, défaut **500**, parse défensif → fallback défaut si absent/invalide/non-positif).
- **Load shedding** : au-delà du cap, l'upgrade renvoie `503 + X-Capacity-Fallback: poll + Retry-After: 30` au lieu d'accepter une fan-in non bornée.
- **Contrat fallback documenté** : sur ce 503, le client bascule en polling `GET /v1/classes` (déjà porteur de `remaining`). Le client web actuel rend `remaining` en SSR (WS opt-in), donc aucun changement front requis.
- Runbook `docs/runbooks/class-capacity-scaling.md` : limite, fallback, options de sharding (différées, à activer sur données d'incident), procédure de load test staging.

## Tests

- Shed > cap → 503 + headers, `acceptWebSocket` non appelé.
- Env invalide → cap défaut (500), upgrade accepté.
- `npx vitest run src/__tests__/durable-objects/class-capacity.test.ts` → 10/10. `tsc --noEmit` clean.

## Critères d'acceptation

- [x] Limite documentée (runbook + constante).
- [x] Fallback si DO saturé (503 + header poll).
- [ ] Test charge staging hot class — procédure documentée (exécution = staging, hors CI).

Closes #141

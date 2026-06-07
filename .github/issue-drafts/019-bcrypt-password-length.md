## Résumé

Zod schema password `.max(256)` (`packages/shared/src/schemas/api.ts`) mais bcrypt tronque à **72 bytes**. Caractères 73-256 = entropie zero côté hash.

Documenté `docs/ACTION-ITEMS.md` S2 — non résolu.

## Impact

- **Sévérité** : Medium / P2 security
- Fausse impression sécurité utilisateur
- OWASP Password Storage — long passwords mal gérés

## Solution proposée

### Option A — Cap Zod (simple)

```typescript
password: z.string().min(12).max(72);
```

Message i18n clair.

### Option B — Pre-hash (OWASP)

```typescript
bcrypt(sha256(password)); // 32 bytes always
```

Attention : changer casse existants → migration login.

### Option C — Documenter seulement

Reject — insuffisant pour prod.

## Critères d'acceptation

- [ ] Schema + tests API auth register/login
- [ ] i18n fr/en message limite
- [ ] ACTION-ITEMS S2 closed
- [ ] Pas de régression tests auth (123 tests)

## Priorité

**P2**

# bcryptjs — Framework Audit

_Last updated: 2026-05-14_

## Version Status

|               | Value                                          |
| ------------- | ---------------------------------------------- |
| **Used**      | ^3.0.2                                         |
| **Latest**    | 3.0.2 (current)                                |
| **Purpose**   | Password hashing (pure JS, Workers-compatible) |
| **Algorithm** | bcrypt, cost factor 12                         |

---

## Why bcryptjs (Not bcrypt)

Native `bcrypt` (npm `bcrypt`) requires N-API/nan bindings — unavailable on Cloudflare Workers. `bcryptjs` is a pure JavaScript implementation that runs identically on:

- Node 22 (tests)
- Cloudflare Workers (production)

---

## Configuration (Correct)

- **Cost factor**: 12 (OWASP 2024 lower bound — minimum recommended is 10, 12 provides ~200ms hashing time)
- **Async-only**: `hash()` and `compare()` — never `hashSync`/`compareSync`
- **Empty password guard**: Throws `EmptyPasswordError`

---

## Known Limitation: 72-Byte Truncation

bcrypt truncates input at **72 bytes (UTF-8)**. The project's Zod schema allows passwords up to 256 characters. Characters beyond byte 72 are silently ignored.

**Impact**: A user with a 100-character password gets the same hash as one using only the first 72 bytes.

**Mitigations** (pick one):

1. **Cap Zod schema at `.max(72)`** — simplest, honest UX
2. **Pre-hash with SHA-256**: `bcrypt(Base64(SHA-256(password)))` — uses all characters, standard pattern for bcrypt length extension
3. **Accept as-is** — most real passwords are under 72 bytes

Option 2 is the most secure for users with long passwords. Option 1 is the most transparent.

```ts
// Option 2 — SHA-256 pre-hash
import { createHash } from 'node:crypto';

function preparePassword(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('base64');
}

const hash = await bcrypt.hash(preparePassword(password), 12);
const valid = await bcrypt.compare(preparePassword(attempt), hash);
```

---

## Security Assessment

| Property                 | Value                                               |
| ------------------------ | --------------------------------------------------- |
| Cost factor              | 12 (~200ms on Workers)                              |
| Timing safety            | `bcrypt.compare()` is constant-time                 |
| Salt                     | Auto-generated per hash (embedded in `$2b$` string) |
| Timing oracle prevention | Dummy hash on missing user lookup                   |

---

## Deprecated Patterns

| Deprecated             | Replacement              | Status             |
| ---------------------- | ------------------------ | ------------------ |
| `bcrypt.hashSync()`    | `bcrypt.hash()` async    | Not used (correct) |
| `bcrypt.compareSync()` | `bcrypt.compare()` async | Not used (correct) |

---

## Checklist

- [x] Async-only (no blocking the event loop)
- [x] Cost factor 12 (OWASP compliant)
- [x] Empty password validation
- [x] Timing-oracle prevention (dummy hash on missing user)
- [ ] Address 72-byte truncation vs 256-char Zod limit (choose: cap at 72 or SHA-256 pre-hash)

## Sources

- https://github.com/dcodeIO/bcrypt.js
- https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html

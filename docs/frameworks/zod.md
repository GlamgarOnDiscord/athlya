# Zod 4 — Framework Audit

_Last updated: 2026-05-14_

## Version Status

|               | Value                                              |
| ------------- | -------------------------------------------------- |
| **Used**      | ^4.4.3                                             |
| **Latest**    | 4.4.3 (current)                                    |
| **Zod 3 EOL** | No EOL announced, but v4 is stable and recommended |

---

## Zod 4 API — Important Changes from Zod 3

### Top-Level String Validators (Breaking from Zod 3)

Zod 4 promotes common string validators to top-level schemas. **Do not use the Zod 3 chained style:**

```ts
// OBSOLETE (Zod 3 style — still works but deprecated in v4)
z.string().email();
z.string().url();
z.string().uuid();
z.string().cuid();

// ZOD 4 — preferred top-level approach
z.email();
z.url();
z.uuid();
z.guid();
z.base64();
z.base64url();
z.jwt();
z.cidr();
z.ipv4();
z.ipv6();
```

The chained versions still work for backwards compatibility but the top-level forms are more performant (no extra string schema layer) and are the documented canonical approach in Zod 4.

### Error Parameter Unification

```ts
// Zod 3 — separate params per method
z.string().min(1, { message: 'Required' }).max(100, { message: 'Too long' });

// Zod 4 — unified `error` param
z.string().min(1, 'Required').max(100, 'Too long');

// Or with error map:
z.string({ error: (ctx) => (ctx.input === undefined ? 'Required' : 'Invalid') });
```

### `z.interface()` — New in Zod 4

Alternative to `z.object()` for interface-like schemas. Better type inference, no `strip()` by default (keys not in schema are preserved at runtime but typed away):

```ts
// z.object() — strips unknown keys
const UserSchema = z.object({ id: z.uuid(), name: z.string() });

// z.interface() — passthrough by default (keys preserved, typed away)
const UserInterface = z.interface({ id: z.uuid(), name: z.string() });
```

Use `z.object()` when you want strict mode by default. Use `z.interface()` for DTOs where extra fields are expected.

### `z.check()` — Composable Refinement

```ts
// Before (.refine — still valid)
z.string().refine((val) => val.startsWith('#'), 'Must start with #');

// Zod 4 (.check — composable, reusable)
const hexColor = z.check(z.string(), (ctx) => {
  if (!/^#[0-9A-Fa-f]{6}$/.test(ctx.value)) {
    ctx.addIssue({ message: 'Invalid hex color' });
  }
});
```

### `z.template()` — Template Literal Validation

```ts
const StudioIdSchema = z.template`studio_${z.uuid()}`;
// Validates: "studio_550e8400-e29b-41d4-a716-446655440000"
```

---

## Current Usage Assessment

### Events (`packages/shared/src/events.ts`)

```ts
export const AthlyaEventSchema = z.discriminatedUnion('type', [...]);
```

Correct Zod 4 usage. The `envelopeShape()` factory with `z.literal()` discriminators is idiomatic.

### Schema Patterns to Update

```ts
// Current (Zod 3 style)
z.string().email().max(254);
z.string().uuid();

// Preferred (Zod 4)
z.email().max(254);
z.uuid();
```

Not a breaking change — just prefer the top-level forms for new code.

### Error Handling Pattern

```ts
const result = AthlyaEventSchema.safeParse(raw);
if (result.success) {
  return result.data;
}
const issues = result.error.issues.map((issue) => ({
  path: issue.path.map(String).join('.'),
  code: issue.code,
  message: issue.message,
}));
```

`result.error.issues` is stable across Zod 3 and 4. This pattern is correct.

### Billing (`packages/billing`)

Uses Zod for Stripe webhook shape validation without Stripe SDK dependency. Correct, no changes needed.

---

## Deprecated Patterns

| Zod 3 Pattern                      | Zod 4 Replacement              | Status                        |
| ---------------------------------- | ------------------------------ | ----------------------------- |
| `z.string().email()`               | `z.email()`                    | Use top-level for new code    |
| `z.string().url()`                 | `z.url()`                      | Use top-level for new code    |
| `z.string().uuid()`                | `z.uuid()`                     | Use top-level for new code    |
| `.refine()` for complex validation | `.check()` for composability   | Both valid                    |
| `z.ZodError` direct class          | `result.error` via `safeParse` | Already using correct pattern |

---

## Improvement Opportunities

### 1. `z.brand()` for Typed IDs

```ts
// Current
const UserIdSchema = z.string().uuid();
type UserId = z.infer<typeof UserIdSchema>; // string

// With branding
const UserIdSchema = z.uuid().brand('UserId');
type UserId = z.infer<typeof UserIdSchema>; // string & { __brand: 'UserId' }

// Now the compiler prevents mixing UserId and StudioId:
function getUser(id: UserId) { ... }
getUser(studioId); // TypeScript error
```

### 2. `z.template()` for Prefixed IDs

```ts
const MemberIdSchema = z.template`mbr_${z.uuid()}`;
const StudioIdSchema = z.template`stu_${z.uuid()}`;
```

### 3. Top-Level Email/UUID in New Schemas

Prefer `z.email()` and `z.uuid()` over `z.string().email()` and `z.string().uuid()` for all new schemas.

---

## Checklist

- [x] Using Zod 4 (^4.4.3)
- [x] Discriminated unions for event bus
- [x] `.strict()` on object schemas (prevents payload pollution)
- [x] Proper `.safeParse()` usage with error normalization
- [x] Shared schemas between frontend and backend (packages/shared)
- [ ] Migrate string validators to top-level forms (`z.email()`, `z.uuid()`) in new code
- [ ] Consider `z.brand()` for typed IDs (UserId, StudioId, etc.)
- [ ] Consider `z.interface()` for response DTOs
- [ ] Consider `z.template()` for prefixed ID schemas

## Sources

- https://zod.dev (Zod 4 docs)
- https://github.com/colinhacks/zod/releases
- https://github.com/colinhacks/zod/blob/main/CHANGELOG.md

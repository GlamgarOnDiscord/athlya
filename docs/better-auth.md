# Better Auth — Reference Documentation

> Context: Athlya uses a custom auth stack (bcryptjs + jose + Upstash Redis).
> This file is a curated reference for a future migration to better-auth.
> Stack: Next.js (web + studio) · Hono (API gateway) · Drizzle ORM · PostgreSQL (Neon).

---

## Table of Contents

1. [Installation](#installation)
2. [Core Configuration](#core-configuration)
3. [Next.js Integration](#nextjs-integration)
4. [Hono Integration](#hono-integration)
5. [Drizzle Adapter (PostgreSQL)](#drizzle-adapter-postgresql)
6. [Database Schema](#database-schema)
7. [Email / Password](#email--password)
8. [Session Management](#session-management)
9. [Cookies](#cookies)
10. [TypeScript](#typescript)
11. [Users & Accounts](#users--accounts)
12. [Hooks](#hooks)
13. [Rate Limiting](#rate-limiting)
14. [Security](#security)
15. [Plugins](#plugins)
    - [Have I Been Pwned](#have-i-been-pwned)
    - [Passkeys](#passkeys)
    - [Two-Factor Auth (2FA)](#two-factor-auth-2fa)
    - [Admin](#admin)
    - [Organization](#organization)
    - [Magic Link](#magic-link)
16. [Migration from Custom Auth](#migration-from-custom-auth)

---

## Installation

```bash
pnpm add better-auth
pnpm add @better-auth/drizzle-adapter   # Drizzle adapter
```

Install in **both** the API package and the web/studio apps if they each call the auth instance.

### Environment variables

```env
BETTER_AUTH_SECRET=<min-32-chars-random-string>
BETTER_AUTH_URL=https://your-app.com
```

Better Auth also reads `AUTH_SECRET` as fallback for `BETTER_AUTH_SECRET`.

---

## Core Configuration

```ts
// packages/auth/src/auth.ts
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { db } from '@athlya/db';

export const auth = betterAuth({
  appName: 'Athlya',
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,

  database: drizzleAdapter(db, { provider: 'pg' }),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 72, // matches current HIBP check range
    requireEmailVerification: false, // enable when email sender is wired
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }, _request) => {
      // wire your existing email sender here
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh after 1 day
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 min cookie cache (reduces DB hits)
    },
  },

  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      '/sign-in/email': { window: 10, max: 5 },
      '/sign-up/email': { window: 60, max: 10 },
    },
  },
});
```

### Type exports

```ts
export type Session = typeof auth.$Infer.Session;
export type User = (typeof auth.$Infer.Session)['user'];
```

---

## Next.js Integration

### Route handler

Create `apps/web/src/app/api/auth/[...all]/route.ts` (rename from current `[...nextauth]` if migrating from Auth.js):

```ts
import { auth } from '@/lib/auth';
import { toNextJsHandler } from 'better-auth/next-js';

export const { GET, POST } = toNextJsHandler(auth);
```

### Server components / Server actions

```ts
import { auth } from '@/lib/auth';
import { headers } from 'next/headers';

const session = await auth.api.getSession({ headers: await headers() });
if (!session) redirect('/login');
```

### Cookie management in Server Actions

When server actions need to set cookies (e.g., after sign-in), add the `nextCookies()` plugin:

```ts
import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';

export const auth = betterAuth({
  // ...
  plugins: [nextCookies()],
});
```

### Auth client (web app)

```ts
// apps/web/src/lib/auth-client.ts
import { createAuthClient } from 'better-auth/react';
import { inferAdditionalFields } from 'better-auth/client/plugins';
import type { auth } from '@athlya/auth';

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  plugins: [inferAdditionalFields<typeof auth>()],
});

export const { useSession, signIn, signOut, signUp } = authClient;
```

### Protecting pages (App Router)

```ts
// Recommended: validate in the page itself
import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  return <Dashboard user={session.user} />;
}
```

> **Note (Next.js 16+):** Use the proxy system instead of middleware for full session validation. `getSessionCookie()` only checks cookie existence — it does not validate the session.

### Client-side session hook

```tsx
'use client';
import { authClient } from '@/lib/auth-client';

export function UserMenu() {
  const { data, isPending } = authClient.useSession();
  if (isPending) return <Skeleton />;
  if (!data) return <a href="/login">Sign in</a>;
  return <span>{data.user.name}</span>;
}
```

---

## Hono Integration

Mount the handler on the Hono API gateway (`packages/api/src/worker.ts`):

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { auth } from '@athlya/auth';

const app = new Hono();

// CORS must be registered BEFORE routes
app.use(
  '/api/auth/*',
  cors({
    origin: ['https://athlya.app', 'https://studio.athlya.app'],
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
  }),
);

app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

// Session middleware for protected routes
app.use('/v1/*', async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'Unauthorized' }, 401);
  c.set('user', session.user);
  c.set('session', session.session);
  await next();
});
```

### Cross-domain cookies (web ↔ API on different origins)

```ts
// In the auth config
advanced: {
  crossSubDomainCookies: {
    enabled: true,
    domain: 'athlya.app',
  },
},
trustedOrigins: ['https://athlya.app', 'https://studio.athlya.app'],
```

On the client, always pass `credentials: 'include'` when fetching across origins.

---

## Drizzle Adapter (PostgreSQL)

```bash
pnpm add @better-auth/drizzle-adapter
```

```ts
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { db } from '@athlya/db';

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    // usePlural: true,  // if your tables are plural (users, sessions…)
  }),
  experimental: { joins: true }, // reduces DB round-trips (requires Drizzle relations)
});
```

### Generate / migrate schema

```bash
# Generate the better-auth schema additions
pnpm dlx auth@latest generate

# Then run your Drizzle migration as usual
pnpm dlx drizzle-kit generate
pnpm dlx drizzle-kit migrate
```

### Custom ID generation (align with current UUIDs)

```ts
advanced: {
  database: {
    generateId: () => crypto.randomUUID(), // or use uuid_generate_v7 once available
  },
},
```

---

## Database Schema

Better Auth requires four core tables. With the Drizzle adapter + `generate` command, these are created automatically.

| Table          | Key fields                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `user`         | `id`, `name`, `email` (unique), `emailVerified` (bool), `image`, `createdAt`, `updatedAt`                                  |
| `session`      | `id`, `userId` (FK → user), `token` (unique), `expiresAt`, `ipAddress`, `userAgent`, `createdAt`, `updatedAt`              |
| `account`      | `id`, `userId` (FK → user), `accountId`, `providerId`, `password`, `accessToken`, `refreshToken`, `createdAt`, `updatedAt` |
| `verification` | `id`, `identifier`, `value`, `expiresAt`, `createdAt`, `updatedAt`                                                         |

> Passwords live in `account.password` (not on `user`), with `providerId = 'credential'`.

### Extending the user schema

```ts
user: {
  additionalFields: {
    studioId: { type: 'string', required: false, input: false },
    role:     { type: ['member', 'coach', 'admin'], required: false, defaultValue: 'member', input: false },
  },
},
```

### Custom table names (match existing Athlya naming)

```ts
user:    { modelName: 'users' },
session: { modelName: 'sessions' },
```

### Database hooks

```ts
databaseHooks: {
  user: {
    create: {
      after: async (user) => {
        // e.g. create default consents row
        await db.insert(consentsTable).values({ userId: user.id });
      },
    },
    delete: {
      before: async (user) => {
        // soft-delete instead of hard-delete: set deleted_at
        await db.update(usersTable)
          .set({ deletedAt: new Date() })
          .where(eq(usersTable.id, user.id));
        return false; // abort the hard delete
      },
    },
  },
},
```

### Secondary storage (Upstash Redis — already in use)

```ts
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export const auth = betterAuth({
  secondaryStorage: {
    get: (key) => redis.get(key),
    set: (key, value, ttl) => (ttl ? redis.set(key, value, { ex: ttl }) : redis.set(key, value)),
    delete: (key) => redis.del(key),
  },
});
```

---

## Email / Password

### Setup

```ts
emailAndPassword: {
  enabled: true,
  minPasswordLength: 8,
  maxPasswordLength: 72,

  sendResetPassword: async ({ user, url }, _request) => {
    void sendEmail({ to: user.email, subject: 'Reset password', text: url });
    // void to avoid timing attacks (do not await)
  },

  onPasswordReset: async ({ user }) => {
    console.log(`Password reset for ${user.email}`);
  },

  revokeSessionsOnPasswordReset: true,
  resetPasswordTokenExpiresIn: 3600, // 1 hour (matches current impl)
},
```

### Client usage

```ts
// Sign up
const { data, error } = await authClient.signUp.email({
  email: 'user@example.com',
  password: 'password123',
  name: 'Jane Doe',
  studioSlug: 'my-gym', // additional field
});

// Sign in
const { data, error } = await authClient.signIn.email({
  email: 'user@example.com',
  password: 'password123',
  rememberMe: true,
});

// Sign out
await authClient.signOut();

// Request password reset
await authClient.requestPasswordReset({
  email: 'user@example.com',
  redirectTo: '/reset-password',
});

// Confirm reset (on the reset-password page, token from URL)
await authClient.resetPassword({ newPassword: 'newpass123', token });

// Change password (authenticated)
await authClient.changePassword({
  currentPassword: 'oldpass',
  newPassword: 'newpass123',
  revokeOtherSessions: true,
});
```

### Custom password hashing (Argon2 or keep bcrypt)

```ts
import bcryptjs from 'bcryptjs';

emailAndPassword: {
  enabled: true,
  password: {
    hash:   (password) => bcryptjs.hash(password, 12),
    verify: ({ password, hash }) => bcryptjs.compare(password, hash),
  },
},
```

> Default is `scrypt` (Node built-in, OWASP-recommended when argon2 unavailable).

### Email enumeration protection

Enabled automatically when `requireEmailVerification: true` or `autoSignIn: false`. Sign-up returns `200` regardless of whether the email exists.

---

## Session Management

```ts
session: {
  expiresIn:    60 * 60 * 24 * 7,  // 7 days
  updateAge:    60 * 60 * 24,       // extend if < 1 day remaining
  freshAge:     60 * 60 * 24,       // "fresh" = signed in within last day

  cookieCache: {
    enabled:  true,
    maxAge:   60 * 5,               // signed cookie cache, avoids DB on every request
    strategy: 'jwt',                // 'compact' | 'jwt' | 'jwe' (encrypted)
  },
},
```

### Server-side session access

```ts
import { auth } from '@athlya/auth';
import { headers } from 'next/headers';

const session = await auth.api.getSession({ headers: await headers() });
// session.user  → User
// session.session → Session
```

### Session operations (client)

```ts
// List all active sessions
const sessions = await authClient.listSessions();

// Revoke a specific session
await authClient.revokeSession({ token: 'session-token' });

// Revoke all other sessions
await authClient.revokeOtherSessions();

// Reactive hook
const { data: session, isPending } = authClient.useSession();
```

---

## Cookies

All cookies are `httpOnly`, `secure` (in production), signed with `BETTER_AUTH_SECRET`.

```ts
advanced: {
  cookiePrefix: 'athlya',           // cookies: athlya.session_token, etc.

  cookies: {
    session_token: {
      attributes: { sameSite: 'lax', path: '/' },
    },
  },

  useSecureCookies: true,           // force secure even in dev if needed
},
```

### Safari / ITP (cross-domain setup)

If the API (`api.athlya.app`) and the web app (`athlya.app`) are on different subdomains:

```ts
advanced: {
  crossSubDomainCookies: {
    enabled: true,
    domain: 'athlya.app',
  },
},
trustedOrigins: ['https://athlya.app', 'https://studio.athlya.app'],
```

Or configure a Vercel/Cloudflare reverse proxy to forward `/api/auth/*` from the same domain.

---

## TypeScript

Requires `strict: true` (or at minimum `strictNullChecks: true`) in `tsconfig.json`.

### Infer session + user types

```ts
// Server (from auth instance)
export type Session = typeof auth.$Infer.Session;
export type User = Session['user'];

// Client (from auth client)
import type { auth } from '@athlya/auth';
import { inferAdditionalFields } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  plugins: [inferAdditionalFields<typeof auth>()],
});

export type Session = typeof authClient.$Infer.Session;
```

### Additional fields on client (separate packages)

```ts
export const authClient = createAuthClient({
  plugins: [
    inferAdditionalFields({
      user: {
        studioId: { type: 'string' },
        role: { type: 'string' },
      },
    }),
  ],
});
```

---

## Users & Accounts

### Update user

```ts
await authClient.updateUser({ name: 'New Name', image: 'https://…' });
```

### Change email (requires `sendVerificationEmail`)

```ts
// Enable in config
user: {
  changeEmail: {
    enabled: true,
    sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
      void sendEmail({ to: user.email, subject: 'Confirm email change', text: url });
    },
  },
},

// Client
await authClient.changeEmail({ newEmail: 'new@example.com', callbackURL: '/profile' });
```

### Delete user (RGPD)

```ts
// Enable in config
user: {
  deleteUser: {
    enabled: true,
    sendDeleteAccountVerification: async ({ user, url }) => {
      void sendEmail({ to: user.email, subject: 'Confirm account deletion', text: url });
    },
    beforeDelete: async (user) => {
      // cancel Stripe subscriptions, etc.
    },
    afterDelete: async (user) => {
      // queue RGPD export purge job
    },
  },
},

// Client — with password
await authClient.deleteUser({ password: 'user-password' });

// Client — with email verification token
await authClient.deleteUser({ token });
```

### Account linking

```ts
account: {
  accountLinking: {
    enabled: true,
    trustedProviders: ['google'],
    allowDifferentEmails: false,
  },
},
```

```ts
// Link a social provider
await authClient.linkSocial({ provider: 'google', callbackURL: '/profile' });

// Unlink
await authClient.unlinkAccount({ providerId: 'google' });

// List accounts
const accounts = await authClient.listAccounts();
```

---

## Hooks

Execute logic before/after Better Auth endpoints:

```ts
hooks: {
  before: [
    {
      matcher: (context) => context.path === '/sign-up/email',
      handler: async (context) => {
        const { studioSlug } = context.body as { studioSlug?: string };
        if (!studioSlug) {
          return context.json({ error: 'studioSlug is required' }, 422);
        }
      },
    },
  ],
  after: [
    {
      matcher: (context) => context.path === '/sign-up/email',
      handler: async (context) => {
        // e.g. create membership record after signup
        const newSession = context.context.newSession;
        if (newSession) {
          await createMembership(newSession.user.id);
        }
      },
    },
  ],
},
```

---

## Rate Limiting

```ts
rateLimit: {
  enabled: true,
  window: 60,
  max: 100,
  storage: 'secondaryStorage', // use Redis (already configured above)
  customRules: {
    '/sign-in/email':        { window: 10, max: 5  },
    '/sign-up/email':        { window: 60, max: 10 },
    '/forget-password':      { window: 60, max: 5  },
    '/reset-password':       { window: 60, max: 5  },
    '/update-password':      { window: 60, max: 5  },
    '/send-verification-email': { window: 60, max: 3 },
  },
},
```

> `auth.api.*` server-side calls bypass rate limiting entirely.

---

## Security

| Feature           | Better Auth behaviour                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| Password hashing  | `scrypt` by default (OWASP-compliant); pluggable                        |
| Session tokens    | `httpOnly`, `secure`, `SameSite=Lax` cookies                            |
| CSRF              | Origin header validation + SameSite cookies + Fetch Metadata            |
| OAuth             | State + PKCE stored in DB, deleted on completion                        |
| Email enumeration | Suppressed when `requireEmailVerification: true` or `autoSignIn: false` |
| Rate limiting     | Built-in, configurable per route                                        |
| Secret rotation   | Versioned secrets — old encrypted data stays readable during rotation   |

Report vulnerabilities to security@better-auth.com.

---

## Plugins

### Have I Been Pwned

Replaces the current `packages/auth/src/hibp.ts` module.

```bash
pnpm add better-auth   # plugin is bundled
```

```ts
import { haveIBeenPwned } from 'better-auth/plugins';

plugins: [
  haveIBeenPwned({
    enabled: true,
    customPasswordCompromisedMessage: 'Ce mot de passe est compromis. Choisissez-en un autre.',
  }),
],
```

Only the first 5 characters of the SHA-1 hash are sent to the HIBP API — the password never leaves the server in plaintext.

---

### Passkeys

Passwordless WebAuthn / FIDO2 authentication.

```bash
pnpm add @better-auth/passkey
```

```ts
import { passkey } from '@better-auth/passkey';

plugins: [passkey()],
```

```ts
// Client
import { passkeyClient } from '@better-auth/passkey';

export const authClient = createAuthClient({
  plugins: [passkeyClient()],
});

// Register a passkey
await authClient.passkey.addPasskey({ name: 'My MacBook' });

// Sign in with passkey
await authClient.signIn.passkey();
```

---

### Two-Factor Auth (2FA)

```ts
import { twoFactor } from 'better-auth/plugins';

plugins: [
  twoFactor({
    issuer: 'Athlya',
    totpOptions: { digits: 6, period: 30 },
    otpOptions: {
      sendOTP: async ({ user, otp }) => {
        void sendEmail({ to: user.email, subject: '2FA code', text: `Your code: ${otp}` });
      },
    },
  }),
],
```

```ts
// Client
import { twoFactorClient } from 'better-auth/plugins';

export const authClient = createAuthClient({
  plugins: [twoFactorClient({ redirectTo: '/2fa' })],
});

// Enable 2FA
const { totpURI, backupCodes } = await authClient.twoFactor.enable({ password });

// Verify TOTP
await authClient.twoFactor.verifyTOTP({ code: '123456' });

// Verify OTP (email)
await authClient.twoFactor.verifyOTP({ code: '123456' });
```

Run `pnpm dlx auth@latest migrate` after adding the plugin to add `twoFactorEnabled`, `twoFactorSecret`, `twoFactorBackupCodes` to the `user` table.

---

### Admin

```ts
import { admin } from 'better-auth/plugins';

plugins: [
  admin({
    defaultRole: 'member',
    adminRoles: ['admin'],
    adminUserIds: [process.env.SUPER_ADMIN_ID],
    impersonationSessionDuration: 60 * 60, // 1 hour
  }),
],
```

```ts
// Client
import { adminClient } from 'better-auth/plugins';

export const adminAuthClient = createAuthClient({
  plugins: [adminClient()],
});

// List members
const { users } = await adminAuthClient.admin.listUsers({
  query: { search: 'john', role: 'member', limit: 20 },
});

// Ban a user
await adminAuthClient.admin.banUser({ userId, banReason: 'Abuse', banExpiresIn: 60 * 60 * 24 * 7 });

// Impersonate
await adminAuthClient.admin.impersonateUser({ userId });
```

Adds fields to `user`: `role`, `banned`, `banReason`, `banExpires`.

---

### Organization

Replaces the current multi-tenant `studioId` approach with a proper organizations model.

```ts
import { organization } from 'better-auth/plugins';

plugins: [
  organization({
    allowUserToCreateOrganization: false, // admins only
    membershipLimit: 500,
    invitationExpiresIn: 60 * 60 * 48,   // 48 hours
    sendInvitationEmail: async ({ invitation, inviter, organization, url }) => {
      void sendEmail({ to: invitation.email, subject: `Invitation — ${organization.name}`, text: url });
    },
  }),
],
```

```ts
// Client
import { organizationClient } from 'better-auth/plugins';

// Create an organization (studio)
await authClient.organization.create({ name: 'My Gym', slug: 'my-gym' });

// Invite a member
await authClient.organization.inviteMember({ email: 'coach@gym.com', role: 'coach' });

// Set active organization (persisted in session)
await authClient.organization.setActive({ organizationId });
```

Tables created: `organization`, `member`, `invitation`.

---

### Magic Link

Passwordless email sign-in.

```ts
import { magicLink } from 'better-auth/plugins';

plugins: [
  magicLink({
    sendMagicLink: async ({ email, url }) => {
      void sendEmail({ to: email, subject: 'Sign in to Athlya', text: url });
    },
    expiresIn: 300,      // 5 minutes
    disableSignUp: false,
  }),
],
```

```ts
// Client
import { magicLinkClient } from 'better-auth/plugins';

export const authClient = createAuthClient({
  plugins: [magicLinkClient()],
});

await authClient.signIn.magicLink({ email: 'user@example.com' });
```

---

## Migration from Custom Auth

Athlya's current auth (`packages/auth`) maps to better-auth as follows:

| Current                          | Better Auth equivalent                                |
| -------------------------------- | ----------------------------------------------------- |
| `bcryptjs` hash in `password.ts` | `emailAndPassword.password.hash/verify`               |
| `jose` JWT in `jwt.ts`           | built-in session tokens (cookie-based, no JWT needed) |
| `hibp.ts` k-anonymity check      | `haveIBeenPwned()` plugin                             |
| `replay-redis.ts` nonce store    | `secondaryStorage` (Upstash)                          |
| `throttle.ts` rate limiter       | `rateLimit` config                                    |
| `/api/auth/login` route          | `toNextJsHandler(auth)` at `/api/auth/[...all]`       |
| `/api/auth/refresh` route        | built-in token rotation                               |
| `/api/auth/logout` route         | built-in `signOut` endpoint                           |
| `/api/auth/register` route       | built-in `signUp.email` endpoint                      |
| `AuthContext.tsx` + token-store  | `authClient.useSession()` + cookie session            |
| `assertSameOrigin` CSRF guard    | built-in origin validation + SameSite cookies         |

### DB schema migration checklist

- [ ] Add `user`, `session`, `account`, `verification` tables via `pnpm dlx auth@latest generate`
- [ ] Backfill existing users: create `account` row per user with `providerId = 'credential'` and hashed password
- [ ] Rename `users.deleted_at` → keep as soft-delete handled in `databaseHooks.user.delete.before`
- [ ] Port `consents` and `members` tables — these are outside the auth scope, no change needed
- [ ] Remove `packages/auth/src/{jwt,password,hibp,replay-redis,throttle}.ts` once migrated

### Recommended migration order

1. Add better-auth alongside the existing stack (no flag day)
2. Run schema generation, apply migrations
3. Backfill `account` table for existing users
4. Replace `/api/auth/*` route handlers in `apps/web` one by one
5. Replace `AuthContext.tsx` with `authClient.useSession()`
6. Remove `packages/auth` when all consumers are migrated
7. Add HIBP, 2FA, and Passkey plugins progressively

---

_Source: https://better-auth.com/llms.txt — fetched 2026-05-16_

# R2 avatars — design + roadmap

**Sprint 15 / Slice 15.3 (Epic N2.13)**

Plan de migration de l'upload avatar `data:` URL inline → Cloudflare
R2 presigned URL.

## Contexte

Le pattern actuel (Sprint 8, V36) :

- L'utilisateur sélectionne un fichier image dans `<MyProfileForm />`
- Le client encode en base64 + `data:` URL
- Le `data:` URL est envoyé dans le PATCH `/v1/me` body JSON
- Le backend stocke le `data:` URL dans `users.profile.avatar`
  (jsonb)
- À l'affichage, le frontend rend `<img src={avatar} />` direct

**Limitations** :

- 256 KiB cap sur le body limit Cloudflare → photos > 200 KiB
  sont rejetées 413
- Le DB row grossit linéairement avec la qualité photo
- Pas de CDN devant : chaque GET `/v1/me` re-télécharge la photo
- Mauvais pour mobile (data plan)

## Architecture cible

```
Client                 Gateway (Worker)              R2 bucket
  │                          │                          │
  │ 1. POST /v1/me/avatar   │                          │
  │    { contentType }       │                          │
  │ ───────────────────────► │                          │
  │                          │ 2. createPresignedUrl    │
  │                          │ ───────────────────────► │
  │                          │ ◄── { url, key } ──────  │
  │ ◄── { uploadUrl, getUrl }│                          │
  │                          │                          │
  │ 3. PUT <uploadUrl>       │                          │
  │ ─────────────────────────────────────────────────► │
  │ ◄── 200 OK ──────────────────────────────────────── │
  │                          │                          │
  │ 4. PATCH /v1/me          │                          │
  │    { avatar: getUrl }    │                          │
  │ ───────────────────────► │                          │
  │                          │ 5. UPDATE users          │
  │                          │ ──► Drizzle              │
  │ ◄── { profile updated }  │                          │
```

## Composants

### 1. Bucket R2

```bash
wrangler r2 bucket create athlya-avatars
wrangler r2 bucket cors set athlya-avatars --rules cors.json
```

CORS rules (`cors.json`) :

```json
[
  {
    "allowedOrigins": ["https://app.athlya.app", "https://staging.app.athlya.app"],
    "allowedMethods": ["PUT", "GET"],
    "allowedHeaders": ["*"],
    "maxAgeSeconds": 3600
  }
]
```

### 2. Endpoint signer côté gateway

```ts
// packages/api/src/routes/me-avatar.ts (à créer)
router.post('/me/avatar', jwtAuth(), async (c) => {
  const claims = c.get('authClaims');
  const body = await c.req.json<{ contentType: string }>();

  // Validation : seul image/jpeg, image/png, image/webp acceptés.
  if (!ALLOWED_CONTENT_TYPES.has(body.contentType)) {
    throw new ValidationError('json', [
      { path: ['contentType'], code: 'invalid', message: 'must be image/jpeg|png|webp' },
    ]);
  }

  // Key par user — overwrite-safe.
  const key = `users/${claims.userId}/avatar.${extOf(body.contentType)}`;

  // Generate presigned PUT URL with @aws-sdk/client-s3 +
  // R2 endpoint. Expires 5min — suffisant pour upload + le
  // client n'a pas besoin de retry au-delà.
  const uploadUrl = await deps.r2.signPutUrl(key, body.contentType, 300);
  const getUrl = `https://avatars.athlya.app/${key}`;

  return c.json({ uploadUrl, getUrl });
});
```

### 3. Client Next.js refactor

```tsx
// apps/web/src/app/me/MyProfileForm.tsx
const onAvatarChange = async (file: File) => {
  // Step 1 — request presigned URL
  const { uploadUrl, getUrl } = await fetch('/api/me/avatar', {
    method: 'POST',
    body: JSON.stringify({ contentType: file.type }),
  }).then((r) => r.json());

  // Step 2 — upload direct to R2
  await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'content-type': file.type },
  });

  // Step 3 — patch profile with the public URL
  await fetch('/api/me', {
    method: 'PATCH',
    body: JSON.stringify({ avatar: getUrl }),
  });
};
```

### 4. Cleanup jobs

Quand un user supprime son compte (RGPD cascade) :

```sql
-- Within handleUserDeleted consumer
DELETE FROM users WHERE id = $1;  -- existing
```

Et côté Worker :

```ts
// packages/notifications/src/handlers/user-deleted.ts (étendu)
await deps.r2.deleteObject(`users/${userId}/avatar.jpg`);
await deps.r2.deleteObject(`users/${userId}/avatar.png`);
await deps.r2.deleteObject(`users/${userId}/avatar.webp`);
// (3 calls because we don't know which extension was used)
```

## Effort estimé

| Composant                                        | Effort         |
| ------------------------------------------------ | -------------- |
| Bucket + CORS provisioning                       | 30min ops      |
| Endpoint signer (route + adapter R2)             | 1.5h dev       |
| Tests unitaires (4-5 cas)                        | 1h dev         |
| Client refactor MyProfileForm                    | 1h dev         |
| Cleanup job dans handleUserDeleted               | 30min dev      |
| Migration script (existing avatars `data:` → R2) | 1h dev         |
| **Total**                                        | **~5h cumulé** |

## Migration des avatars existants

Pour chaque `users.profile.avatar` qui commence par `data:` :

1. Décoder en buffer
2. PUT dans R2 sous `users/{userId}/avatar.{ext}`
3. UPDATE le profile avec le `https://avatars.athlya.app/...`
   GetUrl

Script `packages/db/scripts/migrate-avatars-to-r2.ts` (slice
future, ~1h) :

```ts
const users = await db.select().from(usersTable).where(/* avatar starts with data: */);
for (const user of users) {
  const avatarBuffer = decodeDataUrl(user.profile.avatar);
  const key = `users/${user.id}/avatar.png`;
  await r2.putObject(key, avatarBuffer);
  await db.update(usersTable).set({ profile: { ...user.profile, avatar: `https://...${key}` } });
}
```

## Critères de provisioning

Avant de shipper :

| Item                                             | Status |
| ------------------------------------------------ | ------ |
| Bucket `athlya-avatars` créé                     | ⏳     |
| Bucket `athlya-avatars-staging` créé             | ⏳     |
| CORS rules configurées                           | ⏳     |
| Custom domain `avatars.athlya.app` provisioné    | ⏳     |
| `R2_AVATARS_BUCKET` binding dans `wrangler.toml` | ⏳     |
| Endpoint `/v1/me/avatar` POST + tests            | ⏳     |
| Client refactor MyProfileForm                    | ⏳     |
| Cleanup job RGPD cascade                         | ⏳     |
| Migration script existing avatars                | ⏳     |

## Pourquoi cette slice n'est pas livrée Sprint 15

Trade-off scope :

- **Avatars actuels fonctionnent** (data: URL, cap 200KiB)
- **R2 = 5h de dev cumulé** + provisioning ops
- **Sprint 15 = cleanup legacy**, pas chantier feature

Slice future quand :

- Une PR feature touche le profile picture
- Ou que le 256KiB cap pose problème (users qui veulent une photo
  HD)
- Ou avant le mobile (Epic 11 a besoin de R2 pour les workout
  videos / pictures de toute façon)

## Références

- Cloudflare R2 docs: <https://developers.cloudflare.com/r2/>
- AWS SDK v3 S3 client (R2 compatible) :
  <https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-client-s3/>
- Audit finding (Vague 12 V12 originale) — `data:` URL workaround
- N2.13 in `tasks.md`

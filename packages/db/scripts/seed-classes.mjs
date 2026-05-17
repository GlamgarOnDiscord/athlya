/**
 * Seed the local dev database with a handful of demo classes so
 * `GET /v1/classes` returns something for manual testing of the
 * web calendar. Idempotent: matches on `(studio_id, title,
 * starts_at)` and skips if the row already exists.
 *
 * Usage (PowerShell):
 *   $env:DATABASE_URL = 'postgresql://...'
 *   node packages/db/scripts/seed-classes.mjs
 *
 * Also seeds the matching Redis counters via UPSTASH_REDIS_REST_URL
 * + UPSTASH_REDIS_REST_TOKEN when both are present; otherwise skips
 * the Redis step and logs a warning (the service falls back to
 * `capacity` when the counter is missing).
 */

import postgres from 'postgres';

const STUDIO_SLUG = 'athlya-demo';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

const CLASSES = [
  {
    title: 'Yoga matinal',
    offsetHours: 24, // tomorrow +24h
    durationMin: 60,
    capacity: 12,
  },
  {
    title: 'HIIT express',
    offsetHours: 48,
    durationMin: 30,
    capacity: 20,
  },
  {
    title: 'Pilates du soir',
    offsetHours: 72,
    durationMin: 45,
    capacity: 15,
  },
];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1, prepare: false });

async function main() {
  const [studio] = await sql`
        SELECT id FROM studios WHERE slug = ${STUDIO_SLUG} LIMIT 1
    `;
  if (!studio) {
    console.error(`[seed-classes] studio "${STUDIO_SLUG}" not found — run seed-dev.mjs first`);
    process.exit(2);
  }

  const seeded = [];
  for (const c of CLASSES) {
    const startsAt = new Date(now + c.offsetHours * 60 * 60 * 1000);
    const existing = await sql`
            SELECT id FROM classes
            WHERE studio_id = ${studio.id}
              AND title = ${c.title}
              AND starts_at = ${startsAt}
            LIMIT 1
        `;
    if (existing.length > 0) {
      seeded.push({ id: existing[0].id, title: c.title, status: 'exists' });
      continue;
    }
    const [row] = await sql`
            INSERT INTO classes (studio_id, title, starts_at, duration_min, capacity, version)
            VALUES (${studio.id}, ${c.title}, ${startsAt}, ${c.durationMin}, ${c.capacity}, 0)
            RETURNING id
        `;
    seeded.push({ id: row.id, title: c.title, status: 'created' });
  }

  console.log(JSON.stringify({ studioId: studio.id, classes: seeded }, null, 2));

  // Best-effort Redis counter seeding.
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) {
    console.warn('[seed-classes] UPSTASH_REDIS_REST_URL / _TOKEN missing — skipping counter seed');
    return;
  }
  for (const s of seeded) {
    const cls = CLASSES.find((c) => c.title === s.title);
    if (!cls) continue;
    const res = await fetch(`${redisUrl}/set/class:${s.id}:remaining/${cls.capacity}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}` },
    });
    if (!res.ok) {
      console.warn(`[seed-classes] redis seed failed for ${s.id}: ${res.status}`);
    }
  }
  console.log('[seed-classes] redis counters seeded');
}

try {
  await main();
} finally {
  await sql.end({ timeout: 2 });
}

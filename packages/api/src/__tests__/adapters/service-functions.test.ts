import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmailTakenError } from '@athlya/auth';
import { PgDialect } from 'drizzle-orm/pg-core';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { createDrizzleUserRepo } from '../../adapters/auth-user-repo-drizzle.js';
import { createDrizzleDeletionRepo } from '../../adapters/cascade-repo-drizzle.js';
import { buildRecipientRepo } from '../../adapters/notifications-deps.js';
import { createDrizzlePasswordResetRepo } from '../../adapters/password-reset-repo-drizzle.js';
import { queryRows, serviceFn, uuidV7, writeRows } from '../../adapters/service-functions.js';

import type { AthlyaDbAny, AthlyaDbHttp } from '@athlya/db/client';
import type { SQL } from 'drizzle-orm';

/**
 * Issue #224 — pre-auth and background adapters call the SECURITY
 * DEFINER functions of migration 0032 instead of raw tenant tables.
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = resolve(here, '../..');
const migration = [
  '0032_service_definer_functions.sql',
  '0033_auth_event_recording.sql',
  '0037_auth_outbox_review_fixes.sql',
  '0038_studios_runtime.sql',
  '0039_runtime_rls_gaps.sql',
]
  .map((file) => readFileSync(resolve(here, '../../../../db/migrations', file), 'utf8'))
  .join('\n');
const dialect = new PgDialect();

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Fake db whose `execute` answers with `respond(call)` in the Neon `{ rows }` shape. */
function fakeDb(respond: (call: Call) => unknown[] | Error, shape: 'neon' | 'pg' = 'neon') {
  const calls: Call[] = [];
  const db = {
    execute(query: SQL) {
      const { sql, params } = dialect.sqlToQuery(query);
      const call = { sql, params };
      calls.push(call);
      const out = respond(call);
      if (out instanceof Error) return Promise.reject(out);
      return Promise.resolve(shape === 'neon' ? { rows: out } : out);
    },
  };
  return { db: db as unknown as AthlyaDbAny, calls };
}

const userRow = {
  id: '11111111-1111-4111-8111-111111111111',
  studio_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'member@athlya.test',
  display_name: 'Member',
  role: 'member',
  password_hash: 'hash',
  deleted_at: null,
  credentials_version: 3,
};

describe('service function contract with migration 0032', () => {
  const source = readFileSync(resolve(apiSrc, 'adapters/service-functions.ts'), 'utf8');
  const used = [...source.matchAll(/\b((?:auth|rgpd|notification|studio)_[a-z_]+)\(/gu)].map(
    (m) => m[1],
  );

  it('references the 20 service functions', () => {
    expect(new Set(used).size).toBe(20);
  });

  const granted = grantedToApp(migration);

  it.each([...new Set(used)])('%s is created and granted to athlya_app by the migrations', (fn) => {
    expect(migration).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION ${fn}\\(`, 'u'));
    expect(granted).toContain(fn);
  });

  it('only counts a grant loop whose body grants EXECUTE to athlya_app', () => {
    const loop = (grantee: string) => `
      FOREACH fn IN ARRAY ARRAY['a_fn(uuid)', 'b_fn(text)'] LOOP
          EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${grantee}', fn);
      END LOOP;`;
    expect([...grantedToApp(loop('athlya_app'))].sort()).toEqual(['a_fn', 'b_fn']);
    expect([...grantedToApp(loop('athlya_cron'))]).toEqual([]);
    expect([...grantedToApp("SELECT 'c_fn(uuid)';")]).toEqual([]);
    expect([...grantedToApp('GRANT EXECUTE ON FUNCTION d_fn(uuid) TO athlya_app;')]).toEqual([
      'd_fn',
    ]);
  });
});

/**
 * Functions granted EXECUTE to `athlya_app`, either by a direct
 * `GRANT EXECUTE ON FUNCTION fn(...) TO athlya_app;` or by a
 * `FOREACH fn IN ARRAY ARRAY[...] LOOP` whose body grants to athlya_app.
 */
function grantedToApp(sqlText: string): Set<string> {
  const names = new Set<string>();
  for (const m of sqlText.matchAll(
    /GRANT EXECUTE ON FUNCTION ([a-z_0-9]+)\([^)]*\) TO athlya_app;/gu,
  )) {
    names.add(m[1] ?? '');
  }
  const loops = sqlText.matchAll(
    /FOREACH \w+ IN ARRAY ARRAY\[([\s\S]*?)\]\s*LOOP([\s\S]*?)END LOOP;/gu,
  );
  for (const m of loops) {
    if (!/GRANT EXECUTE ON FUNCTION %s TO athlya_app'/u.test(m[2] ?? '')) continue;
    for (const fn of (m[1] ?? '').matchAll(/'([a-z_0-9]+)\(/gu)) names.add(fn[1] ?? '');
  }
  return names;
}

/*
 * RLS inventory (issues #224, #117). Every Drizzle query an adapter
 * issues on a db handle must be tenant-scoped (`withTenantHttp` /
 * `withTenant`), and every `queryRows` / `writeRows` / `callCount`
 * outside a tenant scope must call a SECURITY DEFINER function from the
 * migrations. Anything else is listed in RAW_QUERY_ALLOWLIST with the
 * reason it is safe, or the issue that tracks it. Entries are keyed
 * `file#enclosingTopLevelFunction`, so a new raw query elsewhere in an
 * allowlisted file still fails.
 */

const QUERY_METHODS = new Set([
  'select',
  'selectDistinct',
  'insert',
  'update',
  'delete',
  'execute',
  'batch',
  'transaction',
]);
/*
 * Db handles. Transaction handles (`tx`, `drizzleTx`, …) are not listed:
 * they only exist inside a transaction, and opening one (`.transaction(`
 * on any receiver) is itself reported unless it happens inside
 * `withTenant` — so a query on a transaction handle is scoped by
 * construction, wherever the handle was passed to.
 */
const DB_RECEIVER = /^(?:db|dbHttp|dbWrite|writeDb|client)$/u;
const TENANT_WRAPPERS = new Set(['withTenantHttp', 'withTenant']);
const SERVICE_CALLS = new Set(['queryRows', 'writeRows', 'callCount']);
const CONNECTION_FACTORIES = new Set([
  'createDb',
  'createDbHttp',
  'createNeonHttpSql',
  'postgres',
  'neon',
]);

const RAW_QUERY_ALLOWLIST: Readonly<Record<string, string>> = {
  'deps-cache.ts#createWriteDb': 'connection cache; its handles are checked at their query sites',
  'deps-cache.ts#getOrCreateDbHttp':
    'connection cache; its handles are checked at their query sites',
  'deps-cache.ts#getOrCreateDbHttpEu':
    'connection cache; its handles are checked at their query sites',
  'drain-db.ts#createDrainDb': 'outbox drainer connects as athlya_cron (CRON_DB_URL)',
  'cron-sql-executor.ts#buildCronSqlExecutor':
    'maintenance jobs connect as athlya_cron (CRON_DB_URL)',
  'billing-deps.ts#buildBillingDeps':
    'Stripe events are applied as athlya_billing (BILLING_DB_URL), migration 0036',
  'audit-log-store-drizzle.ts#createDrizzleAuditLogStore':
    'platform audit rows (JWT rotate, DLQ, billing webhook) have no tenant; audit_app_insert accepts claim-less inserts',
  'audit-log-wiring.ts#createBillingWebhookAuditAppender':
    'transaction around the claim-less audit_log append above',
};

/** SECURITY DEFINER functions declared by any forward migration. */
function securityDefinerFunctions(): Set<string> {
  const dir = resolve(here, '../../../../db/migrations');
  const names = new Set<string>();
  const forward = readdirSync(dir).filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'));
  for (const file of forward) {
    const text = readFileSync(resolve(dir, file), 'utf8');
    const headers = text.matchAll(
      /CREATE (?:OR REPLACE )?FUNCTION\s+(?:public\.)?([a-z_0-9]+)\s*\(([\s\S]*?)\$[a-z_]*\$/giu,
    );
    for (const m of headers) {
      if (/SECURITY DEFINER/iu.test(m[2] ?? '')) names.add((m[1] ?? '').toLowerCase());
    }
  }
  return names;
}

function enclosingTopLevel(node: ts.Node): string {
  let name = '<module>';
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) name = current.name.text;
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      name = current.name.text;
    }
  }
  return name;
}

function receiverName(expr: ts.Expression): string {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
    e = e.expression;
  }
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return '';
}

function isServiceFnCall(arg: ts.Expression | undefined): boolean {
  return (
    arg !== undefined &&
    ts.isCallExpression(arg) &&
    ts.isPropertyAccessExpression(arg.expression) &&
    ts.isIdentifier(arg.expression.expression) &&
    arg.expression.expression.text === 'serviceFn'
  );
}

function calledSqlFunctions(arg: ts.Expression | undefined, source: ts.SourceFile): string[] {
  if (arg === undefined || !ts.isTaggedTemplateExpression(arg)) return [];
  return [...arg.template.getText(source).matchAll(/\b([a-z_][a-z_0-9]*)\s*\(/gu)].map(
    (m) => m[1] ?? '',
  );
}

interface Finding {
  readonly key: string;
  readonly where: string;
}

/** Raw query sites under `adapters/**`, keyed by file and enclosing top-level function. */
function scanAdapters(definers: ReadonlySet<string>): Finding[] {
  const adaptersDir = resolve(apiSrc, 'adapters');
  return readdirSync(adaptersDir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .flatMap((f) =>
      scanSource(f.split(sep).join('/'), readFileSync(resolve(adaptersDir, f), 'utf8'), definers),
    );
}

/** Raw query sites of one adapter source file. */
function scanSource(file: string, text: string, definers: ReadonlySet<string>): Finding[] {
  const findings: Finding[] = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const report = (node: ts.Node, what: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    findings.push({
      key: `${file}#${enclosingTopLevel(node)}`,
      where: `${file}:${line} ${what}`,
    });
  };

  const visit = (node: ts.Node, scoped: boolean): void => {
    let inScope = scoped;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && TENANT_WRAPPERS.has(callee.text)) inScope = true;

      if (ts.isPropertyAccessExpression(callee) && QUERY_METHODS.has(callee.name.text)) {
        const recv = receiverName(callee.expression);
        const method = callee.name.text;
        // Every transaction opened in an adapter, on any receiver, must be
        // tenant-scoped or allowlisted: that is what makes the
        // transaction-handle exemption below sound.
        const opensTransaction = method === 'transaction';
        if (!inScope && (opensTransaction || DB_RECEIVER.test(recv))) {
          report(node, `${recv}.${method}()`);
        }
      }

      if (ts.isIdentifier(callee) && CONNECTION_FACTORIES.has(callee.text)) {
        report(node, `${callee.text}() opens a connection`);
      }

      if (
        ts.isIdentifier(callee) &&
        SERVICE_CALLS.has(callee.text) &&
        file !== 'service-functions.ts' &&
        !inScope
      ) {
        const arg = node.arguments[1];
        const viaDefiner = calledSqlFunctions(arg, source).some((fn) => definers.has(fn));
        if (!isServiceFnCall(arg) && !viaDefiner) {
          report(node, `${callee.text}() without a SECURITY DEFINER function`);
        }
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child, inScope);
    });
  };
  visit(source, false);
  return findings;
}

describe('RLS inventory — every adapter query is tenant-scoped or a service-function call', () => {
  const definers = securityDefinerFunctions();
  const findings = scanAdapters(definers);

  it.each([
    [
      'a query on a db handle outside a tenant scope',
      'export function f(db) { return db.select().from(t); }',
      ['x.ts:1 db.select()'],
    ],
    [
      'a transaction opened outside withTenant, whatever the receiver',
      'export function f(pool) { return pool.transaction(async (tx) => tx.select()); }',
      ['x.ts:1 pool.transaction()'],
    ],
    [
      'a claim-less queryRows without a SECURITY DEFINER function',
      'export function f(db) { return queryRows(db, sql`SELECT * FROM users`); }',
      ['x.ts:1 queryRows() without a SECURITY DEFINER function'],
    ],
    [
      'nothing for queries inside withTenant / withTenantHttp',
      `export function f(db, c) {
         withTenantHttp(db, c, db.select().from(t));
         return withTenant(db, c, async (tx) => tx.update(t).set({}));
       }`,
      [],
    ],
    [
      'nothing for a transaction handle passed to a helper',
      'function g(drizzleTx) { return drizzleTx.select().from(t); }',
      [],
    ],
    [
      'nothing for service-function calls',
      `export function f(db) {
         queryRows(db, serviceFn.findUserById('u'));
         return queryRows(db, sql\`SELECT studio_id_by_slug(\${'s'})\`);
       }`,
      [],
    ],
  ])('scanner reports %s', (_name, text, expected) => {
    const found = scanSource('x.ts', text, new Set(['studio_id_by_slug']));
    expect(found.map((f) => f.where)).toEqual(expected);
  });

  it('reads the SECURITY DEFINER functions from the migrations', () => {
    expect(definers).toContain('studio_id_by_slug');
    expect(definers).toContain('auth_find_user_by_id');
    expect(definers).not.toContain('app_studio_id');
  });

  it('has no raw query outside the allowlist', () => {
    const unexpected = findings.filter((f) => RAW_QUERY_ALLOWLIST[f.key] === undefined);
    expect(unexpected.map((f) => f.where)).toEqual([]);
  });

  it('has no stale allowlist entry', () => {
    const hit = new Set(findings.map((f) => f.key));
    expect(Object.keys(RAW_QUERY_ALLOWLIST).filter((key) => !hit.has(key))).toEqual([]);
  });

  it.each([
    'studio-slug-resolver.ts',
    'studios-deps.ts',
    'studios-repo-drizzle.ts',
    'auth-user-repo-drizzle.ts',
    'notifications-deps.ts',
    'password-reset-repo-drizzle.ts',
    'cascade-repo-drizzle.ts',
    'reservations-list-drizzle.ts',
    'classes-repo-drizzle.ts',
    'members-repo-drizzle.ts',
    'members-consents-repo-drizzle.ts',
    'members-audit-writer-drizzle.ts',
  ])('%s is not allowlisted', (file) => {
    const entries = Object.keys(RAW_QUERY_ALLOWLIST).filter((key) => key.startsWith(`${file}#`));
    expect(entries).toEqual([]);
  });
});

describe('RLS inventory — claim-less adapters never touch tenant tables directly', () => {
  const tenantTables = [
    'users',
    'studios',
    'pushTokens',
    'reservations',
    'workoutSessions',
    'idempotencyKeys',
  ];
  it.each([
    'adapters/auth-user-repo-drizzle.ts',
    'adapters/notifications-deps.ts',
    'adapters/cascade-repo-drizzle.ts',
    'adapters/password-reset-repo-drizzle.ts',
    'adapters/studio-slug-resolver.ts',
  ])('%s imports no tenant table from @athlya/db/schema', (file) => {
    const text = readFileSync(resolve(apiSrc, file), 'utf8');
    const imports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@athlya\/db\/schema'/gu)]
      .flatMap((m) => (m[1] ?? '').split(','))
      .map((s) => s.trim())
      .filter(Boolean);
    expect(imports.filter((name) => tenantTables.includes(name))).toEqual([]);
  });
});

describe('queryRows', () => {
  it('reads Neon HTTP `{ rows }` and postgres-js arrays alike', async () => {
    const neon = fakeDb(() => [{ n: 1 }], 'neon');
    const pg = fakeDb(() => [{ n: 1 }], 'pg');
    await expect(queryRows(neon.db, serviceFn.deleteReservations('u'))).resolves.toEqual([
      { n: 1 },
    ]);
    await expect(queryRows(pg.db, serviceFn.deleteReservations('u'))).resolves.toEqual([{ n: 1 }]);
  });

  it('retries a read once when the connection was dropped', async () => {
    let attempt = 0;
    const { db, calls } = fakeDb(() => {
      attempt += 1;
      return attempt === 1 ? Object.assign(new Error('dropped'), { code: 'ECONNRESET' }) : [];
    });
    await expect(queryRows(db, serviceFn.findUserById(userRow.id))).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });
});

describe('writeRows — non-idempotent writes are never replayed (issue #609)', () => {
  const dropped = () => Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });

  it('surfaces a dropped connection instead of retrying', async () => {
    const { db, calls } = fakeDb(dropped);
    await expect(writeRows(db, serviceFn.bumpCredentialsVersion(userRow.id))).rejects.toThrow(
      'connection terminated',
    );
    expect(calls).toHaveLength(1);
  });

  it.each([
    [
      'createUser',
      (db: AthlyaDbAny) =>
        createDrizzleUserRepo(db).createUser({
          studioId: userRow.studio_id,
          email: userRow.email,
          displayName: userRow.display_name,
          passwordHash: 'hash',
          role: 'member',
          consents: {} as never,
        }),
    ],
    [
      'createUserWithEvent',
      (db: AthlyaDbAny) =>
        createDrizzleUserRepo(db).createUserWithEvent!(
          {
            studioId: userRow.studio_id,
            email: userRow.email,
            displayName: userRow.display_name,
            passwordHash: 'hash',
            role: 'member',
            consents: {} as never,
          },
          (user) => ({ id: user.id }) as never,
        ),
    ],
    ['softDeleteUser', (db: AthlyaDbAny) => createDrizzleUserRepo(db).softDeleteUser(userRow.id)],
    [
      'bumpCredentialsVersion',
      (db: AthlyaDbAny) => createDrizzleUserRepo(db).bumpCredentialsVersion(userRow.id),
    ],
    [
      'consumeAndResetPassword',
      (db: AthlyaDbAny) =>
        createDrizzlePasswordResetRepo(db as AthlyaDbHttp).consumeAndResetPassword({
          tokenHash: 'h',
          userId: userRow.id,
          newPasswordHash: 'new',
        }),
    ],
  ])('%s runs once on a dropped connection', async (_name, run) => {
    const { db, calls } = fakeDb(dropped);
    await expect(run(db)).rejects.toThrow('connection terminated');
    expect(calls).toHaveLength(1);
  });
});

describe('createDrizzleUserRepo', () => {
  it('maps the snake_case function row to UserRow', async () => {
    const { db, calls } = fakeDb(() => [{ ...userRow, deleted_at: '2026-10-01T00:00:00.000Z' }]);
    const user = await createDrizzleUserRepo(db).findUserById(userRow.id);
    expect(calls[0]?.sql).toContain('auth_find_user_by_id(');
    expect(calls[0]?.params).toEqual([userRow.id]);
    expect(user).toEqual({
      id: userRow.id,
      studioId: userRow.studio_id,
      email: userRow.email,
      displayName: userRow.display_name,
      role: 'member',
      passwordHash: 'hash',
      deletedAt: new Date('2026-10-01T00:00:00.000Z'),
      credentialsVersion: 3,
    });
  });

  it('looks users up by email through the active-user function', async () => {
    const { db, calls } = fakeDb(() => []);
    await expect(createDrizzleUserRepo(db).findUserByEmail('x@athlya.test')).resolves.toBeNull();
    expect(calls[0]?.sql).toContain('auth_find_active_user_by_email(');
  });

  it('resolves studios by slug', async () => {
    const { db } = fakeDb(() => [{ id: 's1', slug: 'studio-a', name: 'Studio A' }]);
    await expect(createDrizzleUserRepo(db).findStudioBySlug('studio-a')).resolves.toEqual({
      id: 's1',
      slug: 'studio-a',
      name: 'Studio A',
    });
  });

  it('registers members and serialises consents as JSON', async () => {
    const consents = {
      marketing: false,
      analytics: false,
      thirdParty: false,
      version: '1',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const { db, calls } = fakeDb(() => [userRow]);
    await createDrizzleUserRepo(db).createUser({
      studioId: userRow.studio_id,
      email: userRow.email,
      displayName: userRow.display_name,
      passwordHash: 'hash',
      role: 'member',
      consents,
    });
    expect(calls[0]?.sql).toContain('auth_create_member(');
    expect(calls[0]?.params).toContain(JSON.stringify(consents));
  });

  it('maps a unique violation to EmailTakenError', async () => {
    const { db } = fakeDb(() => Object.assign(new Error('duplicate'), { code: '23505' }));
    await expect(
      createDrizzleUserRepo(db).createUser({
        studioId: userRow.studio_id,
        email: userRow.email,
        displayName: 'Dup',
        passwordHash: 'hash',
        role: 'member',
        consents: {} as never,
      }),
    ).rejects.toBeInstanceOf(EmailTakenError);
  });

  it('refuses to create a non-member account', async () => {
    const { db, calls } = fakeDb(() => [userRow]);
    await expect(
      createDrizzleUserRepo(db).createUser({
        studioId: userRow.studio_id,
        email: userRow.email,
        displayName: 'Admin',
        passwordHash: 'hash',
        role: 'admin',
        consents: {} as never,
      }),
    ).rejects.toThrow(/only member/u);
    expect(calls).toHaveLength(0);
  });

  it('soft-deletes and bumps credentials through their functions', async () => {
    const { db, calls } = fakeDb(() => []);
    const repo = createDrizzleUserRepo(db);
    await repo.softDeleteUser(userRow.id);
    await repo.bumpCredentialsVersion(userRow.id);
    expect(calls.map((c) => c.sql)).toEqual([
      expect.stringContaining('auth_soft_delete_user('),
      expect.stringContaining('auth_bump_credentials_version('),
    ]);
  });
});

describe('uuidV7', () => {
  it('is an RFC 9562 version-7 UUID carrying the timestamp', () => {
    const id = uuidV7(0x0193f0000000);
    expect(id).toMatch(/^0193f000-0000-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it('sorts by creation time', () => {
    expect(uuidV7(1_000) < uuidV7(2_000)).toBe(true);
  });
});

describe('createDrizzleUserRepo — durable auth events (issue #411)', () => {
  const input = {
    studioId: userRow.studio_id,
    email: userRow.email,
    displayName: userRow.display_name,
    passwordHash: 'hash',
    role: 'member' as const,
    consents: {} as never,
  };

  it('creates the member and its registered event in one call, with a matching user id', async () => {
    const { db, calls } = fakeDb((call) => [{ ...userRow, id: call.params[0] as string }]);
    const user = await createDrizzleUserRepo(db).createUserWithEvent!(input, (created) => {
      return {
        id: 'evt-1',
        type: 'auth.user.registered',
        occurredAt: '2026-10-12T00:00:00.000Z',
        studioId: created.studioId,
        payload: { userId: created.id },
      } as never;
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('auth_create_member_with_event(');
    const [userId, , , , , , eventJson] = calls[0]!.params as string[];
    expect(user.id).toBe(userId);
    expect(JSON.parse(eventJson!)).toMatchObject({ payload: { userId } });
  });

  it('maps a duplicate email to EmailTakenError', async () => {
    const { db } = fakeDb(() => Object.assign(new Error('duplicate'), { code: '23505' }));
    await expect(
      createDrizzleUserRepo(db).createUserWithEvent!(input, () => ({}) as never),
    ).rejects.toBeInstanceOf(EmailTakenError);
  });

  it('soft-deletes with its event in one call', async () => {
    const { db, calls } = fakeDb(() => []);
    const event = { id: 'evt-2', type: 'auth.user.deleted' };
    await createDrizzleUserRepo(db).softDeleteUserWithEvent!(userRow.id, event as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('auth_soft_delete_user_with_event(');
    expect(calls[0]?.params).toEqual([userRow.id, JSON.stringify(event)]);
  });
});

describe('buildRecipientRepo', () => {
  it('returns the recipient with its push tokens', async () => {
    const { db } = fakeDb(() => [
      { id: userRow.id, email: userRow.email, consents: { marketing: true }, push_tokens: ['t1'] },
    ]);
    await expect(buildRecipientRepo(db).getRecipient(userRow.id)).resolves.toEqual({
      userId: userRow.id,
      email: userRow.email,
      pushTokens: ['t1'],
      consents: { marketing: true },
      locale: 'fr',
    });
  });

  it('returns null for an unknown or deleted user', async () => {
    const { db } = fakeDb(() => []);
    await expect(buildRecipientRepo(db).getRecipient(userRow.id)).resolves.toBeNull();
  });
});

describe('createDrizzleDeletionRepo', () => {
  it('returns the row counts of the rgpd_delete_* functions', async () => {
    const counts: Record<string, number> = {
      rgpd_delete_reservations: 2,
      rgpd_delete_workout_sessions: 1,
      rgpd_delete_push_tokens: 3,
      rgpd_delete_idempotency_keys: 0,
    };
    const { db } = fakeDb((call) => {
      const fn = Object.keys(counts).find((name) => call.sql.includes(`${name}(`));
      return [{ n: fn === undefined ? 0 : counts[fn] }];
    });
    const repo = createDrizzleDeletionRepo(db);
    await expect(repo.deleteReservationsForUser(userRow.id)).resolves.toBe(2);
    await expect(repo.deleteWorkoutSessionsForUser(userRow.id)).resolves.toBe(1);
    await expect(repo.deletePushTokensForUser(userRow.id)).resolves.toBe(3);
    await expect(repo.deleteIdempotencyKeysForUser(userRow.id)).resolves.toBe(0);
  });

  it('confirms the tombstone through rgpd_confirm_user_deleted without re-stamping it', async () => {
    const { db, calls } = fakeDb(() => [{ deleted: true }]);
    await expect(
      createDrizzleDeletionRepo(db).markUserDeleted(
        userRow.id,
        new Date('2026-10-12T00:00:00.000Z'),
      ),
    ).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('rgpd_confirm_user_deleted(');
    // Only the user id: the cascade clock never reaches the tombstone.
    expect(calls[0]?.params).toEqual([userRow.id]);
  });

  it('reports a live or unknown account as not deleted (issue #609)', async () => {
    const live = fakeDb(() => [{ deleted: false }]);
    const unknown = fakeDb(() => []);
    await expect(
      createDrizzleDeletionRepo(live.db).markUserDeleted(userRow.id, new Date()),
    ).resolves.toBe(false);
    await expect(
      createDrizzleDeletionRepo(unknown.db).markUserDeleted(userRow.id, new Date()),
    ).resolves.toBe(false);
  });

  it('anonymises audit rows through rgpd_anonymize_user_audit (issue #117)', async () => {
    const { db, calls } = fakeDb(() => [{ n: '4' }]);
    await expect(createDrizzleDeletionRepo(db).anonymizeAuditRows(userRow.id)).resolves.toBe(4);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('rgpd_anonymize_user_audit(');
    expect(calls[0]?.sql).not.toMatch(/update\s+"?audit_log/iu);
    expect(calls[0]?.params).toEqual([userRow.id]);
  });
});

describe('createDrizzlePasswordResetRepo — service functions only (issue #117)', () => {
  const tokenHash = 'a'.repeat(64);

  it('issues a token through auth_issue_password_reset', async () => {
    const { db, calls } = fakeDb(() => [{ issued: true }]);
    const expiresAt = new Date('2026-10-17T12:00:00.000Z');
    await createDrizzlePasswordResetRepo(db).insertToken({
      userId: userRow.id,
      tokenHash,
      expiresAt,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('auth_issue_password_reset(');
    expect(calls[0]?.params).toEqual([userRow.id, tokenHash, expiresAt.toISOString()]);
  });

  it('throws when the account was deleted before issuance, so no email goes out', async () => {
    const { db } = fakeDb(() => [{ issued: false }]);
    await expect(
      createDrizzlePasswordResetRepo(db).insertToken({
        userId: userRow.id,
        tokenHash,
        expiresAt: new Date(),
      }),
    ).rejects.toThrow(/not issued/u);
  });

  it('does not retry an issuance on a dropped connection', async () => {
    const { db, calls } = fakeDb(() =>
      Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' }),
    );
    await expect(
      createDrizzlePasswordResetRepo(db).insertToken({
        userId: userRow.id,
        tokenHash,
        expiresAt: new Date(),
      }),
    ).rejects.toThrow('connection terminated');
    expect(calls).toHaveLength(1);
  });

  it('finds an active token through auth_find_password_reset', async () => {
    const { db, calls } = fakeDb(() => [
      { user_id: userRow.id, expires_at: '2026-10-17T12:00:00.000Z' },
    ]);
    await expect(
      createDrizzlePasswordResetRepo(db).findActiveTokenByHash(tokenHash),
    ).resolves.toEqual({ userId: userRow.id, expiresAt: new Date('2026-10-17T12:00:00.000Z') });
    expect(calls[0]?.sql).toContain('auth_find_password_reset(');
    expect(calls[0]?.params).toEqual([tokenHash]);
  });

  it('returns null when no active token matches', async () => {
    const { db } = fakeDb(() => []);
    await expect(
      createDrizzlePasswordResetRepo(db).findActiveTokenByHash(tokenHash),
    ).resolves.toBeNull();
  });
});

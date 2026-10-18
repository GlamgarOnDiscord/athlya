/**
 * Pure helpers for `migrate.mjs`, kept in their own module so the unit
 * tests import the exact logic the runner uses (issue #664).
 *
 * Why CONCURRENTLY migrations are split into statements
 * -------------------------------------------------------
 * postgres-js sends a parameterless `sql.unsafe(body)` as one
 * simple-protocol Query message. PostgreSQL executes a multi-statement
 * simple query as a single implicit transaction block, so
 * `CREATE/DROP INDEX CONCURRENTLY` fails with SQLSTATE 25001 whenever it
 * shares a message with any other statement, even outside `BEGIN`.
 * Sending each statement as its own query runs it at top level, which is
 * what `psql -f` (and therefore the pgTAP workflow) has always done.
 */

/**
 * True when the migration body must run outside a transaction.
 * Deliberately conservative: any occurrence of the keyword, comments
 * included, routes the file to the no-transaction path.
 *
 * @param {string} body
 * @returns {boolean}
 */
export function requiresNoTransaction(body) {
  return /\bCONCURRENTLY\b/i.test(body);
}

const DOLLAR_TAG_RE = /^\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/;

/**
 * Split a SQL script into top-level statements on `;`, ignoring
 * semicolons inside string literals, quoted identifiers, dollar-quoted
 * bodies and comments. Comments are dropped from the output (outside
 * literals) and statements that are empty once comments are removed are
 * skipped. Each returned statement is trimmed and has no trailing `;`.
 *
 * Not supported: SQL-standard `BEGIN ATOMIC ... END` function bodies,
 * whose inner semicolons are not quoted. The runner only splits
 * no-transaction (CONCURRENTLY) migrations, which never contain them.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function splitSqlStatements(body) {
  const statements = [];
  let current = '';
  let i = 0;
  const n = body.length;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed !== '') statements.push(trimmed);
    current = '';
  };

  while (i < n) {
    const ch = body[i];
    const next = body[i + 1];

    if (ch === '-' && next === '-') {
      const eol = body.indexOf('\n', i);
      i = eol === -1 ? n : eol;
      current += ' ';
      continue;
    }

    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (body[i] === '/' && body[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (body[i] === '*' && body[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      current += ' ';
      continue;
    }

    if (ch === "'" || ch === '"') {
      const prev = i > 0 ? body[i - 1] : '';
      const backslashEscapes = ch === "'" && (prev === 'E' || prev === 'e');
      let j = i + 1;
      while (j < n) {
        if (backslashEscapes && body[j] === '\\') {
          j += 2;
          continue;
        }
        if (body[j] === ch) {
          if (body[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      current += body.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (ch === '$') {
      const prev = i > 0 ? body[i - 1] : '';
      const match = /[\w$]/.test(prev) ? null : DOLLAR_TAG_RE.exec(body.slice(i));
      if (match !== null) {
        const tag = match[0];
        const close = body.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        current += body.slice(i, end);
        i = end;
        continue;
      }
    }

    if (ch === ';') {
      flush();
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  flush();
  return statements;
}

/**
 * Decide how the runner executes one migration file.
 *
 *   - transactional: the whole body in one query inside `sql.begin()`,
 *     together with the `_athlya_migrations` insert.
 *   - no-transaction: one query per statement, outside any transaction,
 *     so every CONCURRENTLY statement runs at top level.
 *
 * @param {string} body
 * @returns {{ transactional: boolean, queries: string[] }}
 */
export function planMigration(body) {
  if (requiresNoTransaction(body)) {
    return { transactional: false, queries: splitSqlStatements(body) };
  }
  return { transactional: true, queries: [body] };
}

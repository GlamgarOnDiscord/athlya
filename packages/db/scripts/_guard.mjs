/**
 * Shared safety guard for privileged database scripts (issue #509).
 *
 * Exports two functions:
 *
 *   guardConnectionString(url, { destructive })
 *     Inspects the DATABASE_URL host and refuses to run against a
 *     non-local host unless ATHLYA_ALLOW_DANGEROUS_WRITE=1 is set.
 *     When `destructive` is true (seed/truncate operations), it
 *     additionally requires ATHLYA_DESTRUCTIVE=1.
 *
 *   readPasswordFromStdin(prompt)
 *     Reads a password interactively from stdin or from the env var
 *     ATHLYA_SCRIPT_PASSWORD. Use instead of process.argv to keep
 *     plaintext out of shell history and process listings.
 *
 * "Production-shaped" means any host that is NOT:
 *   - localhost / 127.0.0.1 / ::1
 *   - a single-component name (e.g. "postgres" from docker-compose)
 *
 * Any dotted hostname not on the allowlist is treated as potentially
 * remote (staging/production). Override by setting
 * ATHLYA_ALLOW_DANGEROUS_WRITE=1 after explicit senior approval.
 */

import { createInterface } from 'node:readline';

/**
 * Returns true when the host looks like a local/CI-only address.
 *
 * @param {string} host
 * @returns {boolean}
 */
function isLocalHost(host) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  // Single-label names without dots (docker service names: "postgres", "db")
  if (!h.includes('.')) return true;
  return false;
}

/**
 * Inspect the connection string and abort if it targets a non-local host
 * without explicit opt-in environment variables.
 *
 * @param {string} connectionString  Full PostgreSQL connection URL.
 * @param {{ destructive?: boolean }} [opts]
 */
export function guardConnectionString(connectionString, opts = {}) {
  let host;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    console.error('[guard] Cannot parse DATABASE_URL as a URL — refusing to proceed.');
    process.exit(1);
  }

  if (isLocalHost(host)) {
    if (opts.destructive && process.env.ATHLYA_DESTRUCTIVE !== '1') {
      console.error(
        `[guard] Destructive operation on ${host} requires ATHLYA_DESTRUCTIVE=1.`,
      );
      process.exit(1);
    }
    if (opts.destructive) {
      console.warn(`[guard] Destructive mode enabled on local host: ${host}`);
    }
    return;
  }

  // Non-local host — require an explicit opt-in.
  if (process.env.ATHLYA_ALLOW_DANGEROUS_WRITE !== '1') {
    console.error(`[guard] Refusing to run privileged script against remote host: ${host}`);
    console.error('To proceed against a non-local host:');
    console.error('  1. Confirm this is intentional with a senior engineer.');
    console.error('  2. Export ATHLYA_ALLOW_DANGEROUS_WRITE=1 in the shell.');
    console.error('  3. Record action (actor, reason, timestamp) in the incident runbook.');
    process.exit(1);
  }

  if (opts.destructive && process.env.ATHLYA_DESTRUCTIVE !== '1') {
    console.error(
      `[guard] Destructive operation on remote host ${host} also requires ATHLYA_DESTRUCTIVE=1.`,
    );
    process.exit(1);
  }

  console.warn(`\n[guard] WARNING: running against remote host: ${host}`);
  if (opts.destructive) {
    console.warn('[guard] WARNING: destructive mode — data will be modified or deleted.');
  }
}

/**
 * Read a password from the env var ATHLYA_SCRIPT_PASSWORD or prompt
 * interactively via stdin.
 *
 * The interactive prompt does NOT hide input — the goal is to keep
 * plaintext out of process.argv and shell history, not to provide a
 * secure terminal session. For break-glass production use, supply the
 * variable from a secrets manager.
 *
 * @param {string} [prompt]
 * @returns {Promise<string>}
 */
export function readPasswordFromStdin(prompt = 'Password: ') {
  const fromEnv = process.env.ATHLYA_SCRIPT_PASSWORD;
  if (fromEnv !== undefined && fromEnv !== '') {
    return Promise.resolve(fromEnv);
  }
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      if (answer.trim() === '') {
        reject(new Error('Empty password — aborted'));
      } else {
        resolve(answer);
      }
    });
    // EOF (Ctrl-D) before answering.
    rl.once('close', () => reject(new Error('Password input cancelled')));
  });
}

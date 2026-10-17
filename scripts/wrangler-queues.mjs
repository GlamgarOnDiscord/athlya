/**
 * Queue names declared by a Wrangler config for one named environment
 * (issue #311). Used by `verify-secrets.mjs` to fail a deploy gate before
 * `wrangler deploy` does, when a queue (e.g. the outbox kick queue) was
 * never created.
 *
 * A deliberately small line scanner rather than a TOML parser: queue
 * bindings are always `[[env.<name>.queues.producers|consumers]]` tables
 * with `queue = "…"` / `dead_letter_queue = "…"` string keys.
 */

const TABLE_HEADER = /^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/;
const QUEUE_KEY = /^\s*(queue|dead_letter_queue)\s*=\s*"([^"]+)"/;

/**
 * @param {string} toml   Wrangler config text.
 * @param {string} env    Named environment (`staging`, `production`, …).
 * @returns {string[]}    Sorted, de-duplicated queue names.
 */
export function queuesForEnv(toml, env) {
  const producers = `env.${env}.queues.producers`;
  const consumers = `env.${env}.queues.consumers`;
  const names = new Set();
  let inQueueTable = false;
  for (const line of toml.split('\n')) {
    const header = TABLE_HEADER.exec(line);
    if (header !== null) {
      const table = header[1].trim();
      inQueueTable = table === producers || table === consumers;
      continue;
    }
    if (!inQueueTable) continue;
    const key = QUEUE_KEY.exec(line);
    if (key !== null) names.add(key[2]);
  }
  return [...names].sort();
}

/**
 * Queue names found in `wrangler queues list` output (table format).
 * Splits on whitespace and table borders; any token is a candidate, so
 * membership tests use exact names and never prefixes.
 *
 * @param {string} output
 * @returns {Set<string>}
 */
export function parseQueueList(output) {
  return new Set(output.split(/[\s│|┃┆]+/).filter((token) => /^[a-z0-9][a-z0-9-]*$/.test(token)));
}

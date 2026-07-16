#!/usr/bin/env node
/**
 * Verify that every label referenced in automation files exists in
 * the repository. Reads the live label list via `gh label list` and
 * compares it against:
 *   - .github/dependabot.yml  (labels: [...])
 *   - .github/ISSUE_TEMPLATE/ (labels: ...)
 *   - .github/workflows/*.yml (label: ..., labels: ...)
 *
 * Exit 1 if any referenced label is missing. Run as:
 *   node scripts/check-labels.mjs
 *
 * Requires `gh` CLI and an active gh session (or GITHUB_TOKEN).
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function globFiles(dir, ext) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

// ── Collect referenced labels ────────────────────────────────────────────────

const referenced = new Set();

/**
 * Extract labels from a `labels: foo, bar` front-matter line or from
 * YAML block sequences:
 *   labels:
 *     - foo
 *     - bar
 */
function extractLabels(content) {
  const lines = content.split('\n');
  let inLabels = false;
  let labelsIndent = -1;

  for (const line of lines) {
    // Match `labels:` with optional leading whitespace and optional trailing value.
    const inlineMatch = line.match(/^(\s*)labels:\s*(.*)$/);
    if (inlineMatch) {
      const indent = inlineMatch[1].length;
      const val = inlineMatch[2].trim();
      if (val === '' || val === '|' || val === '>') {
        inLabels = true;
        labelsIndent = indent;
      } else {
        // comma-separated inline list or single value
        val
          .replace(/^\[|\]$/g, '')
          .split(',')
          .forEach((l) => {
            const clean = l.trim().replace(/^["']|["']$/g, '');
            if (clean) referenced.add(clean);
          });
        inLabels = false;
        labelsIndent = -1;
      }
      continue;
    }

    if (inLabels) {
      const listItem = line.match(/^(\s*)-\s+(.+)$/);
      if (listItem && listItem[1].length > labelsIndent) {
        const clean = listItem[2].trim().replace(/^["']|["']$/g, '');
        if (clean) referenced.add(clean);
      } else if (line.trim() !== '') {
        inLabels = false;
        labelsIndent = -1;
      }
    }
  }
}

// dependabot.yml
extractLabels(readText(join(ROOT, '.github', 'dependabot.yml')));

// issue templates (.md and .yml)
for (const ext of ['.md', '.yml']) {
  for (const path of globFiles(join(ROOT, '.github', 'ISSUE_TEMPLATE'), ext)) {
    extractLabels(readText(path));
  }
}

// workflow files
for (const path of globFiles(join(ROOT, '.github', 'workflows'), '.yml')) {
  extractLabels(readText(path));
}

// ── Fetch live labels ────────────────────────────────────────────────────────

let liveLabels;
try {
  const raw = execFileSync('gh', ['label', 'list', '--limit', '200', '--json', 'name'], {
    encoding: 'utf8',
  });
  liveLabels = new Set(JSON.parse(raw).map((l) => l.name));
} catch (err) {
  console.error('check-labels: failed to fetch labels via gh CLI:', err.message);
  process.exit(1);
}

// ── Compare ──────────────────────────────────────────────────────────────────

const missing = [...referenced].filter((l) => !liveLabels.has(l));

if (missing.length > 0) {
  console.error('check-labels: the following labels are referenced but do not exist:');
  missing.forEach((l) => console.error(`  - ${JSON.stringify(l)}`));
  console.error(
    '\nCreate them with `gh label create` or update the automation to use existing labels.',
  );
  process.exit(1);
}

console.log(`check-labels: all ${referenced.size} referenced labels exist.`);

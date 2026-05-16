/**
 * `Accept-Language` negotiation helper — studio app copy.
 *
 * Bit-for-bit mirror of `apps/web/src/lib/i18n/negotiate.ts`. See the
 * detailed header in that file for the algorithm summary and the
 * rationale on duplicating instead of importing across apps.
 *
 * @see Requirement 28.2.
 */

interface ParsedEntry {
  readonly tag: string;
  readonly q: number;
  readonly order: number;
}

function parseAcceptLanguage(header: string): readonly ParsedEntry[] {
  const out: ParsedEntry[] = [];
  const entries = header.split(',');
  for (let i = 0; i < entries.length; i++) {
    const rawEntry = entries[i];
    if (rawEntry === undefined) continue;
    const entry = rawEntry.trim();
    if (entry === '') continue;
    const parts = entry.split(';');
    const firstPart = parts[0];
    if (firstPart === undefined) continue;
    const tag = firstPart.trim().toLowerCase();
    if (tag === '' || tag === '*') continue;
    let q = 1;
    for (let j = 1; j < parts.length; j++) {
      const rawParam = parts[j];
      if (rawParam === undefined) continue;
      const param = rawParam.trim();
      if (param.length < 2) continue;
      const keyChar = param.charAt(0);
      if ((keyChar !== 'q' && keyChar !== 'Q') || param.charAt(1) !== '=') {
        continue;
      }
      const qStr = param.slice(2).trim();
      const parsedQ = Number.parseFloat(qStr);
      if (Number.isFinite(parsedQ)) {
        q = Math.min(1, Math.max(0, parsedQ));
      }
    }
    out.push({ tag, q, order: i });
  }
  return out;
}

export function negotiateLocale<L extends string>(
  header: string | null | undefined,
  supported: readonly L[],
  fallback: L,
): L {
  if (header === null || header === undefined) return fallback;
  const trimmed = header.trim();
  if (trimmed === '' || trimmed === '*') return fallback;

  const parsed = parseAcceptLanguage(trimmed);
  if (parsed.length === 0) return fallback;

  const sorted = parsed.toSorted((a, b) => {
    if (a.q !== b.q) return b.q - a.q;
    return a.order - b.order;
  });

  const lowerToSupported = new Map(supported.map((s) => [s.toLowerCase(), s]));

  for (const { tag, q } of sorted) {
    if (q <= 0) continue;
    const exact = lowerToSupported.get(tag);
    if (exact !== undefined) return exact;
    const primary = tag.split('-')[0] ?? tag;
    if (primary !== tag) {
      const prefix = lowerToSupported.get(primary);
      if (prefix !== undefined) return prefix;
    }
  }

  return fallback;
}

/**
 * DNS over HTTPS resolver for custom domain checks (issue #761).
 *
 * Queries Cloudflare's public resolver (1.1.1.1) through its JSON API
 * (`application/dns-json`) from the Worker, so "check now" looks at the
 * public DNS the way any resolver would, with no cache of ours in
 * between. `cd=false` keeps DNSSEC validation on.
 *
 * Normalisation (the contract of {@link DnsLookup}):
 *   - CNAME: lower-cased target without the trailing dot;
 *   - MX: `"<priority> <host>"`, host lower-cased without trailing dot;
 *   - TXT: the record's character-strings joined (a long DKIM key comes
 *     back split in 255-byte chunks).
 * Only answers of the queried type are kept: a TXT lookup on a name
 * that is a CNAME also returns the CNAME hop.
 *
 * NXDOMAIN and NOERROR without answers both mean "no record" (`[]`);
 * any other status, an HTTP failure or a timeout throws
 * {@link DnsLookupError} so the route answers 502 instead of marking
 * the domain as failed on a resolver hiccup.
 */

import { fetchWithRetry } from './fetch-retry.js';

import type { DnsLookup, DnsRecordType } from '../white-label/dns-records.js';

export const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

const TYPE_CODES: Readonly<Record<DnsRecordType, number>> = { CNAME: 5, MX: 15, TXT: 16 };

const DNS_NOERROR = 0;
const DNS_NXDOMAIN = 3;

export class DnsLookupError extends Error {
  public override readonly name = 'DnsLookupError';
}

interface DohAnswer {
  readonly type?: unknown;
  readonly data?: unknown;
}

interface DohResponse {
  readonly Status?: unknown;
  readonly Answer?: unknown;
}

/** Join the quoted character-strings of a TXT answer (`"a" "b"` → `ab`). */
export function joinTxtData(data: string): string {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((m) => m[1] ?? '');
  return parts.length === 0 ? data : parts.map((p) => p.replace(/\\(.)/gu, '$1')).join('');
}

function normalise(type: DnsRecordType, data: string): string {
  if (type === 'TXT') return joinTxtData(data);
  if (type === 'MX') {
    const [priority = '', host = ''] = data.trim().split(/\s+/u);
    return `${priority} ${host.toLowerCase().replace(/\.$/u, '')}`;
  }
  return data.trim().toLowerCase().replace(/\.$/u, '');
}

export interface DohResolverOptions {
  readonly fetch?: typeof fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

export function createDohLookup(options: DohResolverOptions = {}): DnsLookup {
  const endpoint = options.endpoint ?? DOH_ENDPOINT;
  return async (name, type) => {
    const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type}&cd=false`;
    let response: Response;
    try {
      response = await fetchWithRetry(
        url,
        { headers: { accept: 'application/dns-json' } },
        {
          retries: 1,
          timeoutMs: options.timeoutMs ?? 3000,
          ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        },
      );
    } catch (err) {
      throw new DnsLookupError(`DNS lookup of ${type} ${name} failed`, { cause: err });
    }
    if (!response.ok) {
      throw new DnsLookupError(`DNS lookup of ${type} ${name} answered HTTP ${response.status}`);
    }
    const body = await response.json<DohResponse>();
    if (body.Status === DNS_NXDOMAIN) return [];
    if (body.Status !== DNS_NOERROR) {
      throw new DnsLookupError(
        `DNS lookup of ${type} ${name} answered status ${String(body.Status)}`,
      );
    }
    const answers = Array.isArray(body.Answer) ? (body.Answer as DohAnswer[]) : [];
    return answers
      .filter((a) => a.type === TYPE_CODES[type] && typeof a.data === 'string')
      .map((a) => normalise(type, a.data as string));
  };
}

/**
 * DNS records a studio publishes for its custom domains (issue #761),
 * and the evaluation of a lookup against them.
 *
 * Pure module: the lookup is injected (`DnsLookup`), production wires
 * the DNS over HTTPS resolver of `adapters/doh-resolver.ts`.
 *
 * Web domain (`kind = 'web'`), e.g. `club.example.com`:
 *   - CNAME `club.example.com` → {@link CUSTOM_DOMAIN_CNAME_TARGET}, the
 *     Cloudflare for SaaS fallback origin the operator provisions;
 *   - TXT `_athlya-challenge.club.example.com` = `athlya-verification=<token>`.
 *
 * E-mail sending domain (`kind = 'email'`), e.g. `example.com`, laid out
 * the way Resend expects (sending subdomain `send.`):
 *   - TXT `_athlya-challenge.example.com` (ownership, as above);
 *   - MX `send.example.com` → {@link RESEND_RETURN_PATH_MX} (bounces);
 *   - TXT `send.example.com` = SPF including {@link SPF_INCLUDE};
 *   - TXT `resend._domainkey.example.com` = the DKIM key Resend issues
 *     when the operator adds the domain (`dkim_record`, until then the
 *     record shows `awaiting_value`);
 *   - TXT `_dmarc.example.com` = a DMARC policy, recommended only.
 *
 * The domain is `verified` once every required record is `ok`. A DKIM
 * value still awaited keeps it `pending`; any other gap is `failed`.
 */

import type {
  DnsRecord,
  DnsRecordCheck,
  StudioDomain,
  StudioDomainKind,
} from '@athlya/shared/schemas/api';

/** Hostname the web domain CNAMEs to (Cloudflare for SaaS fallback origin). */
export const CUSTOM_DOMAIN_CNAME_TARGET = 'domains.athlya.app';

/** Resend return-path MX host (EU region, `docs/runbooks/white-label-domains.md`). */
export const RESEND_RETURN_PATH_MX = 'feedback-smtp.eu-west-1.amazonses.com';

/** SPF mechanism Resend requires on the sending subdomain. */
export const SPF_INCLUDE = 'include:amazonses.com';

/** Label of the ownership TXT record, under the registered hostname. */
export const OWNERSHIP_LABEL = '_athlya-challenge';

/** Sending subdomain Resend uses for SPF and the return path. */
export const SENDING_SUBDOMAIN = 'send';

/** DKIM selector Resend publishes the key under. */
export const DKIM_SELECTOR = 'resend._domainkey';

/** DMARC policy suggested to a studio that has none yet. */
export const SUGGESTED_DMARC = 'v=DMARC1; p=none;';

export type DnsRecordType = DnsRecord['type'];
export type DnsRecordPurpose = DnsRecord['purpose'];

/** A record as expected, before any lookup. */
export type ExpectedRecord = Omit<DnsRecord, 'check'>;

/** Thrown when a domain is checked again before the cooldown elapsed. */
export class StudioDomainCheckCooldownError extends Error {
  public override readonly name = 'StudioDomainCheckCooldownError';
  public constructor(public readonly retryAfterSeconds: number) {
    super('domain checked too recently');
  }
}

/** Result of one record lookup, as stored in `studio_domains.dns_checks`. */
export interface RecordCheck {
  readonly purpose: DnsRecordPurpose;
  readonly check: DnsRecordCheck;
}

/**
 * Resolve `name` for `type` and return the answers' data, normalised:
 * lower-cased host without trailing dot for CNAME, `"<priority> <host>"`
 * for MX, the joined character-strings for TXT. An empty array means no
 * record. Throws when the resolver itself fails.
 */
export type DnsLookup = (name: string, type: DnsRecordType) => Promise<readonly string[]>;

export function ownershipValue(token: string): string {
  return `athlya-verification=${token}`;
}

/** The records `hostname` needs for `kind`, in display order. */
export function expectedRecords(
  kind: StudioDomainKind,
  hostname: string,
  token: string,
  dkimRecord: string | null,
): readonly ExpectedRecord[] {
  const ownership: ExpectedRecord = {
    purpose: 'ownership',
    type: 'TXT',
    name: `${OWNERSHIP_LABEL}.${hostname}`,
    value: ownershipValue(token),
    priority: null,
    required: true,
  };
  if (kind === 'web') {
    return [
      {
        purpose: 'routing',
        type: 'CNAME',
        name: hostname,
        value: CUSTOM_DOMAIN_CNAME_TARGET,
        priority: null,
        required: true,
      },
      ownership,
    ];
  }
  const sending = `${SENDING_SUBDOMAIN}.${hostname}`;
  return [
    ownership,
    {
      purpose: 'return_path',
      type: 'MX',
      name: sending,
      value: RESEND_RETURN_PATH_MX,
      priority: 10,
      required: true,
    },
    {
      purpose: 'spf',
      type: 'TXT',
      name: sending,
      value: `v=spf1 ${SPF_INCLUDE} ~all`,
      priority: null,
      required: true,
    },
    {
      purpose: 'dkim',
      type: 'TXT',
      name: `${DKIM_SELECTOR}.${hostname}`,
      value: dkimRecord,
      priority: null,
      required: true,
    },
    {
      purpose: 'dmarc',
      type: 'TXT',
      name: `_dmarc.${hostname}`,
      value: SUGGESTED_DMARC,
      priority: null,
      required: false,
    },
  ];
}

function compact(value: string): string {
  return value.replace(/\s+/gu, '').toLowerCase();
}

function hostOf(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/u, '');
}

/** Compare the answers of one lookup with the expected record. */
export function evaluateRecord(record: ExpectedRecord, answers: readonly string[]): DnsRecordCheck {
  if (record.value === null) return 'awaiting_value';
  if (answers.length === 0) return 'missing';
  const expected = record.value;
  switch (record.purpose) {
    case 'routing':
      return answers.some((a) => hostOf(a) === expected) ? 'ok' : 'mismatch';
    case 'return_path':
      return answers.some((a) => hostOf(a.split(/\s+/u).at(-1) ?? '') === expected)
        ? 'ok'
        : 'mismatch';
    case 'spf': {
      const spf = answers.filter((a) => a.trim().toLowerCase().startsWith('v=spf1'));
      if (spf.length === 0) return 'missing';
      return spf.some((a) => a.toLowerCase().split(/\s+/u).includes(SPF_INCLUDE))
        ? 'ok'
        : 'mismatch';
    }
    case 'dmarc':
      return answers.some((a) => a.trim().toUpperCase().startsWith('V=DMARC1')) ? 'ok' : 'mismatch';
    case 'ownership':
      return answers.some((a) => a.trim() === expected) ? 'ok' : 'mismatch';
    case 'dkim':
      return answers.some((a) => compact(a) === compact(expected)) ? 'ok' : 'mismatch';
  }
}

/** Look every record up once and evaluate it. */
export async function checkRecords(
  records: readonly ExpectedRecord[],
  lookup: DnsLookup,
): Promise<readonly RecordCheck[]> {
  return Promise.all(
    records.map(async (record) => {
      if (record.value === null) {
        return { purpose: record.purpose, check: 'awaiting_value' as const };
      }
      const answers = await lookup(record.name, record.type);
      return { purpose: record.purpose, check: evaluateRecord(record, answers) };
    }),
  );
}

/** Domain verdict from the checks of its required records. */
export function domainVerdict(
  records: readonly ExpectedRecord[],
  checks: readonly RecordCheck[],
): 'verified' | 'pending' | 'failed' {
  const byPurpose = new Map(checks.map((c) => [c.purpose, c.check]));
  const required = records.filter((r) => r.required).map((r) => byPurpose.get(r.purpose));
  if (required.every((c) => c === 'ok')) return 'verified';
  if (required.every((c) => c === 'ok' || c === 'awaiting_value')) return 'pending';
  return 'failed';
}

/** Attach the stored checks to the expected records (`unchecked` when absent). */
export function withChecks(
  records: readonly ExpectedRecord[],
  checks: readonly RecordCheck[] | null,
): readonly DnsRecord[] {
  const byPurpose = new Map((checks ?? []).map((c) => [c.purpose, c.check]));
  return records.map((record) => ({
    ...record,
    check:
      record.value === null ? 'awaiting_value' : (byPurpose.get(record.purpose) ?? 'unchecked'),
  }));
}

/** Stored shape of a `studio_domains` row, as the view needs it. */
export interface StudioDomainRecordRow {
  readonly kind: StudioDomainKind;
  readonly hostname: string;
  readonly verificationToken: string;
  readonly status: 'pending' | 'verified' | 'failed';
  readonly dnsChecks: readonly { readonly purpose: string; readonly check: string }[] | null;
  readonly dkimRecord: string | null;
  readonly lastCheckedAt: Date | null;
  readonly verifiedAt: Date | null;
  readonly activatedAt: Date | null;
}

/** Wire view of a domain row, records rebuilt from the stored token and checks. */
export function toStudioDomainView(row: StudioDomainRecordRow): StudioDomain {
  const records = expectedRecords(row.kind, row.hostname, row.verificationToken, row.dkimRecord);
  return {
    kind: row.kind,
    hostname: row.hostname,
    status: row.status,
    records: [...withChecks(records, (row.dnsChecks ?? []) as readonly RecordCheck[])],
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
  };
}

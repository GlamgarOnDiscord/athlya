import { describe, expect, it, vi } from 'vitest';

import {
  CUSTOM_DOMAIN_CNAME_TARGET,
  RESEND_RETURN_PATH_MX,
  checkRecords,
  domainVerdict,
  evaluateRecord,
  expectedRecords,
  toStudioDomainView,
  type DnsLookup,
} from '../../white-label/dns-records.js';

const TOKEN = 'a'.repeat(32);

describe('expectedRecords', () => {
  it('asks a web domain for a CNAME and an ownership TXT', () => {
    expect(expectedRecords('web', 'club.example.com', TOKEN, null)).toEqual([
      {
        purpose: 'routing',
        type: 'CNAME',
        name: 'club.example.com',
        value: CUSTOM_DOMAIN_CNAME_TARGET,
        priority: null,
        required: true,
      },
      {
        purpose: 'ownership',
        type: 'TXT',
        name: '_athlya-challenge.club.example.com',
        value: `athlya-verification=${TOKEN}`,
        priority: null,
        required: true,
      },
    ]);
  });

  it('lays a sending domain out the way Resend expects', () => {
    const records = expectedRecords('email', 'example.com', TOKEN, 'p=MIGfKEY');
    expect(records.map((r) => [r.purpose, r.type, r.name, r.required])).toEqual([
      ['ownership', 'TXT', '_athlya-challenge.example.com', true],
      ['return_path', 'MX', 'send.example.com', true],
      ['spf', 'TXT', 'send.example.com', true],
      ['dkim', 'TXT', 'resend._domainkey.example.com', true],
      ['dmarc', 'TXT', '_dmarc.example.com', false],
    ]);
    expect(records.find((r) => r.purpose === 'return_path')).toMatchObject({
      value: RESEND_RETURN_PATH_MX,
      priority: 10,
    });
    expect(records.find((r) => r.purpose === 'dkim')?.value).toBe('p=MIGfKEY');
  });

  it('leaves the DKIM value empty until the operator enters it', () => {
    const dkim = expectedRecords('email', 'example.com', TOKEN, null).find(
      (r) => r.purpose === 'dkim',
    );
    expect(dkim?.value).toBeNull();
  });
});

describe('evaluateRecord', () => {
  const [routing, ownership] = expectedRecords('web', 'club.example.com', TOKEN, null);
  const email = expectedRecords('email', 'example.com', TOKEN, 'p=MIGf KEY');
  const by = (purpose: string) => email.find((r) => r.purpose === purpose)!;

  it('matches a CNAME whatever its case and trailing dot', () => {
    expect(evaluateRecord(routing!, ['Domains.Athlya.App.'])).toBe('ok');
    expect(evaluateRecord(routing!, ['elsewhere.example.net'])).toBe('mismatch');
    expect(evaluateRecord(routing!, [])).toBe('missing');
  });

  it('needs the exact ownership token among the TXT answers', () => {
    expect(
      evaluateRecord(ownership!, ['google-site-verification=x', `athlya-verification=${TOKEN}`]),
    ).toBe('ok');
    expect(evaluateRecord(ownership!, ['athlya-verification=other'])).toBe('mismatch');
  });

  it('reads the MX host after the priority', () => {
    expect(evaluateRecord(by('return_path'), [`10 ${RESEND_RETURN_PATH_MX}`])).toBe('ok');
    expect(evaluateRecord(by('return_path'), ['10 mx.other.net'])).toBe('mismatch');
  });

  it('wants the Resend include in the SPF record', () => {
    expect(evaluateRecord(by('spf'), ['v=spf1 include:amazonses.com ~all'])).toBe('ok');
    expect(evaluateRecord(by('spf'), ['v=spf1 include:_spf.google.com ~all'])).toBe('mismatch');
    expect(evaluateRecord(by('spf'), ['some-other-txt'])).toBe('missing');
  });

  it('compares DKIM keys without whitespace', () => {
    expect(evaluateRecord(by('dkim'), ['p=MIGfKEY'])).toBe('ok');
    expect(evaluateRecord(by('dkim'), ['p=OTHER'])).toBe('mismatch');
  });

  it('accepts any DMARC policy', () => {
    expect(evaluateRecord(by('dmarc'), ['v=DMARC1; p=quarantine; rua=mailto:x@example.com'])).toBe(
      'ok',
    );
  });
});

describe('checkRecords and domainVerdict', () => {
  it('verifies a domain whose required records are all found', async () => {
    const records = expectedRecords('web', 'club.example.com', TOKEN, null);
    const lookup: DnsLookup = vi.fn(async (_name, type) =>
      type === 'CNAME' ? [CUSTOM_DOMAIN_CNAME_TARGET] : [`athlya-verification=${TOKEN}`],
    );
    const checks = await checkRecords(records, lookup);
    expect(checks).toEqual([
      { purpose: 'routing', check: 'ok' },
      { purpose: 'ownership', check: 'ok' },
    ]);
    expect(domainVerdict(records, checks)).toBe('verified');
  });

  it('keeps a sending domain pending while the DKIM value is awaited', async () => {
    const records = expectedRecords('email', 'example.com', TOKEN, null);
    const lookup: DnsLookup = vi.fn(async (name, type) => {
      if (type === 'MX') return [`10 ${RESEND_RETURN_PATH_MX}`];
      if (name.startsWith('send.')) return ['v=spf1 include:amazonses.com ~all'];
      if (name.startsWith('_dmarc.')) return [];
      return [`athlya-verification=${TOKEN}`];
    });
    const checks = await checkRecords(records, lookup);
    expect(lookup).toHaveBeenCalledTimes(4);
    expect(checks.find((c) => c.purpose === 'dkim')?.check).toBe('awaiting_value');
    expect(domainVerdict(records, checks)).toBe('pending');
  });

  it('fails a domain with a missing required record, ignoring DMARC', () => {
    const records = expectedRecords('web', 'club.example.com', TOKEN, null);
    expect(
      domainVerdict(records, [
        { purpose: 'routing', check: 'missing' },
        { purpose: 'ownership', check: 'ok' },
      ]),
    ).toBe('failed');
  });
});

describe('toStudioDomainView', () => {
  it('rebuilds the records with the stored checks', () => {
    const view = toStudioDomainView({
      kind: 'web',
      hostname: 'club.example.com',
      verificationToken: TOKEN,
      status: 'failed',
      dnsChecks: [{ purpose: 'routing', check: 'missing' }],
      dkimRecord: null,
      lastCheckedAt: new Date('2026-10-21T10:00:00.000Z'),
      verifiedAt: null,
      activatedAt: null,
    });
    expect(view.records.map((r) => r.check)).toEqual(['missing', 'unchecked']);
    expect(view.lastCheckedAt).toBe('2026-10-21T10:00:00.000Z');
    expect(view.status).toBe('failed');
  });
});

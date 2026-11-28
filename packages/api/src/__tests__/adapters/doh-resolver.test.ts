import { describe, expect, it, vi } from 'vitest';

import {
  createDohLookup,
  DnsLookupError,
  DOH_ENDPOINT,
  joinTxtData,
} from '../../adapters/doh-resolver.js';

function answer(status: number, answers: { type: number; data: string }[] = []) {
  return new Response(JSON.stringify({ Status: status, Answer: answers }), {
    status: 200,
    headers: { 'content-type': 'application/dns-json' },
  });
}

describe('createDohLookup', () => {
  it('queries the Cloudflare resolver with the JSON API', async () => {
    const fetchMock = vi.fn(async () => answer(0, [{ type: 5, data: 'Domains.Athlya.App.' }]));
    const lookup = createDohLookup({ fetch: fetchMock as unknown as typeof fetch });

    await expect(lookup('club.example.com', 'CNAME')).resolves.toEqual(['domains.athlya.app']);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DOH_ENDPOINT}?name=club.example.com&type=CNAME&cd=false`);
    expect(new Headers(init.headers).get('accept')).toBe('application/dns-json');
  });

  it('keeps only answers of the queried type and joins TXT strings', async () => {
    const fetchMock = vi.fn(async () =>
      answer(0, [
        { type: 5, data: 'alias.example.net.' },
        { type: 16, data: '"p=MIGf" "KEY"' },
      ]),
    );
    const lookup = createDohLookup({ fetch: fetchMock as unknown as typeof fetch });
    await expect(lookup('resend._domainkey.example.com', 'TXT')).resolves.toEqual(['p=MIGfKEY']);
  });

  it('normalises MX answers to priority and host', async () => {
    const fetchMock = vi.fn(async () =>
      answer(0, [{ type: 15, data: '10 Feedback-SMTP.eu-west-1.amazonses.com.' }]),
    );
    const lookup = createDohLookup({ fetch: fetchMock as unknown as typeof fetch });
    await expect(lookup('send.example.com', 'MX')).resolves.toEqual([
      '10 feedback-smtp.eu-west-1.amazonses.com',
    ]);
  });

  it('reads NXDOMAIN as no record', async () => {
    const lookup = createDohLookup({
      fetch: vi.fn(async () => answer(3)) as unknown as typeof fetch,
    });
    await expect(lookup('nope.example.com', 'TXT')).resolves.toEqual([]);
  });

  it('throws on a resolver failure instead of reporting a missing record', async () => {
    const servfail = createDohLookup({
      fetch: vi.fn(async () => answer(2)) as unknown as typeof fetch,
    });
    await expect(servfail('example.com', 'TXT')).rejects.toBeInstanceOf(DnsLookupError);

    const http = createDohLookup({
      fetch: vi.fn(async () => new Response('nope', { status: 400 })) as unknown as typeof fetch,
    });
    await expect(http('example.com', 'TXT')).rejects.toBeInstanceOf(DnsLookupError);
  });
});

describe('joinTxtData', () => {
  it('unescapes quoted strings and leaves bare data alone', () => {
    expect(joinTxtData('"v=spf1 include:amazonses.com ~all"')).toBe(
      'v=spf1 include:amazonses.com ~all',
    );
    expect(joinTxtData('"a\\"b"')).toBe('a"b');
    expect(joinTxtData('plain')).toBe('plain');
  });
});

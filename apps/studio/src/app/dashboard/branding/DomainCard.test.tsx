import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../lib/api/client';
import { createTranslator } from '../../../lib/i18n/t';

import { DomainCard, domainErrorKey } from './DomainCard';

import type { ApiClient } from '../../../lib/api/client';
import type { StudioDomain } from '@athlya/shared/schemas/api';

const t = createTranslator('fr');

const DOMAIN: StudioDomain = {
  kind: 'email',
  hostname: 'rive-gauche.example',
  status: 'verified',
  records: [
    {
      purpose: 'dkim',
      type: 'TXT',
      name: 'resend._domainkey.rive-gauche.example',
      value: null,
      priority: null,
      required: true,
      check: 'awaiting_value',
    },
    {
      purpose: 'return_path',
      type: 'MX',
      name: 'send.rive-gauche.example',
      value: 'feedback-smtp.eu-west-1.amazonses.com',
      priority: 10,
      required: true,
      check: 'ok',
    },
  ],
  lastCheckedAt: '2026-10-21T10:00:00.000Z',
  verifiedAt: '2026-10-21T10:00:00.000Z',
  activatedAt: null,
};

const client = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() };

describe('DomainCard', () => {
  it('lists the records with their check and says activation is pending', () => {
    render(
      <DomainCard
        kind="email"
        domain={DOMAIN}
        client={client as unknown as ApiClient}
        t={t}
        locale="fr"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('rive-gauche.example')).toBeTruthy();
    expect(screen.getByText(t('studio.branding.domains.records.awaitingValue'))).toBeTruthy();
    expect(screen.getByText('feedback-smtp.eu-west-1.amazonses.com')).toBeTruthy();
    expect(screen.getByText(t('studio.branding.domains.email.awaitingActivation'))).toBeTruthy();
    expect(screen.getByText(t('studio.branding.domains.status.verified'))).toBeTruthy();
  });

  it('offers the hostname form when no domain is registered', () => {
    render(
      <DomainCard
        kind="web"
        domain={null}
        client={client as unknown as ApiClient}
        t={t}
        locale="fr"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(t('studio.branding.domains.hostname'))).toBeTruthy();
  });
});

describe('domainErrorKey', () => {
  it('maps the API failures to their message', () => {
    expect(
      domainErrorKey(
        new ApiError('x', 409, { title: 'Conflict', status: 409, code: 'domain_taken' } as never),
      ),
    ).toBe('studio.branding.domains.errors.taken');
    expect(domainErrorKey({ status: 429 })).toBe('studio.branding.domains.errors.cooldown');
    expect(domainErrorKey(new ApiError('x', 422))).toBe('studio.branding.domains.errors.invalid');
    expect(domainErrorKey(new Error('boom'))).toBe('studio.branding.domains.errors.generic');
  });
});

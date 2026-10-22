import { WEBHOOK_EVENT_TYPES } from '@athlya/shared/schemas/api';
import { describe, expect, it } from 'vitest';

import { createTranslator } from '../../../lib/i18n/t';

import { eventKey } from './IntegrationsPanel';

describe('eventKey', () => {
  it('names every subscribable event in both locales', () => {
    for (const locale of ['fr', 'en'] as const) {
      const t = createTranslator(locale);
      for (const event of WEBHOOK_EVENT_TYPES) {
        const key = eventKey(event);
        expect(t(key)).not.toBe(key);
      }
    }
  });

  it('falls back for an unknown type', () => {
    expect(eventKey('billing.subscription.started')).toBe('studio.integrations.events.other');
  });
});

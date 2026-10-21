import { describe, expect, it } from 'vitest';

import { changedFields } from './StudioSettingsForm';
import { timeZoneOptions } from './time-zones';

const SAVED = {
  name: 'Studio Rive Gauche',
  timezone: 'Europe/Paris',
  addressLine: '12 rue de Seine',
  postalCode: '75006',
  city: 'Paris',
  country: 'FR',
  contactEmail: '',
};

describe('changedFields', () => {
  it('sends only what changed, a cleared field as an empty string', () => {
    expect(changedFields(SAVED, { ...SAVED, city: 'Lyon', addressLine: '' })).toEqual({
      city: 'Lyon',
      addressLine: '',
    });
    expect(changedFields(SAVED, { ...SAVED, name: ' Studio Rive Gauche ' })).toEqual({});
  });
});

describe('timeZoneOptions', () => {
  it('lists IANA zones sorted and keeps the current one', () => {
    const zones = timeZoneOptions('Europe/Paris');
    expect(zones).toContain('Europe/Paris');
    expect([...zones].sort((a, b) => a.localeCompare(b))).toEqual(zones);
    expect(timeZoneOptions('Etc/GMT-14')).toContain('Etc/GMT-14');
  });
});

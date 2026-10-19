import { createTranslator } from '@athlya/shared/i18n';
import { describe, expect, it } from 'vitest';

import {
  activityNameKey,
  buildHealthSessionRequest,
  describeHealthWorkout,
  importIdempotencyKey,
} from '../../features/health/workout-mapping';
import { AppleHealthLinkStore } from '../../infrastructure/health/link-store';
import { isUuidV4 } from '../../infrastructure/ids';
import { createMemoryKeyValueStore } from '../../infrastructure/storage/key-value-store';
import { sha256, workout } from '../health-helpers';

const en = createTranslator('en');
const fr = createTranslator('fr');

describe('buildHealthSessionRequest', () => {
  it('maps a run to one timed exercise with its totals and source', () => {
    expect(buildHealthSessionRequest(workout(), en, 'en')).toEqual({
      startedAt: '2026-10-18T07:00:00.000Z',
      durationMin: 45,
      exercises: [{ name: 'Running', sets: [{ reps: 0, durationSec: 2700 }] }],
      notes:
        'Imported from Apple Health · Distance 8.2 km · Energy 612 kcal · ' +
        'Avg heart rate 152 bpm · Max heart rate 178 bpm',
      source: { provider: 'appleHealth', externalId: '5B2D7C1E-3F4A-4B6C-8D9E-0F1A2B3C4D5E' },
    });
  });

  it('localises the activity and the numbers', () => {
    const request = buildHealthSessionRequest(workout(), fr, 'fr');
    expect(request?.exercises[0]?.name).toBe('Course à pied');
    expect(request?.notes).toContain('Distance 8,2 km');
  });

  it('converts other units', () => {
    const request = buildHealthSessionRequest(
      workout({
        duration: { unit: 'min', quantity: 30 },
        totalDistance: { unit: 'mi', quantity: 2 },
        totalEnergyBurned: { unit: 'kJ', quantity: 418.4 },
      }),
      en,
      'en',
    );
    expect(request?.exercises[0]?.sets[0]?.durationSec).toBe(1800);
    expect(request?.notes).toContain('Distance 3.2 km');
    expect(request?.notes).toContain('Energy 100 kcal');
  });

  it('falls back to the dates for a duration in an unknown unit', () => {
    const request = buildHealthSessionRequest(
      workout({ duration: { unit: 'fortnight', quantity: 1 } }),
      en,
      'en',
    );
    expect(request?.exercises[0]?.sets[0]?.durationSec).toBe(2700);
  });

  it('drops metrics that are missing, zero, in an unknown unit or implausible', () => {
    const request = buildHealthSessionRequest(
      workout({
        totalDistance: { unit: 'm', quantity: 0 },
        totalEnergyBurned: { unit: 'parsec', quantity: 3 },
        averageHeartRateBpm: Number.NaN,
        maxHeartRateBpm: 900,
      }),
      en,
      'en',
    );
    expect(request?.notes).toBe('Imported from Apple Health');
  });

  it('caps the duration at one day and rounds a short workout up to one minute', () => {
    const long = workout({ duration: { unit: 'hr', quantity: 30 } });
    expect(buildHealthSessionRequest(long, en, 'en')?.exercises[0]?.sets[0]?.durationSec).toBe(
      86_400,
    );
    const short = workout({ duration: { unit: 's', quantity: 20 } });
    expect(buildHealthSessionRequest(short, en, 'en')?.durationMin).toBe(1);
  });

  it('refuses a workout without a duration or with an invalid date', () => {
    const empty = workout({
      duration: { unit: 's', quantity: 0 },
      endDate: new Date('2026-10-18T07:00:00.000Z'),
    });
    expect(buildHealthSessionRequest(empty, en, 'en')).toBeNull();
    expect(
      buildHealthSessionRequest(workout({ startDate: new Date(Number.NaN) }), en, 'en'),
    ).toBeNull();
    expect(buildHealthSessionRequest(workout({ uuid: ' ' }), en, 'en')).toBeNull();
  });

  it('names unknown activity types "Workout"', () => {
    expect(activityNameKey(3000)).toBe('mobile.health.activities.other');
    expect(activityNameKey(-1)).toBe('mobile.health.activities.other');
    expect(en(activityNameKey(50))).toBe('Strength training');
  });

  it('describes the totals in the notes line', () => {
    expect(
      describeHealthWorkout(workout({ totalDistance: { unit: 'm', quantity: 30 } }), en, 'en'),
    ).not.toContain('Distance');
  });
});

describe('importIdempotencyKey', () => {
  it('is a UUID v4, the same for the same workout and different across workouts', async () => {
    const a = await importIdempotencyKey(sha256, 'appleHealth', 'HK-1');
    expect(isUuidV4(a)).toBe(true);
    expect(await importIdempotencyKey(sha256, 'appleHealth', 'HK-1')).toBe(a);
    expect(await importIdempotencyKey(sha256, 'appleHealth', 'HK-2')).not.toBe(a);
  });

  it('refuses a digest that is not hex', async () => {
    await expect(
      importIdempotencyKey(() => Promise.resolve('not-a-digest'), 'appleHealth', 'HK-1'),
    ).rejects.toThrow('hex digest');
  });
});

describe('AppleHealthLinkStore', () => {
  it('keeps one link per user with its anchor, until disconnected', () => {
    const backing = new Map<string, string>();
    const links = new AppleHealthLinkStore(createMemoryKeyValueStore(backing));
    expect(links.get('u1')).toBeNull();

    expect(links.connect('u1', 1000)).toEqual({ sinceMs: 1000, anchor: null });
    links.saveAnchor('u1', 'anchor-1');
    expect(links.connect('u1', 5000)).toEqual({ sinceMs: 1000, anchor: 'anchor-1' });
    expect(links.get('u2')).toBeNull();

    // Survives a restart over the same encrypted file.
    expect(new AppleHealthLinkStore(createMemoryKeyValueStore(backing)).get('u1')).toEqual({
      sinceMs: 1000,
      anchor: 'anchor-1',
    });

    links.disconnect('u1');
    expect(links.get('u1')).toBeNull();
    links.saveAnchor('u1', 'anchor-2');
    expect(links.get('u1')).toBeNull();
  });

  it('treats an unreadable entry as not connected', () => {
    const backing = new Map([
      ['appleHealth.link.u1', '{not json'],
      ['appleHealth.link.u2', JSON.stringify({ sinceMs: -1, anchor: null })],
    ]);
    const links = new AppleHealthLinkStore(createMemoryKeyValueStore(backing));
    expect(links.get('u1')).toBeNull();
    expect(links.get('u2')).toBeNull();
  });
});

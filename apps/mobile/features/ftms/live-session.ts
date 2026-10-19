/**
 * Live machine session — task 23.1.
 *
 * Folds partial FTMS samples into the state the screen shows and the
 * summary that becomes a workout session. Averages are time-weighted:
 * each value counts for the time until the next notification, and a gap
 * longer than {@link MAX_GAP_MS} (machine paused, radio dropout) is not
 * integrated. Machine totals (elapsed time, distance, energy) win over
 * what the phone can derive, since the member may have started on the
 * console before connecting.
 *
 * Heart rate has two sources: the machine (grip sensors) and a paired
 * strap (issue #669). The strap wins while it reports; the machine's
 * value is used again once the strap releases it (lost contact,
 * disconnect) or has been silent for longer than {@link MAX_GAP_MS}.
 * Each heart-rate value is integrated on its own source's timeline.
 */
import type { FtmsSample, MachineType } from './protocol';

/** Gaps longer than this between two notifications are not integrated. */
export const MAX_GAP_MS = 5_000;

export type HeartRateSource = 'machine' | 'strap';

export interface LiveSession {
  readonly machine: MachineType;
  readonly startedAtMs: number;
  readonly lastSampleAtMs: number | null;
  /** When the session ended (finish or lost link); null while it runs. */
  readonly endedAtMs: number | null;
  /** Last known value of every metric. */
  readonly latest: FtmsSample;
  readonly samples: number;
  /** Where `latest.heartRateBpm` comes from. */
  readonly heartRateSource: HeartRateSource;
  /** Last strap reading, while the strap is the source. */
  readonly strapAtMs: number | null;
  /** Time covered by integrated intervals, in ms. */
  readonly integratedMs: number;
  /** Distance integrated from speed, in metres (used when the machine sends none). */
  readonly integratedDistanceM: number;
  readonly powerMs: number;
  readonly powerWattMs: number;
  readonly maxPowerW: number | null;
  readonly heartRateMs: number;
  readonly heartRateBpmMs: number;
  readonly maxHeartRateBpm: number | null;
  readonly cadenceMs: number;
  readonly cadenceRpmMs: number;
}

export function createLiveSession(machine: MachineType, startedAtMs: number): LiveSession {
  return {
    machine,
    startedAtMs,
    lastSampleAtMs: null,
    endedAtMs: null,
    latest: {},
    samples: 0,
    heartRateSource: 'machine',
    strapAtMs: null,
    integratedMs: 0,
    integratedDistanceM: 0,
    powerMs: 0,
    powerWattMs: 0,
    maxPowerW: null,
    heartRateMs: 0,
    heartRateBpmMs: 0,
    maxHeartRateBpm: null,
    cadenceMs: 0,
    cadenceRpmMs: 0,
  };
}

function maxOf(current: number | null, value: number | undefined): number | null {
  if (value === undefined) return current;
  return current === null ? value : Math.max(current, value);
}

function integrable(fromMs: number | null, toMs: number): number {
  const gap = fromMs === null ? 0 : toMs - fromMs;
  return gap > 0 && gap <= MAX_GAP_MS ? gap : 0;
}

function withoutHeartRate(sample: FtmsSample): FtmsSample {
  const { heartRateBpm: _heartRateBpm, ...rest } = sample;
  return rest;
}

/** Folds the current heart rate's time up to `atMs` into the averages. */
function integrateHeartRate(session: LiveSession, atMs: number): LiveSession {
  const bpm = session.latest.heartRateBpm;
  if (bpm === undefined) return session;
  const since = session.heartRateSource === 'strap' ? session.strapAtMs : session.lastSampleAtMs;
  const dt = integrable(since, atMs);
  return {
    ...session,
    heartRateMs: session.heartRateMs + dt,
    heartRateBpmMs: session.heartRateBpmMs + bpm * dt,
  };
}

/** Adds one strap heart-rate reading received at `atMs`; the strap becomes the source. */
export function addHeartRate(session: LiveSession, bpm: number, atMs: number): LiveSession {
  const integrated = integrateHeartRate(session, atMs);
  return {
    ...integrated,
    heartRateSource: 'strap',
    strapAtMs: Math.max(atMs, session.strapAtMs ?? atMs),
    latest: { ...session.latest, heartRateBpm: bpm },
    samples: session.samples + 1,
    maxHeartRateBpm: maxOf(session.maxHeartRateBpm, bpm),
  };
}

/** The strap stopped reporting at `atMs`: the machine's heart rate is used again. */
export function releaseHeartRate(session: LiveSession, atMs: number): LiveSession {
  if (session.heartRateSource !== 'strap') return session;
  const integrated = integrateHeartRate(session, atMs);
  return {
    ...integrated,
    heartRateSource: 'machine',
    strapAtMs: null,
    latest: withoutHeartRate(session.latest),
  };
}

/** Adds one decoded machine notification received at `atMs`. */
export function addSample(current: LiveSession, received: FtmsSample, atMs: number): LiveSession {
  const stale =
    current.heartRateSource === 'strap' &&
    (current.strapAtMs === null || atMs - current.strapAtMs > MAX_GAP_MS);
  const session = stale ? releaseHeartRate(current, atMs) : current;
  const fromMachine = session.heartRateSource === 'machine';
  const sample = fromMachine ? received : withoutHeartRate(received);
  const previous = session.latest;
  const dt = integrable(session.lastSampleAtMs, atMs);

  const power = previous.powerW;
  const heartRate = fromMachine ? previous.heartRateBpm : undefined;
  const cadence = previous.cadenceRpm;
  const speed = previous.speedKmh;

  const latest: FtmsSample = { ...previous, ...sample };
  return {
    ...session,
    lastSampleAtMs: Math.max(atMs, session.lastSampleAtMs ?? atMs),
    latest,
    samples: session.samples + 1,
    integratedMs: session.integratedMs + dt,
    integratedDistanceM:
      session.integratedDistanceM + (speed === undefined ? 0 : (speed / 3.6) * (dt / 1_000)),
    powerMs: session.powerMs + (power === undefined ? 0 : dt),
    powerWattMs: session.powerWattMs + (power === undefined ? 0 : Math.max(0, power) * dt),
    maxPowerW: maxOf(session.maxPowerW, sample.powerW),
    heartRateMs: session.heartRateMs + (heartRate === undefined ? 0 : dt),
    heartRateBpmMs: session.heartRateBpmMs + (heartRate === undefined ? 0 : heartRate * dt),
    maxHeartRateBpm: maxOf(session.maxHeartRateBpm, sample.heartRateBpm),
    cadenceMs: session.cadenceMs + (cadence === undefined ? 0 : dt),
    cadenceRpmMs: session.cadenceRpmMs + (cadence === undefined ? 0 : cadence * dt),
  };
}

export interface SessionSummary {
  readonly machine: MachineType;
  /** Start of the workout: the connection time, or earlier when the console timer says so. */
  readonly startedAtMs: number;
  readonly elapsedSec: number;
  readonly distanceM: number | null;
  readonly energyKcal: number | null;
  readonly avgPowerW: number | null;
  readonly maxPowerW: number | null;
  readonly avgHeartRateBpm: number | null;
  readonly maxHeartRateBpm: number | null;
  readonly avgCadenceRpm: number | null;
  readonly strokeCount: number | null;
}

function average(weighted: number, ms: number): number | null {
  return ms > 0 ? Math.round(weighted / ms) : null;
}

/** Marks the session as ended at `atMs` (finish or lost link); later calls keep the first time. */
export function endSession(session: LiveSession, atMs: number): LiveSession {
  return session.endedAtMs === null ? { ...session, endedAtMs: atMs } : session;
}

/** Summary at `nowMs`; the session may still be running. */
export function summarise(session: LiveSession, nowMs: number): SessionSummary {
  // The wall clock keeps running between notifications until the session ends.
  const endMs = session.endedAtMs ?? nowMs;
  const wallSec = Math.max(0, Math.floor((endMs - session.startedAtMs) / 1_000));
  // The console timer excludes pauses and includes time before the phone
  // connected, so it wins whenever the machine reports one; it is anchored
  // at the notification that carried it.
  const machineElapsed = session.latest.elapsedSec;
  const elapsedSec = machineElapsed ?? wallSec;
  const anchorMs = machineElapsed === undefined ? endMs : (session.lastSampleAtMs ?? endMs);
  const distance = session.latest.distanceM ?? null;
  return {
    machine: session.machine,
    startedAtMs: Math.min(session.startedAtMs, anchorMs - elapsedSec * 1_000),
    elapsedSec,
    distanceM:
      distance ??
      (session.integratedDistanceM > 0 ? Math.round(session.integratedDistanceM) : null),
    energyKcal: session.latest.energyKcal ?? null,
    avgPowerW: average(session.powerWattMs, session.powerMs),
    maxPowerW: session.maxPowerW,
    avgHeartRateBpm: average(session.heartRateBpmMs, session.heartRateMs),
    maxHeartRateBpm: session.maxHeartRateBpm,
    avgCadenceRpm: average(session.cadenceRpmMs, session.cadenceMs),
    strokeCount: session.latest.strokeCount ?? null,
  };
}

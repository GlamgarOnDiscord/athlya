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
 */
import type { FtmsSample, MachineType } from './protocol';

/** Gaps longer than this between two notifications are not integrated. */
export const MAX_GAP_MS = 5_000;

export interface LiveSession {
  readonly machine: MachineType;
  readonly startedAtMs: number;
  readonly lastSampleAtMs: number | null;
  /** Last known value of every metric. */
  readonly latest: FtmsSample;
  readonly samples: number;
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
    latest: {},
    samples: 0,
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

/** Adds one decoded notification received at `atMs`. */
export function addSample(session: LiveSession, sample: FtmsSample, atMs: number): LiveSession {
  const previous = session.latest;
  const gap = session.lastSampleAtMs === null ? 0 : atMs - session.lastSampleAtMs;
  const dt = gap > 0 && gap <= MAX_GAP_MS ? gap : 0;

  const power = previous.powerW;
  const heartRate = previous.heartRateBpm;
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
  /** Start of the workout: the machine's elapsed time counted back from the last sample. */
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

/** Summary at `nowMs`; the session may still be running. */
export function summarise(session: LiveSession, nowMs: number): SessionSummary {
  const endMs = session.lastSampleAtMs ?? nowMs;
  const wallSec = Math.max(0, Math.floor((endMs - session.startedAtMs) / 1_000));
  // The console timer excludes pauses and includes time before the phone
  // connected, so it wins whenever the machine reports one.
  const elapsedSec = session.latest.elapsedSec ?? wallSec;
  const distance = session.latest.distanceM ?? null;
  return {
    machine: session.machine,
    startedAtMs: Math.min(session.startedAtMs, endMs - elapsedSec * 1_000),
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

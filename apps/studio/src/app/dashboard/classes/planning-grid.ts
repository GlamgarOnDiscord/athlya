/**
 * Calendar maths for the studio planning views.
 *
 * Every date here is a local calendar day (midnight in the browser's time
 * zone), the same zone the classes list and `ClassFormDialog` use. Days are
 * stepped with `date-fns` calendar arithmetic, never by adding 24 hours, so
 * a week that crosses a DST change still holds seven midnights.
 */
import {
  addDays,
  addMonths,
  addWeeks,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  parseISO,
  startOfMonth,
  startOfWeek,
} from 'date-fns';

export type PlanningView = 'day' | 'week' | 'month';

/** Views offered on a wide screen; below it the planning is a single-day agenda. */
export const WIDE_VIEWS: ReadonlyArray<PlanningView> = ['week', 'month'];

const WEEK_OPTIONS = { weekStartsOn: 1 } as const;
const MINUTES_PER_DAY = 24 * 60;

export const DEFAULT_START_HOUR = 6;
export const DEFAULT_END_HOUR = 22;

/** `yyyy-MM-dd` key of the local calendar day holding `date`. */
export function toDayKey(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

/** Local midnight of a `yyyy-MM-dd` day key. */
export function fromDayKey(key: string): Date {
  return parseISO(key);
}

/** The seven days (Monday first) of the week holding `anchor`. */
export function buildWeekDays(anchor: Date): Date[] {
  const start = startOfWeek(anchor, WEEK_OPTIONS);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export interface MonthCell {
  readonly date: Date;
  readonly key: string;
  readonly inMonth: boolean;
}

/** Whole Monday-first weeks covering the month of `anchor`, four to six rows. */
export function buildMonthGrid(anchor: Date): MonthCell[][] {
  const last = endOfWeek(endOfMonth(anchor), WEEK_OPTIONS);
  const weeks: MonthCell[][] = [];
  for (
    let weekStart = startOfWeek(startOfMonth(anchor), WEEK_OPTIONS);
    weekStart <= last;
    weekStart = addWeeks(weekStart, 1)
  ) {
    weeks.push(
      buildWeekDays(weekStart).map((date) => ({
        date,
        key: toDayKey(date),
        inMonth: isSameMonth(date, anchor),
      })),
    );
  }
  return weeks;
}

/**
 * The view actually drawn: a narrow screen always gets the day agenda, a
 * wide one the week grid in place of it.
 */
export function resolveView(view: PlanningView, wide: boolean): PlanningView {
  if (!wide) return 'day';
  return view === 'day' ? 'week' : view;
}

/**
 * Visible period of a view: `from` inclusive, `to` exclusive, both local
 * midnights. The day agenda loads its whole week so its day strip moves
 * without a refetch.
 */
export function visibleRange(view: PlanningView, anchor: Date): { from: Date; to: Date } {
  if (view === 'week' || view === 'day') {
    const from = startOfWeek(anchor, WEEK_OPTIONS);
    return { from, to: addDays(from, 7) };
  }
  const from = startOfWeek(startOfMonth(anchor), WEEK_OPTIONS);
  const to = addDays(startOfWeek(endOfMonth(anchor), WEEK_OPTIONS), 7);
  return { from, to };
}

/** The anchor one period before (`-1`) or after (`1`) `anchor`. */
export function shiftAnchor(view: PlanningView, anchor: Date, step: -1 | 1): Date {
  if (view === 'day') return addDays(anchor, step);
  return view === 'week' ? addWeeks(anchor, step) : addMonths(startOfMonth(anchor), step);
}

interface Scheduled {
  readonly startsAt: string;
  readonly durationMin: number;
}

/** Items grouped by the local day they start on, each day sorted by start time. */
export function groupByDay<T extends Scheduled>(items: readonly T[]): Map<string, T[]> {
  const byDay = new Map<string, T[]>();
  const sorted = [...items].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  for (const item of sorted) {
    const key = toDayKey(new Date(item.startsAt));
    const day = byDay.get(key);
    if (day === undefined) byDay.set(key, [item]);
    else day.push(item);
  }
  return byDay;
}

export interface DayBlock<T> {
  readonly item: T;
  /** Wall-clock minutes since local midnight. */
  readonly startMin: number;
  /** Wall-clock end, clipped to the end of the day. */
  readonly endMin: number;
  readonly lane: number;
  readonly lanes: number;
}

/**
 * Places one day's items on the time grid. Items that overlap share the
 * width of their cluster, each in the first free lane, so no block hides
 * another.
 */
export function layoutDay<T extends Scheduled>(items: readonly T[]): DayBlock<T>[] {
  const timed = items
    .map((item) => {
      const start = new Date(item.startsAt);
      const startMin = start.getHours() * 60 + start.getMinutes();
      return {
        item,
        startMin,
        endMin: Math.min(startMin + item.durationMin, MINUTES_PER_DAY),
      };
    })
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  const blocks: DayBlock<T>[] = [];
  let cluster: { item: T; startMin: number; endMin: number; lane: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;

  const flush = (): void => {
    for (const entry of cluster) blocks.push({ ...entry, lanes: laneEnds.length });
    cluster = [];
    laneEnds = [];
  };

  for (const entry of timed) {
    if (entry.startMin >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= entry.startMin);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(entry.endMin);
    } else {
      laneEnds[lane] = entry.endMin;
    }
    cluster.push({ ...entry, lane });
    clusterEnd = Math.max(clusterEnd, entry.endMin);
  }
  flush();
  return blocks;
}

export interface HourBounds {
  readonly startHour: number;
  readonly endHour: number;
}

/** Hours shown on the time grid: the default studio day, widened to fit every block. */
export function hourBounds(blocks: readonly DayBlock<unknown>[]): HourBounds {
  let startHour = DEFAULT_START_HOUR;
  let endHour = DEFAULT_END_HOUR;
  for (const block of blocks) {
    startHour = Math.min(startHour, Math.floor(block.startMin / 60));
    endHour = Math.max(endHour, Math.ceil(block.endMin / 60));
  }
  return { startHour, endHour };
}

export interface BlockGeometry {
  readonly top: number;
  readonly height: number;
  readonly left: number;
  readonly width: number;
}

/** Position of a block in its day column, in percent of the column. */
export function blockGeometry(block: DayBlock<unknown>, bounds: HourBounds): BlockGeometry {
  const span = (bounds.endHour - bounds.startHour) * 60;
  const offset = bounds.startHour * 60;
  return {
    top: ((block.startMin - offset) / span) * 100,
    height: ((block.endMin - block.startMin) / span) * 100,
    left: (block.lane / block.lanes) * 100,
    width: 100 / block.lanes,
  };
}

export type BlockDensity = 'full' | 'medium' | 'compact';

/** Shortest block, in minutes, that fits the title and two meta rows. */
export const FULL_BLOCK_MINUTES = 60;
/** Shortest block, in minutes, that fits the title and one meta row. */
export const MEDIUM_BLOCK_MINUTES = 45;

/** How much text a week block can show without clipping a line. */
export function blockDensity(block: DayBlock<unknown>): BlockDensity {
  const minutes = block.endMin - block.startMin;
  if (minutes >= FULL_BLOCK_MINUTES) return 'full';
  if (minutes >= MEDIUM_BLOCK_MINUTES) return 'medium';
  return 'compact';
}

export const PLANNING_TONES = ['lavender', 'mint', 'sky', 'peach', 'butter', 'rose'] as const;

export type PlanningTone = (typeof PLANNING_TONES)[number];

/**
 * Pastel tone of a class, from an FNV-1a hash of its trimmed, lower-cased
 * title, so every session of "Yoga Vinyasa" shares one colour on every
 * device and render.
 */
export function toneForTitle(title: string): PlanningTone {
  let hash = 0x811c9dc5;
  for (const char of title.trim().toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return PLANNING_TONES[(hash >>> 0) % PLANNING_TONES.length] ?? 'lavender';
}

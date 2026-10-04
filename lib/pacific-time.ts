/**
 * Pacific-time helpers for quota accounting.
 *
 * Gemini's per-project requests-per-day quota resets at midnight Pacific, so a
 * demo budget has to count days on the same boundary the provider does.
 * Counting in UTC would hand out a fresh budget at 5pm/4pm Pacific and misreport
 * when the real reset lands, which is exactly the kind of quiet off-by-one that
 * makes a quota look like it is "randomly" exhausted.
 *
 * Pacific is UTC-8 in winter and UTC-7 in summer (US DST). Rather than ship a
 * hand-rolled DST table, we use `Intl` with an explicit time zone, which Node
 * and Vercel's Node runtime both support. That keeps the zone authoritative
 * instead of guessing an offset.
 */

/** Pacific time zone identifier, valid in `Intl.DateTimeFormat` on all targets. */
const PACIFIC_TZ = "America/Los_Angeles";

/** Milliseconds in one day. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The calendar date it is in Pacific, as `YYYY-MM-DD`.
 *
 * This is the key every daily counter is namespaced by, so a new day starts a
 * new budget for every user at the same instant the provider starts theirs.
 */
export function pacificDateKey(now: Date = new Date()): string {
  // `en-CA` formats dates as YYYY-MM-DD, which is exactly the shape we want.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * The next midnight Pacific after `now`, as epoch milliseconds.
 *
 * Used for `resetsAt` and for counter TTLs. Computed by finding the Pacific
 * date's midnight and stepping forward by whole Pacific days, then resolving
 * that wall-clock time back to an instant — so it stays correct across DST
 * boundaries, where the Pacific day is 23 or 25 hours long rather than 24.
 */
export function nextPacificMidnight(now: Date = new Date()): number {
  const currentKey = pacificDateKey(now);
  const tomorrowKey = addPacificDays(currentKey, 1);
  return pacificMidnightEpoch(tomorrowKey);
}

/** Splits a `YYYY-MM-DD` key into its numeric parts. */
function parseDateKey(dateKey: string): { year: number; month: number; day: number } {
  const parts = dateKey.split("-").map(Number);
  return {
    year: parts[0] ?? 1970,
    month: parts[1] ?? 1,
    day: parts[2] ?? 1,
  };
}

/** Epoch ms for the start of the given `YYYY-MM-DD` Pacific day. */
function pacificMidnightEpoch(dateKey: string): number {
  // Start from UTC midnight of that calendar date, then correct by the zone's
  // offset at that moment. Two passes converge because the offset depends only
  // on the instant, not the answer.
  const { year, month, day } = parseDateKey(dateKey);
  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0);

  let guess = utcGuess;
  for (let i = 0; i < 2; i += 1) {
    const offset = pacificOffsetMs(new Date(guess));
    guess = utcGuess - offset;
  }

  return guess;
}

/**
 * Pacific's UTC offset in milliseconds at `instant`.
 *
 * Positive east of UTC, so `-07:00` in summer yields -7h. Derived by formatting
 * the instant in Pacific and comparing to the same instant in UTC.
 */
function pacificOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    // Intl can render midnight as hour 24 in some ICU builds; normalise it.
    get("hour") % 24,
    get("minute"),
    get("second"),
  );

  return asUtc - instant.getTime();
}

/** The `YYYY-MM-DD` key `days` Pacific days after `dateKey`. */
export function addPacificDays(dateKey: string, days: number): string {
  const { year, month, day } = parseDateKey(dateKey);
  const base = Date.UTC(year, month - 1, day) + days * MS_PER_DAY;
  return new Date(base).toISOString().slice(0, 10);
}

/** Seconds from `now` until `resetsAt`, floored at 0. Never negative. */
export function secondsUntil(now: number, resetsAt: number): number {
  return Math.max(0, Math.ceil((resetsAt - now) / 1000));
}
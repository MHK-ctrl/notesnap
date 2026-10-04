import { describe, expect, it } from "vitest";

import {
  addPacificDays,
  nextPacificMidnight,
  pacificDateKey,
  secondsUntil,
} from "@/lib/pacific-time";

describe("pacificDateKey", () => {
  it("uses the Pacific calendar day, not the UTC one", () => {
    // 03:00 UTC on Oct 5 is still Oct 4 in Pacific (UTC-7 while DST is on).
    expect(pacificDateKey(new Date("2026-10-05T03:00:00Z"))).toBe("2026-10-04");
    // 09:00 UTC on Oct 5 is 02:00 Pacific the same day.
    expect(pacificDateKey(new Date("2026-10-05T09:00:00Z"))).toBe("2026-10-05");
  });

  it("rolls the day over at midnight Pacific", () => {
    // One second before Pacific midnight is still the previous day.
    expect(pacificDateKey(new Date("2026-10-05T06:59:59Z"))).toBe("2026-10-04");
    expect(pacificDateKey(new Date("2026-10-05T07:00:00Z"))).toBe("2026-10-05");
  });

  it("uses the standard-time offset in winter", () => {
    // January is PST (UTC-8), so Pacific midnight is 08:00 UTC.
    expect(pacificDateKey(new Date("2026-01-15T07:59:00Z"))).toBe("2026-01-14");
    expect(pacificDateKey(new Date("2026-01-15T08:00:00Z"))).toBe("2026-01-15");
  });

  it("handles a year boundary", () => {
    expect(pacificDateKey(new Date("2026-01-01T08:00:00Z"))).toBe("2026-01-01");
    expect(pacificDateKey(new Date("2027-01-01T08:00:00Z"))).toBe("2027-01-01");
  });
});

describe("nextPacificMidnight", () => {
  it("returns the coming Pacific midnight while DST is on", () => {
    // 04:20 Pacific on Oct 4 -> midnight at the start of Oct 5 Pacific,
    // which is 07:00 UTC while PDT is in effect.
    const now = new Date("2026-10-04T11:20:00Z");
    expect(nextPacificMidnight(now)).toBe(Date.parse("2026-10-05T07:00:00Z"));
  });

  it("returns the coming Pacific midnight while DST is off", () => {
    // PST is UTC-8, so Pacific midnight is 08:00 UTC in January.
    const now = new Date("2026-01-10T12:00:00Z");
    expect(nextPacificMidnight(now)).toBe(Date.parse("2026-01-11T08:00:00Z"));
  });

  it("always returns a moment in the future", () => {
    for (const iso of [
      "2026-03-08T09:59:00Z", // spring-forward morning in Pacific
      "2026-11-01T08:30:00Z", // fall-back morning in Pacific
      "2026-06-15T00:00:00Z",
      "2026-12-31T23:59:59Z",
    ]) {
      const now = Date.parse(iso);
      expect(nextPacificMidnight(new Date(now))).toBeGreaterThan(now);
    }
  });

  it("advances exactly one Pacific day at the DST boundaries", () => {
    // Clocks go forward at 02:00 Pacific on 2026-03-08, so that Pacific day runs
    // from 08:00Z to 07:00Z the next day — 23 hours long.
    const springDayHours =
      (nextPacificMidnight(new Date(Date.parse("2026-03-08T12:00:00Z"))) -
        nextPacificMidnight(new Date(Date.parse("2026-03-07T12:00:00Z")))) /
      (60 * 60 * 1000);
    expect(springDayHours).toBe(23);

    // Clocks go back at 02:00 Pacific on 2026-11-01, making that day 25 hours.
    const fallDayHours =
      (nextPacificMidnight(new Date(Date.parse("2026-11-01T12:00:00Z"))) -
        nextPacificMidnight(new Date(Date.parse("2026-10-31T12:00:00Z")))) /
      (60 * 60 * 1000);
    expect(fallDayHours).toBe(25);
  });

  it("keeps the reset on the same Pacific day key it reports", () => {
    const now = new Date("2026-10-04T11:20:00Z");
    const reset = new Date(nextPacificMidnight(now));
    // At the reset instant, the Pacific day must have advanced by one.
    expect(pacificDateKey(reset)).toBe(addPacificDays(pacificDateKey(now), 1));
  });
});

describe("addPacificDays", () => {
  it("adds days across a month boundary", () => {
    expect(addPacificDays("2026-10-31", 1)).toBe("2026-11-01");
  });

  it("handles month lengths", () => {
    expect(addPacificDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addPacificDays("2024-02-28", 1)).toBe("2024-02-29");
  });
});

describe("secondsUntil", () => {
  it("rounds up to whole seconds", () => {
    expect(secondsUntil(0, 1_500)).toBe(2);
    expect(secondsUntil(0, 2_000)).toBe(2);
  });

  it("never returns a negative wait", () => {
    expect(secondsUntil(10_000, 5_000)).toBe(0);
  });
});
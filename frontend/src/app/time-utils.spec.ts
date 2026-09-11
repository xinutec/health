import { describe, expect, it } from "vitest";
import { formatLocalTime, rowInstant, wallClockAt, wallOffsetMs } from "./time-utils";

// The API serves every DATETIME with a "Z" suffix. For the Fitbit wall-clock
// columns that suffix is NOT true (#340), and the honest instant is the `_utc`
// sibling served beside it. These pin the split: labels read the wall clock,
// arithmetic reads the instant.
describe("wall clock vs instant (#340)", () => {
  // A London night on BST: the watch said 23:44, the world said 22:44.
  const ts = "2026-09-08T23:44:00.000Z";
  const tsUtc = "2026-09-08T22:44:00.000Z";

  it("reads the instant from the _utc column, not the Z-stamped wall clock", () => {
    expect(rowInstant(ts, tsUtc)).toBe(Date.parse("2026-09-08T22:44:00.000Z"));
  });

  it("recovers the offset the row was lived on", () => {
    expect(wallOffsetMs(ts, tsUtc)).toBe(60 * 60 * 1000);
  });

  it("puts an instant back on the clock the wearer saw", () => {
    expect(wallClockAt(rowInstant(ts, tsUtc), wallOffsetMs(ts, tsUtc))).toBe("23:44");
  });

  it("labels a wall clock the same way formatLocalTime does", () => {
    expect(wallClockAt(rowInstant(ts, tsUtc), wallOffsetMs(ts, tsUtc))).toBe(formatLocalTime(ts));
  });

  // ⚠ THE CASE THE OLD CODE GOT WRONG. Stage ends used to be a difference of
  // two wall clocks; across a zone change that difference counts the clock
  // shift as elapsed time. A real night stored an 86-minute "wake" that was 26.
  it("measures a duration across a zone change as the instants, not the clocks", () => {
    // Woke at 02:00 in UTC+2, next stage at 02:00 having moved to UTC+1.
    const a = { ts: "2026-06-01T02:00:00.000Z", utc: "2026-06-01T00:00:00.000Z" };
    const b = { ts: "2026-06-01T02:00:00.000Z", utc: "2026-06-01T01:00:00.000Z" };
    const elapsed = rowInstant(b.ts, b.utc) - rowInstant(a.ts, a.utc);
    expect(elapsed).toBe(60 * 60 * 1000);

    // The wall clocks are identical, so the pre-#340 arithmetic saw no time
    // pass at all — the failure this replaces.
    expect(Date.parse(a.ts) - Date.parse(b.ts)).toBe(0);

    // And each end still labels as the clock it was lived on.
    expect(wallClockAt(rowInstant(a.ts, a.utc), wallOffsetMs(a.ts, a.utc))).toBe("02:00");
    expect(wallClockAt(rowInstant(b.ts, b.utc), wallOffsetMs(b.ts, b.utc))).toBe("02:00");
  });

  // The degradation is defined, and defined so it cannot shift a chart.
  it("falls back to the wall clock with a zero offset when _utc is absent", () => {
    expect(rowInstant(ts, null)).toBe(Date.parse(ts));
    expect(wallOffsetMs(ts, null)).toBe(0);
    expect(wallClockAt(rowInstant(ts, null), wallOffsetMs(ts, null))).toBe("23:44");
  });

  it("keeps relative geometry within a day when _utc is absent", () => {
    const later = "2026-09-09T01:14:00.000Z";
    expect(rowInstant(later, null) - rowInstant(ts, null)).toBe(90 * 60 * 1000);
  });
});

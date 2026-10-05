import { describe, expect, it } from "vitest";
import { dayAxis, placeOnDays } from "./weight-chart.logic";

// Invented values, not real measurements.

describe("weight chart — the day axis", () => {
  it("lists every day, both ends included, across a month boundary", () => {
    expect(dayAxis("2026-01-30", "2026-02-02")).toEqual(["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
  });

  it("does not lose or repeat a day across a DST change", () => {
    const days = dayAxis("2026-03-27", "2026-04-01");
    expect(days).toHaveLength(6);
    expect(new Set(days).size).toBe(6);
  });
});

describe("weight chart — readings on the day axis", () => {
  const days = dayAxis("2026-01-10", "2026-01-15");

  it("estimates the first day on the line from the reading before to the first inside", () => {
    // 2026-01-05 → 2026-01-15 is 10 days; the 10th is 5 days in: halfway.
    const s = placeOnDays(days, [{ date: "2026-01-15", value: 80 }], { date: "2026-01-05", value: 70 });
    expect(s.estimatedFirst).toBe(true);
    expect(s.values[0]).toBeCloseTo(75, 9);
    expect(s.values.slice(1, 5)).toEqual([null, null, null, null]);
    expect(s.values[5]).toBe(80);
  });

  it("keeps a real first-day reading and estimates nothing", () => {
    const s = placeOnDays(days, [{ date: "2026-01-10", value: 72 }], { date: "2026-01-05", value: 70 });
    expect(s.estimatedFirst).toBe(false);
    expect(s.values[0]).toBe(72);
  });

  it("estimates nothing without a reading before the window", () => {
    const s = placeOnDays(days, [{ date: "2026-01-12", value: 72 }], null);
    expect(s.estimatedFirst).toBe(false);
    expect(s.values[0]).toBeNull();
  });

  it("estimates nothing without a reading inside the window to aim at", () => {
    const s = placeOnDays(days, [], { date: "2026-01-05", value: 70 });
    expect(s.estimatedFirst).toBe(false);
    expect(s.values.every((v) => v === null)).toBe(true);
  });
});

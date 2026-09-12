import { describe, expect, it } from "vitest";
import { wallClockInZone } from "./time-utils";

// The API used to serve every Fitbit DATETIME twice: a wall clock stamped with a
// "Z" that was not true of it (#340), and an `_utc` sibling. Every reader then
// had to know which of the two it wanted, and the ones that guessed wrong were
// the bugs. The wall clock is no longer served at all (#1532) — the instant is
// repaired at the route — so these pin what is left: one instant, one zone, and
// labels derived rather than read.
describe("one instant, one zone (#1532)", () => {
	// ⚠ THE CASE THE OLD CODE GOT WRONG, now unwritable. Stage ends used to be a
	// difference of two wall clocks; across a zone change that difference counts
	// the clock shift as elapsed time, and a real night stored an 86-minute
	// "wake" that was 26. With only instants on the wire, the subtraction is the
	// right one by construction.
	it("measures a duration across a zone change as the instants", () => {
		// Woke at 02:00 in Berlin (CEST, UTC+2), next stage at 02:00 having moved
		// to London (BST, UTC+1) — one hour later by the world, no time at all by
		// the clock on the wall.
		const a = Date.parse("2026-06-01T00:00:00.000Z");
		const b = Date.parse("2026-06-01T01:00:00.000Z");
		expect(b - a).toBe(60 * 60 * 1000);

		// And each end still LABELS as the clock it was lived on — the reason the
		// wall clock was ever on the wire, now derived from the zone instead.
		expect(wallClockInZone(a, "Europe/Berlin")).toBe("02:00");
		expect(wallClockInZone(b, "Europe/London")).toBe("02:00");
	});
});

describe("wallClockInZone", () => {
	// The instant is 23:10 UTC. London in summer is BST, so the clock he saw
	// read 00:10 the next day — the hour a fixed offset of zero would have lost.
	it("renders an instant in the sleeper's zone, not the viewer's", () => {
		const at = Date.parse("2026-06-15T23:10:00Z");
		expect(wallClockInZone(at, "Europe/London")).toBe("00:10");
		expect(wallClockInZone(at, "Europe/Amsterdam")).toBe("01:10");
		expect(wallClockInZone(at, "UTC")).toBe("23:10");
	});

	// ⚠ The same instant in WINTER is 23:10 in London. A single stored offset
	// cannot be right in both seasons; a zone is.
	it("follows the zone across the summer-time boundary", () => {
		const winter = Date.parse("2026-01-15T23:10:00Z");
		expect(wallClockInZone(winter, "Europe/London")).toBe("23:10");
	});

	// An absent zone degrades to reading the instant as UTC, which is what the
	// old offset-of-zero path did. It is a fallback, not a default.
	it("degrades to UTC when no zone is given", () => {
		const at = Date.parse("2026-06-15T23:10:00Z");
		expect(wallClockInZone(at, null)).toBe("23:10");
		expect(wallClockInZone(at, undefined)).toBe("23:10");
	});

	it("renders midnight as 00:xx rather than 24:xx", () => {
		expect(wallClockInZone(Date.parse("2026-01-15T00:05:00Z"), "UTC")).toBe("00:05");
	});
});

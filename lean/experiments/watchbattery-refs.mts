#!/usr/bin/env -S npx tsx
/**
 * Derive `#guard` expectations for `Verified.Geo.Velocity.watchBatterySeries`
 * from V8.
 *
 * The watch trace is read back from `device_battery_log` and plotted on the same
 * axis as the phone's. The reduction has five clauses and each one is easy to
 * get silently wrong in a way that still draws a plausible chart:
 *
 *   - `MobileTrack` is Fitbit's PSEUDO-device for phone step tracking. It
 *     reports battery 0, so leaving it in draws the watch flat-lining at empty;
 *   - the window is HALF-OPEN, `[startUtc, endUtc)`;
 *   - readings are sorted by time — the table is not ordered;
 *   - two devices reporting at the SAME instant keep the LATER row;
 *   - a run of equal levels collapses to its FIRST reading, because a flat step
 *     is already drawn from the point that started it.
 *
 * ⚠ The wall-clock → epoch conversion is NOT here. `last_sync_time` is a Fitbit
 * wall clock with no offset, so resolving it needs tzdata, which is the host's.
 * These cases feed timestamps directly.
 *
 * Run: npx tsx lean/experiments/watchbattery-refs.mts
 */
import { type WatchBatteryRow, watchBatterySeries } from "../../src/fitbit/watch-battery.js";

// The rows carry a wall clock, and `watchBatterySeries` resolves it with
// `fitbitTsToUnix(row, tz)`. UTC is used throughout so the printed epochs are
// the wall clocks themselves and the cases stay readable.
const TZ = "UTC";
const at = (unixS: number): string => new Date(unixS * 1000).toISOString().slice(0, 19).replace("T", " ");
const row = (unixS: number, batteryLevel: number, deviceVersion: string | null = "Charge 5"): WatchBatteryRow => ({
	lastSyncTime: at(unixS),
	batteryLevel,
	deviceVersion,
});

const DAY_START = 1_767_225_600; // 2026-01-01T00:00:00Z
const DAY_END = DAY_START + 86_400;

const show = (label: string, rows: WatchBatteryRow[], start = DAY_START, end = DAY_END) => {
	const out = watchBatterySeries(rows, TZ, start, end);
	console.log(`${label}: ${JSON.stringify(out.map((s) => [s.ts - DAY_START, s.level]))}`);
};

show("empty", []);
show("one reading", [row(DAY_START + 100, 90)]);
// ⚠ The phone pseudo-tracker reports 0 and must never reach the watch series.
show("MobileTrack dropped", [row(DAY_START + 100, 0, "MobileTrack"), row(DAY_START + 200, 90)]);
show("null deviceVersion kept", [row(DAY_START + 100, 90, null)]);
// Half-open window: the start instant is in, the end instant is out.
show("window is half-open", [
	row(DAY_START - 1, 99),
	row(DAY_START, 90),
	row(DAY_END - 1, 50),
	row(DAY_END, 49),
]);
// Unsorted input.
show("sorted by time", [row(DAY_START + 300, 80), row(DAY_START + 100, 90), row(DAY_START + 200, 85)]);
// ⚠ Equal levels collapse to the FIRST reading of the run.
show("flat run collapses", [
	row(DAY_START + 100, 90),
	row(DAY_START + 200, 90),
	row(DAY_START + 300, 90),
	row(DAY_START + 400, 85),
]);
// ⚠ Two devices at the same instant: the LATER row wins.
show("same instant keeps the later row", [row(DAY_START + 100, 90), row(DAY_START + 100, 70)]);
show("same instant, reversed input", [row(DAY_START + 100, 70), row(DAY_START + 100, 90)]);
// A level that returns to a previous value is a real step, not a flat run.
show("level returns", [row(DAY_START + 100, 90), row(DAY_START + 200, 85), row(DAY_START + 300, 90)]);
// Everything outside the window.
show("all outside", [row(DAY_START - 10, 90), row(DAY_END + 10, 80)]);

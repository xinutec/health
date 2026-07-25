/**
 * V8 reference values for the Lean port of `src/geo/episode-geometry.ts` — the
 * map's half of the "one day, two renderers" model. `buildEpisodes` resolves a
 * display geometry for every `DayState`, 1:1, so the narrative and the map
 * cannot drift.
 *
 * The three helpers left unported (`stitchTrainEnds`, `stayAnchor`,
 * `entryPoint`) are module-private, so this harness drives them the only honest
 * way: through the public `buildEpisodes`, with scenarios shaped to reach each
 * branch. That means the reference set pins `resolveEpisode`'s whole dispatch
 * too — the train arms, the four moving-mode draw precedences, the anchor arm
 * and the `unknown` connector — not just the three leaves.
 *
 * Behaviours the cases below pin, in the order `resolveEpisode` tests them:
 *
 *   train    — a cached `snappedPath` clipped to the window wins; a
 *              reconstructed leg (`pointCount === 0`) draws a station-to-station
 *              connector with NO distance cap; otherwise raw GPS with the two
 *              station join points stitched on past 100 m.
 *   moving   — `matchedPath` (road) → `walkSmoothedPath` → `walkMatchedPath` →
 *              raw fixes, each needing ≥ 2 points in-window to win. The raw arm
 *              prefers `rawFixes` (pre-Kalman) and applies the per-mode speed
 *              ceiling; without them it falls back to the Kalman points with the
 *              same ceiling applied differently — `holdImplausibleSpeed` vs a
 *              plain `speed_kmh` filter, which is a real behavioural split.
 *   stay     — the covering segment's centroid, else the mean of the window
 *              fixes, else nothing (a synthesized pre-fix sleep).
 *   unknown  — a connector capped at 2 km, drawn only when BOTH ends exist.
 *
 * Note `equirectMeters` here is NOT `metersBetween`: it takes `cos` at the
 * FIRST point, not the midpoint. Both live in the codebase and they differ.
 *
 * Run:
 *   nix develop /Users/pippijn/Code/health --command \
 *     npx tsx /Users/pippijn/Code/health/lean/experiments/episode-geometry-refs.mts
 */

import { buildEpisodes, type RawFix } from "../../src/geo/episode-geometry.js";
import type { EnrichedSegment } from "../../src/geo/enriched-segment.js";
import type { FilteredPoint } from "../../src/geo/kalman.js";
import type { SnappedPoint } from "../../src/geo/rail-snap.js";
import type { DayState, DayStateMode } from "../../src/sleep/day-state.js";

const lines: string[] = [];
const say = (label: string, value: string): void => lines.push(`${label} = ${value}`);
const section = (name: string): void => lines.push(`\n=== ${name} ===`);

const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111_320;
const MLON = 1 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));
/** North/east metres from the frame origin → lat/lon. */
const at = (n: number, e: number): { lat: number; lon: number } => ({ lat: LAT0 + n * MLAT, lon: LON0 + e * MLON });

const fix = (ts: number, n: number, e: number, speed = 4): FilteredPoint => ({
	ts,
	...at(n, e),
	speed_kmh: speed,
	bearing: 90,
});
const raw = (ts: number, n: number, e: number): RawFix => ({ ts, ...at(n, e) });
const snap = (ts: number, n: number, e: number): SnappedPoint => ({ ts, ...at(n, e) });

const state = (startTs: number, endTs: number, mode: string, place?: string): DayState =>
	({ startTs, endTs, mode: mode as DayStateMode, ...(place === undefined ? {} : { place }) }) as DayState;

/** An `EnrichedSegment` with only the fields `resolveEpisode` reads. */
const seg = (startTs: number, endTs: number, mode: string, extra: Partial<EnrichedSegment> = {}): EnrichedSegment =>
	({
		startTs,
		endTs,
		mode,
		confidence: 1,
		confidenceMargin: 3,
		avgSpeed: 4,
		maxSpeed: 6,
		linearity: 0.9,
		pointCount: 10,
		...extra,
	}) as EnrichedSegment;

/** Episodes as `kind|place|n·(lat,lon,ts)` — coordinates at full precision so
 *  the Lean twin is compared bit-for-bit, not to a rounded string. */
const show = (
	label: string,
	states: DayState[],
	segments: EnrichedSegment[],
	points: FilteredPoint[],
	rawFixes?: RawFix[],
): void => {
	for (const [i, ep] of buildEpisodes(states, segments, points, rawFixes).entries()) {
		say(
			`${label} [${i}]`,
			`${ep.mode}|${ep.kind}|${ep.place ?? "-"}|${ep.startTs}-${ep.endTs}|` +
				ep.points.map((p) => `(${p.lat},${p.lon},${p.ts ?? "-"})`).join(" "),
		);
	}
};

// ---------------------------------------------------------------------------
section("train — snappedPath wins, clipped to the window");
// The cached rail line runs past both ends of the state; only the in-window
// vertices are drawn, and two of them survive the >= 2 test.
{
	const st = [state(1000, 1200, "train")];
	const sg = [
		seg(1000, 1200, "train", {
			snappedPath: [snap(900, 0, 0), snap(1050, 0, 500), snap(1150, 0, 1000), snap(1300, 0, 1500)],
		}),
	];
	show("snapped", st, sg, [fix(1050, 1, 500), fix(1150, 1, 1000)]);
}
// Only ONE vertex lands in the window → falls through to the raw arm.
{
	const st = [state(1000, 1200, "train")];
	const sg = [seg(1000, 1200, "train", { snappedPath: [snap(900, 0, 0), snap(1050, 0, 500), snap(1300, 0, 1500)] })];
	show("snapped, 1 in window", st, sg, [fix(1050, 1, 500), fix(1150, 1, 1000)]);
}
// `effectiveMode` is refinedMode ?? mode: a segment whose raw mode is driving
// but refined to train still supplies the snapped path.
{
	const st = [state(1000, 1200, "train")];
	const sg = [
		seg(1000, 1200, "driving", {
			refinedMode: "train",
			snappedPath: [snap(1050, 0, 500), snap(1150, 0, 1000)],
		}),
	];
	show("snapped via refinedMode", st, sg, [fix(1050, 1, 500)]);
}

section("train — reconstructed leg draws an uncapped station connector");
// pointCount 0 = a tube ride with no real GPS. The connector runs from the
// previous episode's last drawn point to the next state's entry point, however
// far apart they are (unlike the `unknown` connector's 2 km cap).
{
	const st = [state(900, 1000, "stationary", "Baker Street"), state(1000, 1200, "train"), state(1200, 1300, "walking")];
	const sg = [
		seg(900, 1000, "stationary", { centroidLat: at(0, 0).lat, centroidLon: at(0, 0).lon }),
		seg(1000, 1200, "train", { pointCount: 0 }),
		seg(1200, 1300, "walking"),
	];
	show("reconstructed", st, sg, [fix(1250, 0, 4000), fix(1280, 0, 4100)]);
}
// Same, but the next state has no entry point at all → nothing is drawn.
{
	const st = [state(900, 1000, "stationary", "Baker Street"), state(1000, 1200, "train")];
	const sg = [
		seg(900, 1000, "stationary", { centroidLat: at(0, 0).lat, centroidLon: at(0, 0).lon }),
		seg(1000, 1200, "train", { pointCount: 0 }),
	];
	show("reconstructed, no `to`", st, sg, []);
}

section("train — stitchTrainEnds");
// The raw GPS starts 900 m past the boarding station and stops 900 m short of
// the alighting one; both join points are stitched on.
{
	const st = [state(900, 1000, "stationary", "Board"), state(1000, 1200, "train"), state(1200, 1300, "walking")];
	const sg = [
		seg(900, 1000, "stationary", { centroidLat: at(0, 0).lat, centroidLon: at(0, 0).lon }),
		seg(1000, 1200, "train"),
		seg(1200, 1300, "walking"),
	];
	show("stitch both ends", st, sg, [fix(1050, 0, 900), fix(1100, 0, 2000), fix(1150, 0, 3100), fix(1250, 0, 4000)]);
}
// Both join points land WITHIN 100 m of the existing ends → neither is added
// (stitching would only duplicate a point already there).
{
	const st = [state(900, 1000, "stationary", "Board"), state(1000, 1200, "train"), state(1200, 1300, "walking")];
	const sg = [
		seg(900, 1000, "stationary", { centroidLat: at(0, 0).lat, centroidLon: at(0, 0).lon }),
		seg(1000, 1200, "train"),
		seg(1200, 1300, "walking"),
	];
	show("stitch neither (< 100 m)", st, sg, [fix(1050, 0, 50), fix(1100, 0, 2000), fix(1150, 0, 3950), fix(1250, 0, 4000)]);
}
// Exactly at the bar: the test is STRICT (`> 100`), so a join point exactly
// 100 m away is NOT stitched.
{
	const st = [state(900, 1000, "stationary", "Board"), state(1000, 1200, "train")];
	const sg = [seg(900, 1000, "stationary", { centroidLat: at(0, 0).lat, centroidLon: at(0, 0).lon }), seg(1000, 1200, "train")];
	show("stitch at exactly 100 m", st, sg, [fix(1050, 0, 100), fix(1100, 0, 2000), fix(1150, 0, 3000)]);
}
// A train leg with no raw fixes at all: `pts` is empty, so `farFromEnd` sees
// `undefined` at both ends and BOTH join points go in — the leg becomes the
// bare station-to-station chord.
{
	const st = [state(900, 1000, "stationary", "Board"), state(1000, 1200, "train"), state(1200, 1300, "walking")];
	const sg = [
		seg(900, 1000, "stationary", { centroidLat: at(0, 0).lat, centroidLon: at(0, 0).lon }),
		seg(1000, 1200, "train"),
		seg(1200, 1300, "walking"),
	];
	show("stitch onto empty", st, sg, [fix(1250, 0, 4000), fix(1280, 0, 4100)]);
}

// A train episode at index 0 — the day opens on a ride. There is no previous
// episode, so only the alighting end is stitched.
{
	const st = [state(1000, 1200, "train"), state(1200, 1300, "walking")];
	const sg = [seg(1000, 1200, "train"), seg(1200, 1300, "walking")];
	show("train opens the day", st, sg, [fix(1050, 0, 900), fix(1150, 0, 3100), fix(1250, 0, 4000)]);
}

section("moving — the four draw precedences");
const movingStates = [state(1000, 1200, "walking")];
const walkFixes = [fix(1020, 0, 0), fix(1080, 0, 60), fix(1140, 0, 120)];
// walkSmoothedPath outranks walkMatchedPath (#296: a reconstruction that
// beat a phantom out-and-back).
{
	const sg = [
		seg(1000, 1200, "walking", {
			walkMatchedPath: [snap(1020, 1, 0), snap(1140, 1, 120)],
			walkSmoothedPath: [snap(1020, 2, 0), snap(1140, 2, 120)],
		}),
	];
	show("smoothed over matched", movingStates, sg, walkFixes);
}
{
	const sg = [seg(1000, 1200, "walking", { walkMatchedPath: [snap(1020, 1, 0), snap(1140, 1, 120)] })];
	show("walk matched", movingStates, sg, walkFixes);
}
// The ROAD arm is tested first and applies to driving/bus/cycling only — a
// walking segment carrying a matchedPath does NOT take it.
{
	const sg = [seg(1000, 1200, "walking", { matchedPath: [snap(1020, 3, 0), snap(1140, 3, 120)] })];
	show("walking ignores matchedPath", movingStates, sg, walkFixes);
}
{
	const sg = [seg(1000, 1200, "cycling", { matchedPath: [snap(1020, 3, 0), snap(1140, 3, 120)] })];
	show("cycling takes matchedPath", [state(1000, 1200, "cycling")], sg, walkFixes);
}
{
	const sg = [seg(1000, 1200, "walking")];
	show("raw fallback", movingStates, sg, walkFixes);
}

section("moving — rawFixes preferred, and the speed ceiling");
// With rawFixes present the pre-Kalman track is drawn and
// `holdImplausibleSpeed` collapses the teleport run (walking cap 12 km/h).
{
	const sg = [seg(1000, 1200, "walking")];
	const rf = [raw(1000, 0, 0), raw(1030, 0, 60), raw(1060, 0, 2000), raw(1090, 0, 120), raw(1120, 0, 180)];
	show("rawFixes + hold", movingStates, sg, walkFixes, rf);
}
// Fewer than 2 survive the hold → falls through to the Kalman points.
{
	const sg = [seg(1000, 1200, "walking")];
	show("rawFixes too short", movingStates, sg, walkFixes, [raw(1000, 0, 0)]);
}
// Without rawFixes the Kalman branch filters on the reported `speed_kmh`
// instead — a different mechanism, pinned separately.
{
	const sg = [seg(1000, 1200, "walking")];
	const pts = [fix(1020, 0, 0), fix(1050, 0, 60, 40), fix(1080, 0, 120), fix(1140, 0, 180)];
	show("speed_kmh filter", movingStates, sg, pts);
}
// A mode with no cap (driving) keeps every fix.
{
	const sg = [seg(1000, 1200, "driving")];
	const pts = [fix(1020, 0, 0), fix(1050, 0, 60, 90), fix(1080, 0, 120), fix(1140, 0, 180)];
	show("no cap for driving", [state(1000, 1200, "driving")], sg, pts);
}

section("stay — stayAnchor");
// The covering segment's precomputed centroid wins over the window fixes.
{
	const st = [state(1000, 1200, "stationary", "Cafe")];
	const sg = [seg(1000, 1200, "stationary", { centroidLat: at(5, 5).lat, centroidLon: at(5, 5).lon })];
	show("centroid", st, sg, [fix(1020, 0, 0), fix(1100, 0, 100)]);
}
// No centroid → the mean of the window fixes.
{
	const st = [state(1000, 1200, "stationary", "Cafe")];
	show("mean of fixes", st, [seg(1000, 1200, "stationary")], [fix(1020, 0, 0), fix(1100, 0, 100)]);
}
// Neither → an anchor episode with no points (a synthesized pre-fix sleep),
// and `place` is still carried when the state has one.
{
	show("no anchor", [state(1000, 1200, "sleeping", "Home")], [], []);
	show("no anchor, no place", [state(1000, 1200, "sleeping")], [], []);
}
// A segment with only ONE of the two centroid fields is not a centroid.
{
	const st = [state(1000, 1200, "stationary", "Cafe")];
	const sg = [seg(1000, 1200, "stationary", { centroidLat: at(5, 5).lat })];
	show("half a centroid", st, sg, [fix(1020, 0, 0), fix(1100, 0, 100)]);
}

section("unknown — the capped connector and entryPoint");
// Under 2 km: drawn. The `to` end is the next state's FIRST window fix.
{
	const st = [state(900, 1000, "walking"), state(1000, 1100, "unknown"), state(1100, 1200, "walking")];
	const sg = [seg(900, 1000, "walking"), seg(1100, 1200, "walking")];
	show("connector drawn", st, sg, [fix(920, 0, 0), fix(980, 0, 100), fix(1120, 0, 1000), fix(1180, 0, 1100)]);
}
// Over 2 km: refused.
{
	const st = [state(900, 1000, "walking"), state(1000, 1100, "unknown"), state(1100, 1200, "walking")];
	const sg = [seg(900, 1000, "walking"), seg(1100, 1200, "walking")];
	show("connector too long", st, sg, [fix(920, 0, 0), fix(980, 0, 100), fix(1120, 0, 5000), fix(1180, 0, 5100)]);
}
// `entryPoint` falls back to the next state's stay centroid when it has no
// window fix of its own.
{
	const st = [state(900, 1000, "walking"), state(1000, 1100, "unknown"), state(1100, 1200, "stationary", "Shop")];
	const sg = [
		seg(900, 1000, "walking"),
		seg(1100, 1200, "stationary", { centroidLat: at(0, 500).lat, centroidLon: at(0, 500).lon }),
	];
	show("entryPoint via centroid", st, sg, [fix(920, 0, 0), fix(980, 0, 100)]);
}
// No previous episode at all (the `unknown` opens the day) → nothing drawn.
{
	const st = [state(1000, 1100, "unknown"), state(1100, 1200, "walking")];
	show("no `from`", st, [seg(1100, 1200, "walking")], [fix(1120, 0, 100), fix(1180, 0, 200)]);
}
// The previous episode exists but drew nothing → `points.at(-1)` is undefined.
{
	const st = [state(900, 1000, "sleeping"), state(1000, 1100, "unknown"), state(1100, 1200, "walking")];
	show("previous drew nothing", st, [seg(1100, 1200, "walking")], [fix(1120, 0, 100), fix(1180, 0, 200)]);
}

section("the whole-day shape");
// Every episode is 1:1 with a state, in order, self-describing.
{
	const st = [
		state(0, 1000, "sleeping", "Home"),
		state(1000, 1200, "walking"),
		state(1200, 1400, "train"),
		state(1400, 1500, "unknown"),
		state(1500, 2000, "stationary", "Work"),
	];
	const sg = [
		seg(0, 1000, "stationary", { centroidLat: at(0, 0).lat, centroidLon: at(0, 0).lon }),
		seg(1000, 1200, "walking"),
		seg(1200, 1400, "train", { snappedPath: [snap(1250, 0, 500), snap(1350, 0, 1500)] }),
		seg(1500, 2000, "stationary", { centroidLat: at(0, 1800).lat, centroidLon: at(0, 1800).lon }),
	];
	show("day", st, sg, [fix(1020, 0, 0), fix(1100, 0, 100), fix(1180, 0, 200), fix(1550, 0, 1800)]);
}

console.log(lines.join("\n"));

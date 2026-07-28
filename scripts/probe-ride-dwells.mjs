#!/usr/bin/env node
// Does the ride's own fix stream show the train STOPPING at the stations a
// candidate line calls at? (#382.)
//
// Two lines that share a track are indistinguishable from where the fixes
// ARE — but not from where the train PAUSED. A Jubilee train calling at
// Neasden, Dollis Hill, Willesden Green and Kilburn leaves four near-zero
// clusters in the middle of the ride; a Metropolitan running fast past them
// leaves none. This prints the interior speed profile and the dwell count the
// detector derives from it, next to each candidate line's true intermediate-
// stop count from `rail_stops_cache`.
//
// Usage:
//   nix develop . --command node scripts/probe-ride-dwells.mjs <date> <fromZ> <toZ> [line...]
import { readFileSync } from "node:fs";
import { parseCapturedDay } from "../dist/cli/fixture-day.js";
import { qualityFilterGps } from "../dist/geo/gps-quality.js";
import { filterGpsTrack } from "../dist/geo/kalman.js";
import { intermediateStopCount, pickLineByStoppingPattern, stopBounds } from "../dist/geo/line-stopping-pattern.js";
import { snapToPlace } from "../dist/geo/place-snap.js";
import { dateBoundsUtc } from "../dist/geo/timezone.js";

const [date, fromZ, toZ, ...lines] = process.argv.slice(2);
const t = (ts) => new Date(ts * 1000).toISOString().slice(11, 19);
const captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-pippijn.json`, "utf8"));
const inputs = captured.inputs;

// Rebuild the fix stream computeVelocity works on: quality filter, place-snap,
// accuracy ceiling, Kalman. Anything less is not what the pass actually sees.
const dayBounds = dateBoundsUtc(date, inputs.identity.displayTz);
const inDay = inputs.phonetrack.today.filter((p) => p.ts >= dayBounds.startUtc && p.ts < dayBounds.endUtc);
const cleaned = qualityFilterGps(inDay);
const knownPlaces = inputs.knownPlaces ?? [];
const snapped =
	knownPlaces.length > 0
		? cleaned.map((p) => {
				const r = snapToPlace({ lat: p.lat, lon: p.lon, accuracy: p.accuracy }, knownPlaces);
				return r.snapped ? { ...p, lat: r.lat, lon: r.lon, accuracy: r.accuracy } : p;
			})
		: cleaned;
const points = filterGpsTrack(
	snapped
		.filter((p) => p.accuracy === null || p.accuracy <= 200)
		.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy })),
);

const lo = Date.parse(`${date}T${fromZ}Z`) / 1000;
const hi = Date.parse(`${date}T${toZ}Z`) / 1000;
const inWindow = points.filter((p) => p.ts >= lo && p.ts <= hi).sort((a, b) => a.ts - b.ts);

console.log(`\n=== ${date} ${fromZ}–${toZ} (${Math.round((hi - lo) / 60)} min, ${inWindow.length} fixes) ===`);
for (const p of inWindow) console.log(`  ${t(p.ts)}  ${(p.speed_kmh ?? 0).toFixed(1).padStart(6)} km/h`);

const bounds = stopBounds(points, lo, hi);
console.log(`\nstopBounds => ${bounds === null ? "null (never observed running)" : `${bounds.atLeast}..${bounds.atMost} stops`}`);

const board = process.env.BOARD ?? "";
const alight = process.env.ALIGHT ?? "";
// The stop mirror is global, not per-day: RELATIONS_FROM borrows another
// captured day's copy so a day captured before the field existed can still be
// probed against it.
const relations =
	(process.env.RELATIONS_FROM
		? parseCapturedDay(readFileSync(`tests/golden/days/${process.env.RELATIONS_FROM}-pippijn.json`, "utf8")).inputs
				.railStopsCache
		: inputs.railStopsCache) ?? [];
console.log(`rail_stops_cache: ${relations.length} relations   (${board} → ${alight})`);
for (const line of lines) {
	const n = intermediateStopCount(line, board, alight, relations);
	const verdict = bounds === null || n === null ? "?" : n >= bounds.atLeast && n <= bounds.atMost ? "POSSIBLE" : "ruled out";
	console.log(`  ${line}: ${n === null ? "unknown" : `${n} intermediate stop(s)`}  ${verdict}`);
}
console.log(`\npickLineByStoppingPattern => ${pickLineByStoppingPattern(lines, board, alight, relations, points, lo, hi) ?? "null"}`);

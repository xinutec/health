#!/usr/bin/env node
// Why does the 05-22 evening tube ride (King's Cross St Pancras → Finchley
// Road, Metropolitan) come out as an unlabelled `driving` leg with no station
// pair and no line?
//
// Dumps the raw fixes across the ride window with accuracy and fix-to-fix
// speed, then asks the two lookups the reconstruction depends on — which
// stations are near each end, which lines run at each end — so the answer is
// "the evidence is/isn't there" rather than "some pass didn't fire".
// Read-only: fixture inputs only, no DB and no network.
//
// Usage: nix develop . --command node scripts/probe-0522-tube.mjs [date] [fromZ] [toZ]
import { readFileSync } from "node:fs";
import { inputsFromFixture, parseCapturedDay } from "../dist/cli/fixture-day.js";
import { COARSE_ACCURACY_M, UNDERGROUND_LINES_RADIUS_M, UNDERGROUND_STATION_RADIUS_M } from "../dist/geo/underground-rail.js";
import { haversineMeters } from "../dist/geo/place-snap.js";
import { RAIL_RUN_STATION_RADIUS_M } from "../dist/geo/passes/rail-runs.js";

const date = process.argv[2] ?? "2026-05-22";
const from = Date.parse(`${date}T${process.argv[3] ?? "18:50:00"}Z`) / 1000;
const to = Date.parse(`${date}T${process.argv[4] ?? "19:20:00"}Z`) / 1000;
const t = (ts) => new Date(ts * 1000).toISOString().slice(11, 19);

const captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-pippijn.json`, "utf8"));
const inputs = inputsFromFixture(captured);
const osm = inputs.osm;

const fixes = inputs.phonetrack.today.filter((p) => p.ts >= from && p.ts <= to);
console.log(`${fixes.length} fixes ${t(from)}–${t(to)}  (coarse = accuracy >= ${COARSE_ACCURACY_M})`);
let prev = null;
for (const f of fixes) {
	const dt = prev ? f.ts - prev.ts : 0;
	const d = prev ? haversineMeters(prev.lat, prev.lon, f.lat, f.lon) : 0;
	const kmh = dt > 0 ? (d / dt) * 3.6 : 0;
	const coarse = f.accuracy != null && f.accuracy >= COARSE_ACCURACY_M ? " COARSE" : "";
	console.log(
		`  ${t(f.ts)}  ${f.lat.toFixed(5)},${f.lon.toFixed(5)}  acc=${String(f.accuracy ?? "?").padStart(4)}${coarse}  ` +
			`+${String(dt).padStart(3)}s ${d.toFixed(0).padStart(5)}m ${kmh.toFixed(1).padStart(5)} km/h`,
	);
	prev = f;
}

console.log("\n--- station / line lookups at each fix ---");
for (const f of fixes) {
	const [near, lines] = await Promise.all([
		osm.nearbyStations(f.lat, f.lon, RAIL_RUN_STATION_RADIUS_M).catch((e) => `ERR ${e.message}`),
		osm.linesAtPoint(f.lat, f.lon, UNDERGROUND_LINES_RADIUS_M).catch((e) => `ERR ${e.message}`),
	]);
	const stationNames = Array.isArray(near) ? near.map((s) => `${s.name}@${Math.round(s.distanceM ?? -1)}m`).join(", ") : near;
	const lineNames = lines instanceof Set ? [...lines].join(", ") : lines;
	console.log(`  ${t(f.ts)}  stations[${UNDERGROUND_STATION_RADIUS_M}? no, ${RAIL_RUN_STATION_RADIUS_M}]: ${stationNames || "(none)"}`);
	console.log(`             lines: ${lineNames || "(none)"}`);
}

/**
 * Scratch CLI (#346 A/B): dump one walk leg's drawn geometry + its OSM
 * surroundings from a golden fixture, as JSON on stdout. Pure fixture replay —
 * no DB, no Overpass. Run it at two commits to diff the drawn line.
 *
 *   node dist/cli/dump-walk-geom.js 2026-07-07 08:42 > new.json
 */

import { readFileSync } from "node:fs";
import type { BuildingFootprint } from "../geo/osm-local.js";
import type { OsmRoadWay } from "../geo/road-match.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { type CapturedDay, inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

function allWalkable(c: CapturedDay): OsmRoadWay[] {
	const section = c.inputs.osmTrace.walkableRoads;
	if (!section) return [];
	const out: OsmRoadWay[] = [];
	for (const v of Object.values(section)) out.push(...(v as OsmRoadWay[]));
	return out;
}
function allBuildings(c: CapturedDay): BuildingFootprint[] {
	const section = c.inputs.osmTrace.buildingsNear;
	if (!section) return [];
	const out: BuildingFootprint[] = [];
	for (const v of Object.values(section)) out.push(...(v as BuildingFootprint[]));
	return out;
}
const hhmm = (ts: number): string => new Date(ts * 1000).toISOString().slice(11, 16);

async function main(): Promise<void> {
	const date = process.argv[2];
	const want = process.argv[3]; // HH:MM (UTC) of the leg's start
	const captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-pippijn.json`, "utf8"));
	const on = await computeVelocityFromInputs(inputsFromFixture(captured), { walkMatch: true });

	const seg = on.segments.find((s) => hhmm(s.startTs) === want);
	if (!seg) {
		console.error(`no segment starting ${want}; walks: ${on.segments.map((s) => hhmm(s.startTs)).join(",")}`);
		process.exit(1);
	}
	const drawn = seg.walkSmoothedPath ?? seg.walkMatchedPath ?? null;
	const raw = on.rawFixes
		.filter((f) => f.ts >= seg.startTs && f.ts <= seg.endTs)
		.map((f) => [f.lat, f.lon] as [number, number]);

	// Clip the OSM context to the leg's bbox + margin, so the payload stays small.
	const lats = raw.map((p) => p[0]).concat((drawn ?? []).map((p) => p.lat));
	const lons = raw.map((p) => p[1]).concat((drawn ?? []).map((p) => p.lon));
	const pad = 0.0015;
	const [loLat, hiLat] = [Math.min(...lats) - pad, Math.max(...lats) + pad];
	const [loLon, hiLon] = [Math.min(...lons) - pad, Math.max(...lons) + pad];
	const inBox = (lat: number, lon: number): boolean => lat >= loLat && lat <= hiLat && lon >= loLon && lon <= hiLon;

	console.log(
		JSON.stringify({
			date,
			window: `${hhmm(seg.startTs)}–${hhmm(seg.endTs)}`,
			kind: seg.walkSmoothedPath ? "smoothed" : seg.walkMatchedPath ? "matched" : "raw",
			raw,
			drawn: (drawn ?? []).map((p) => [p.lat, p.lon]),
			ways: allWalkable(captured)
				.filter((w) => w.coords.some(([a, b]) => inBox(a, b)))
				.map((w) => w.coords),
			buildings: allBuildings(captured)
				.filter((r) => r.some((p) => inBox(p.lat, p.lon)))
				.map((r) => r.map((p) => [p.lat, p.lon])),
			bbox: [loLat, loLon, hiLat, hiLon],
		}),
	);
}
void main();

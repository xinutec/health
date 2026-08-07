#!/usr/bin/env node
// Why did `anchorTrainAlightToWalkedStation` NOT extend a train whose ride tail
// is demonstrably stranded in the following walk? The pass has six guards and
// the verdict is a silent `continue` at each — this asks every one of them, at
// the coordinates a specific day actually produced, using that day's OWN OSM
// closure (no DB, no network).
//
// Usage:
//   nix develop --command node scripts/probe-alight-anchor.mjs <date> <lat> <lon> [lat2 lon2]
//     (lat/lon = the settle fix; lat2/lon2 = the surfaced fix, if given)
import { readFileSync } from "node:fs";
import { inputsFromFixture, parseCapturedDay } from "../dist/cli/fixture-day.js";
import { pickBestStation } from "../dist/geo/osm.js";
import { expandTubeLineNames, RAIL_RUN_STATION_RADIUS_M } from "../dist/geo/passes/rail-runs.js";

const [date, latS, lonS, latF, lonF] = process.argv.slice(2);
const captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-pippijn.json`, "utf8"));
const { osm } = inputsFromFixture(captured);

const show = async (label, lat, lon) => {
	const stations = await osm.nearbyStations(Number(lat), Number(lon), RAIL_RUN_STATION_RADIUS_M);
	const lines = await osm.linesAtPoint(Number(lat), Number(lon));
	console.log(`\n${label}  ${lat},${lon}`);
	console.log(`  nearbyStations(${RAIL_RUN_STATION_RADIUS_M} m): ${stations.length}`);
	for (const s of stations) console.log(`    ${JSON.stringify(s)}`);
	console.log(`  pickBestStation: ${JSON.stringify(pickBestStation(stations))}`);
	console.log(`  linesAtPoint: ${[...lines].join(" | ") || "(none)"}`);
	console.log(`  canonical:    ${[...new Set([...lines].flatMap(expandTubeLineNames))].join(" | ") || "(none)"}`);
};

await show("settle", latS, lonS);
if (latF && lonF) await show("surfaced", latF, lonF);

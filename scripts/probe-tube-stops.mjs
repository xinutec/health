#!/usr/bin/env node
// Which stations did the rider actually pass, and how long did the phone sit at
// each? The evidence that settles WHERE an underground interchange happened
// when memory cannot.
//
// A tube ride's in-tunnel fixes are sparse and poor, but the few that surface
// land at stations — and a station served by only ONE of the candidate lines is
// decisive: it proves which line was still being ridden at that moment,
// independent of anybody's recollection. Dwell length separates a stop from a
// pass-through.
//
// Prints every fix in the window against a station list, nearest first, with
// the dwell (time to the next fix more than DWELL_M away).
//
// Usage:
//   nix develop . --command node scripts/probe-tube-stops.mjs <date> <fromZ> <toZ>
import { readFileSync } from "node:fs";
import { parseCapturedDay } from "../dist/cli/fixture-day.js";

// Wembley Park → Baker Street: the Jubilee and the Metropolitan share track as
// far as Finchley Road, then diverge — the Jubilee calls at Swiss Cottage and
// St John's Wood (which the Met does not serve at all), the Met runs fast to
// Baker Street. So a fix at either of those two is a Jubilee-only fact.
const STATIONS = [
	{ name: "Wembley Park", lat: 51.5636297, lon: -0.2800532, lines: "Jubilee + Met" },
	{ name: "Neasden", lat: 51.5542, lon: -0.2503, lines: "Jubilee only" },
	{ name: "Dollis Hill", lat: 51.5521, lon: -0.2391, lines: "Jubilee only" },
	{ name: "Willesden Green", lat: 51.5492, lon: -0.2215, lines: "Jubilee only" },
	{ name: "Kilburn", lat: 51.5471, lon: -0.2047, lines: "Jubilee only" },
	{ name: "West Hampstead", lat: 51.5469, lon: -0.1906, lines: "Jubilee only" },
	{ name: "Finchley Road", lat: 51.5472, lon: -0.1803, lines: "Jubilee + Met" },
	{ name: "Swiss Cottage", lat: 51.5432, lon: -0.1738, lines: "JUBILEE ONLY" },
	{ name: "St John's Wood", lat: 51.5347, lon: -0.1739, lines: "JUBILEE ONLY" },
	{ name: "Baker Street", lat: 51.5226, lon: -0.1571, lines: "Jubilee + Met + Circle/H&C" },
	{ name: "Great Portland Street", lat: 51.5238, lon: -0.1439, lines: "Circle/H&C/Met" },
	{ name: "Euston Square", lat: 51.5258, lon: -0.1359, lines: "Circle/H&C/Met" },
];

const [date, fromZ, toZ] = process.argv.slice(2);
const t = (ts) => new Date(ts * 1000).toISOString().slice(11, 19);
const meters = (a, b) => {
	const dLat = (b.lat - a.lat) * 111_320;
	const dLon = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
	return Math.sqrt(dLat * dLat + dLon * dLon);
};

const inputs = parseCapturedDay(readFileSync(`tests/golden/days/${date}-pippijn.json`, "utf8")).inputs;
const lo = Date.parse(`${date}T${fromZ}Z`) / 1000;
const hi = Date.parse(`${date}T${toZ}Z`) / 1000;
const fixes = inputs.phonetrack.today
	.slice()
	.sort((a, b) => a.ts - b.ts)
	.filter((f) => f.ts >= lo && f.ts <= hi);

console.log(`\n=== ${date} ${fromZ}–${toZ}Z · ${fixes.length} fixes ===`);
for (let i = 0; i < fixes.length; i++) {
	const f = fixes[i];
	const near = STATIONS.map((s) => ({ s, d: meters(f, s) })).sort((a, b) => a.d - b.d)[0];
	const dwell = i + 1 < fixes.length ? fixes[i + 1].ts - f.ts : 0;
	const acc = (f.accuracy ?? 0).toFixed(0).padStart(5);
	const at = near.d <= 300 ? `${near.s.name} (${near.d.toFixed(0)} m) — ${near.s.lines}` : `— ${near.d.toFixed(0)} m from ${near.s.name}`;
	console.log(`  ${t(f.ts)}  ${acc} m  +${String(dwell).padStart(4)}s  ${at}`);
}

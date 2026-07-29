#!/usr/bin/env node
// Does a run of GPS-dark fixes end at the tunnel mouth, or does a lone
// accuracy blip drag it minutes past the alight? (#378.)
//
// `annotateUndergroundRuns` clusters dark fixes by TIME alone, so a single
// poor-accuracy fix landing inside continuous good coverage extends the ride.
// This prints the raw fix stream around a window with each fix marked dark or
// good, and — for every dark fix — how far away in time and space its nearest
// good neighbours on each side are. A blip has well-located fixes close on
// BOTH sides: GPS never went dark there, the accuracy merely wobbled.
//
// Usage:
//   nix develop . --command node scripts/probe-blip-tail.mjs <date> <fromZ> <toZ>
import { readFileSync } from "node:fs";
import { parseCapturedDay } from "../dist/cli/fixture-day.js";

const [date, fromZ, toZ] = process.argv.slice(2);
const t = (ts) => new Date(ts * 1000).toISOString().slice(11, 19);
const inputs = parseCapturedDay(readFileSync(`tests/golden/days/${date}-pippijn.json`, "utf8")).inputs;

const COARSE_ACCURACY_M = 100;
const isDark = (f) => f.accuracy != null && f.accuracy >= COARSE_ACCURACY_M;
const meters = (a, b) => {
	const dLat = (b.lat - a.lat) * 111_320;
	const dLon = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
	return Math.sqrt(dLat * dLat + dLon * dLon);
};

const lo = Date.parse(`${date}T${fromZ}Z`) / 1000;
const hi = Date.parse(`${date}T${toZ}Z`) / 1000;
const all = inputs.phonetrack.today.slice().sort((a, b) => a.ts - b.ts);
const good = all.filter((f) => !isDark(f));
const inWindow = all.filter((f) => f.ts >= lo && f.ts <= hi);

console.log(`\n=== ${date} ${fromZ}–${toZ} · ${inWindow.length} fixes ===`);
for (const f of inWindow) {
	const acc = (f.accuracy ?? 0).toFixed(0).padStart(5);
	if (!isDark(f)) {
		console.log(`  ${t(f.ts)}  ${acc} m  good`);
		continue;
	}
	const before = [...good].reverse().find((g) => g.ts < f.ts);
	const after = good.find((g) => g.ts > f.ts);
	const side = (g) => (g ? `${(f.ts - g.ts >= 0 ? f.ts - g.ts : g.ts - f.ts)}s ${meters(f, g).toFixed(0)}m` : "none");
	console.log(`  ${t(f.ts)}  ${acc} m  DARK   before ${side(before).padEnd(14)} after ${side(after)}`);
}

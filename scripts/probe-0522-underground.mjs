#!/usr/bin/env node
// Replay `annotateUndergroundRuns`' own decision path over the 05-22 evening
// ride (King's Cross St Pancras → Finchley Road, Metropolitan) so the failure
// is located rather than guessed: which host segment the GPS-dark window falls
// in, where the host's bounds CLIP that window, which fixes end up as the
// boarding and alighting ends, and what those two points resolve to.
//
// Read-only — fixture inputs only, no DB and no network.
//
// Usage: nix develop . --command node scripts/probe-0522-underground.mjs [date]
import { readFileSync } from "node:fs";
import { inputsFromFixture, parseCapturedDay } from "../dist/cli/fixture-day.js";
import { computeVelocityFromInputs } from "../dist/geo/velocity.js";
import {
	COARSE_ACCURACY_M,
	COARSE_ACCURACY_MAX_M,
	reconstructUndergroundJourney,
	UNDERGROUND_LINES_RADIUS_M,
	UNDERGROUND_STATION_RADIUS_M,
} from "../dist/geo/underground-rail.js";

const date = process.argv[2] ?? "2026-05-22";
const t = (ts) => new Date(ts * 1000).toISOString().slice(11, 19);
const MAX_COARSE_GAP_S = 300;
const MIN_COARSE_FIXES = 2;
const MIN_RUN_DURATION_S = 180;

const captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-pippijn.json`, "utf8"));
const inputs = inputsFromFixture(captured);
const osm = inputs.osm;
const stations = (lat, lon) => osm.nearbyStations(lat, lon, UNDERGROUND_STATION_RADIUS_M);
const lines = (lat, lon) => osm.linesAtPoint(lat, lon, UNDERGROUND_LINES_RADIUS_M);
const served = (line) => osm.stationsOnLine(line);

const fixes = inputs.phonetrack.today;
const isDark = (f) => f.accuracy != null && f.accuracy >= COARSE_ACCURACY_M;
const isSnappable = (f) => f.accuracy != null && f.accuracy >= COARSE_ACCURACY_M && f.accuracy <= COARSE_ACCURACY_MAX_M;
const good = fixes.filter((f) => f.accuracy == null || f.accuracy < COARSE_ACCURACY_M);

// What the pass would see with NO host clipping: the day's dark runs.
const dark = fixes.filter(isDark).sort((a, b) => a.ts - b.ts);
const dayRuns = [];
for (const f of dark) {
	const cur = dayRuns.at(-1);
	if (cur && f.ts - cur.at(-1).ts <= MAX_COARSE_GAP_S) cur.push(f);
	else dayRuns.push([f]);
}
console.log("=== the day's GPS-dark runs, UNCLIPPED ===");
for (const r of dayRuns) {
	const span = r.at(-1).ts - r[0].ts;
	const ok = r.length >= MIN_COARSE_FIXES && span >= MIN_RUN_DURATION_S ? "" : "  (below the bar)";
	console.log(`  ${t(r[0].ts)}–${t(r.at(-1).ts)}  ${r.length} dark (${r.filter(isSnappable).length} snappable), span ${span}s${ok}`);
}

// The hosts the pass actually iterates: the segment list as it stands when
// undergroundRail runs. Approximated by the finished segments — enough to show
// where the boundary falls relative to the dark window.
const { segments } = await computeVelocityFromInputs(inputsFromFixture(captured), { walkMatch: false });
const evening = segments.filter((s) => s.endTs > Date.parse(`${date}T19:00:00Z`) / 1000 && s.startTs < Date.parse(`${date}T19:30:00Z`) / 1000);
console.log("\n=== evening hosts ===");
for (const s of evening) console.log(`  ${t(s.startTs)}–${t(s.endTs)}  ${s.refinedMode ?? s.mode}`);

// Now the decision path, per host, exactly as annotateUndergroundRuns walks it.
console.log("\n=== per-host underground decision ===");
for (const host of evening) {
	console.log(`\nhost ${t(host.startTs)}–${t(host.endTs)} ${host.refinedMode ?? host.mode}`);
	if ((host.refinedMode ?? host.mode) === "stationary") {
		console.log("  skipped: stationary");
		continue;
	}
	const hostDark = fixes.filter((f) => f.ts >= host.startTs && f.ts <= host.endTs && isDark(f)).sort((a, b) => a.ts - b.ts);
	const runs = [];
	for (const f of hostDark) {
		const cur = runs.at(-1);
		if (cur && f.ts - cur.at(-1).ts <= MAX_COARSE_GAP_S) cur.push(f);
		else runs.push([f]);
	}
	const span = (r) => r.at(-1).ts - r[0].ts;
	const runFixes = runs.filter((r) => r.length >= MIN_COARSE_FIXES && span(r) >= MIN_RUN_DURATION_S).sort((a, b) => span(b) - span(a))[0];
	if (!runFixes) {
		console.log(`  no qualifying run (${runs.length} candidate run(s) inside the host)`);
		continue;
	}
	console.log(`  run ${t(runFixes[0].ts)}–${t(runFixes.at(-1).ts)}  ${runFixes.length} dark, ${runFixes.filter(isSnappable).length} snappable`);
	const boarding = [...good].reverse().find((f) => f.ts <= runFixes[0].ts);
	const alighting = good.find((f) => f.ts >= runFixes.at(-1).ts);
	console.log(`  boarding fix  ${boarding ? `${t(boarding.ts)} ${boarding.lat.toFixed(5)},${boarding.lon.toFixed(5)} acc=${boarding.accuracy}` : "(none)"}`);
	console.log(`  alighting fix ${alighting ? `${t(alighting.ts)} ${alighting.lat.toFixed(5)},${alighting.lon.toFixed(5)} acc=${alighting.accuracy}` : "(none)"}`);
	if (!boarding || !alighting) continue;
	for (const [name, f] of [["board", boarding], ["alight", alighting]]) {
		const st = await stations(f.lat, f.lon);
		const ln = await lines(f.lat, f.lon);
		console.log(`    ${name} stations: ${st.map((s) => `${s.name}@${Math.round(s.distanceM ?? -1)}m`).join(", ") || "(none)"}`);
		console.log(`    ${name} lines:    ${[...ln].join(", ") || "(none)"}`);
	}
	const midGood = good.filter((f) => f.ts > runFixes[0].ts && f.ts < runFixes.at(-1).ts);
	console.log(`  mid-run good fixes: ${midGood.length}`);
	const legs = await reconstructUndergroundJourney(runFixes, midGood, boarding, alighting, stations, lines, served);
	console.log(`  => ${legs.length} leg(s): ${legs.map((l) => `${l.boardingStation} → ${l.alightingStation} · ${l.line}`).join(" | ") || "(none)"}`);
}

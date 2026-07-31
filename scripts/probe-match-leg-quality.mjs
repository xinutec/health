#!/usr/bin/env node
/**
 * Adjudicate ONE matcher leg's float↔quant divergence on quality, not just on
 * whether the two lines differ.
 *
 * `compare-match --leg` says WHERE two arms differ and by how much. It cannot
 * say which one is BETTER, and that is the question `accepted-match-deltas.ts`
 * demands an answer to before a `coarse=DIFF` may be signed off — the manifest
 * header calls a coarse flip "a genuine decision flip" that must be inspected
 * first. This replays the named leg through both arms and scores each on the
 * four measures the two accepted coarse flips were measured on (2026-07-22):
 * drawn length, off-network distance, GPS stray p85, and metres of line falling
 * inside building footprints.
 *
 * It also reports `matchImprovesDisplay` per arm — the keep/discard gate that
 * actually consumes `coarsePath` (#369 decision parity). That is the only place
 * a coarse divergence can change something other than the drawn pixels: if the
 * two arms disagree on `use`, one of them throws the match away and the leg
 * falls back to raw GPS.
 *
 * Usage:
 *   node scripts/probe-match-leg-quality.mjs <date> <leg-fingerprint> [days-dir]
 *   node scripts/probe-match-leg-quality.mjs 2026-07-30 71e5544efa614a06 \
 *       tests/golden/adhoc-days
 *
 * `days-dir` defaults to the gated corpus. The legs worth adjudicating are the
 * ones the production ledger flags on LIVE days, which are never in the corpus —
 * capture the day somewhere else and point this at it, rather than dropping a
 * 33rd fixture into `tests/golden/days/` where every gate would enumerate it.
 */

import { readFileSync } from "node:fs";
import { buildingCrossingM } from "../dist/eval/walk-buildings.js";
import { legFingerprint } from "../dist/geo/leg-compare.js";
import {
	matchImprovesDisplay,
	maxPolylineOffRoad,
	pathLength,
	quantilePointDistToPolyline,
} from "../dist/geo/map-match-core.js";
import { qMatchWalkSegment } from "../dist/geo/match-twin.js";
import { beginWalkLegCapture, endWalkLegCapture } from "../dist/geo/pedestrian-match-annotate.js";
import { matchWalkSegment } from "../dist/geo/pedestrian-match.js";
import { quantPt } from "../dist/geo/quant-twin.js";
import { computeVelocityFromInputs } from "../dist/geo/velocity.js";
import { inputsFromFixture, parseCapturedDay } from "../dist/cli/fixture-day.js";

const [date, want, daysDir = "tests/golden/days"] = process.argv.slice(2);
if (!date || !want) {
	console.error("usage: probe-match-leg-quality.mjs <date> <leg-fingerprint> [days-dir]");
	process.exit(2);
}

// The gate's thresholds, copied from pedestrian-match-annotate.ts (module-private).
const WALK_NEEDS_MATCH_M = 18;
const WALK_MATCH_MAX_STRAY_M = 40;

const captured = parseCapturedDay(readFileSync(`${daysDir}/${date}-pippijn.json`, "utf8"));
const capture = beginWalkLegCapture();
await computeVelocityFromInputs(inputsFromFixture(captured), { walkMatch: true });
const legs = endWalkLegCapture(capture);

const leg = legs.find((l) => legFingerprint(l.clean) === want);
if (!leg) {
	console.error(`no leg ${want} on ${date} — day has ${legs.length} leg(s)`);
	process.exit(2);
}

const geo = { ways: leg.ways, buildings: leg.buildings };
const float = matchWalkSegment(leg.clean, geo);
const quantRaw = qMatchWalkSegment(
	leg.clean.map((p) => quantPt(p)),
	leg.ways.map((w) => ({ coords: w.coords.map(([lat, lon]) => quantPt({ lat, lon })), name: w.name })),
	leg.buildings.map((r) => r.map((p) => quantPt(p))),
);
const deq = (p) => ({ lat: Number(p.la) / 1e7, lon: Number(p.lo) / 1e7, ts: Number(p.ts) });
const quant = quantRaw && { path: quantRaw.path.map(deq), coarsePath: quantRaw.coarsePath.map(deq) };

const hhmm = new Date(leg.startTs * 1000).toISOString().slice(11, 16);
console.log(`leg ${want} — ${date} ${hhmm}Z`);
console.log(`${leg.clean.length} fixes, ${leg.ways.length} candidate ways, ${leg.buildings.length} buildings`);
console.log(
	`raw GPS line: ${pathLength(leg.clean).toFixed(0)} m drawn, ` +
		`${maxPolylineOffRoad(leg.clean, geo).toFixed(1)} m max off-network, ` +
		`${buildingCrossingM(leg.clean, leg.buildings).toFixed(1)} m inside buildings`,
);

for (const [arm, r] of [
	["float", float],
	["quant", quant],
]) {
	if (r === null) {
		console.log(`\n=== ${arm}: null (matcher bailed) ===`);
		continue;
	}
	console.log(`\n=== ${arm} ===`);
	for (const layer of ["coarsePath", "path"]) {
		const line = r[layer];
		console.log(
			`  ${layer.padEnd(10)} ${String(line.length).padStart(3)}v  ` +
				`len=${pathLength(line).toFixed(1)} m  ` +
				`offNet(max)=${maxPolylineOffRoad(line, geo).toFixed(1)} m  ` +
				`stray(p85)=${quantilePointDistToPolyline(leg.clean, line, 0.85).toFixed(1)} m  ` +
				`inBuildings=${buildingCrossingM(line, leg.buildings).toFixed(1)} m`,
		);
	}
	// The served decision: coarsePath is what the gate reads (#369).
	const d = matchImprovesDisplay(leg.clean, r.coarsePath, geo, WALK_NEEDS_MATCH_M, WALK_MATCH_MAX_STRAY_M);
	console.log(
		`  DECISION use=${d.use}  (rawOff=${d.rawOffRoadM.toFixed(1)} > ${WALK_NEEDS_MATCH_M}? ` +
			`matchedOff=${d.matchedOffRoadM.toFixed(1)} < rawOff? stray=${d.strayM.toFixed(1)} <= ${WALK_MATCH_MAX_STRAY_M}?)`,
	);
}

// Where the coarse lines part company, and on which named way each arm sits.
if (float !== null && quant !== null) {
	const nameAt = (p) => {
		let best = null;
		let bestD = Infinity;
		for (const w of leg.ways) {
			for (let i = 1; i < w.coords.length; i++) {
				const [alat, alon] = w.coords[i - 1];
				const [blat, blon] = w.coords[i];
				const d = quantilePointDistToPolyline([p], [{ lat: alat, lon: alon }, { lat: blat, lon: blon }], 1);
				if (d < bestD) {
					bestD = d;
					best = w.name ?? "(unnamed)";
				}
			}
		}
		return `${best} @${bestD.toFixed(1)}m`;
	};
	console.log(`\n=== coarse vertices where the arms differ ===`);
	const n = Math.min(float.coarsePath.length, quant.coarsePath.length);
	for (let i = 0; i < n; i++) {
		const a = float.coarsePath[i];
		const b = quant.coarsePath[i];
		const qa = quantPt(a);
		const qb = quantPt(b);
		if (qa.la === qb.la && qa.lo === qb.lo && qa.ts === qb.ts) continue;
		console.log(`  [${i}] float ${a.lat.toFixed(6)},${a.lon.toFixed(6)} on ${nameAt(a)}`);
		console.log(`      quant ${b.lat.toFixed(6)},${b.lon.toFixed(6)} on ${nameAt(b)}`);
		console.log(`      Δts=${Number(qa.ts - qb.ts)}s`);
	}
}

/**
 * CLI: show WHY a day's leg is physically impossible, fix by fix.
 *
 * `golden-check` reports the verdict — "walking leg sustains a vehicle-paced
 * run: 324 m net over 2 consecutive fast steps (peak 99 km/h)" — which says a
 * violation exists but not where it came from. Attribution needs the run
 * itself: which fixes, how far apart in time and space, what the leg looks like
 * either side of it, and whether the burst is one teleport or sustained travel.
 *
 * A 99 km/h "walk" is one of a small number of things, and the fix differs for
 * each: a GPS reacquire hop after a blackout (a single huge step across a time
 * gap), a ride tail stranded inside a walk by a mis-placed segment boundary
 * (several fast steps at even spacing), or a Kalman artefact (fast steps that
 * go nowhere net). This prints what separates them.
 *
 * Pure replay against the fixture's own OSM trace — zero DB, zero Overpass.
 *
 *   node dist/cli/diag-infeasible-leg.js 2026-08-05
 *   node dist/cli/diag-infeasible-leg.js            # every golden day
 */
import { readdirSync, readFileSync } from "node:fs";
import { checkWorldlineFeasibility } from "../eval/worldline-feasibility.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

const USER = "pippijn";

function goldenDays(): string[] {
	return readdirSync("tests/golden/days")
		.map((f) => f.match(/^(\d{4}-\d{2}-\d{2})-pippijn\.json$/)?.[1])
		.filter((d): d is string => d !== undefined)
		.sort();
}

const iso = (t: number) => new Date(t * 1000).toISOString().slice(11, 19);

function metresBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
	const dLat = (b.lat - a.lat) * 111_320;
	const dLon = (b.lon - a.lon) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

async function main(): Promise<void> {
	const days = process.argv.slice(2).length > 0 ? process.argv.slice(2) : goldenDays();

	for (const date of days) {
		let captured: ReturnType<typeof parseCapturedDay>;
		try {
			captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-${USER}.json`, "utf8"));
		} catch {
			continue;
		}
		const inputs = inputsFromFixture(captured);
		let result: Awaited<ReturnType<typeof computeVelocityFromInputs>>;
		try {
			result = await computeVelocityFromInputs(inputs);
		} catch (e) {
			console.log(`${date}  NOT REPLAYED: ${e instanceof Error ? e.message : "non-Error throw"}`);
			continue;
		}
		const lineStations = new Map(Object.entries(captured.inputs.osmTrace.stationsOnLine ?? {}));
		const violations = checkWorldlineFeasibility(result.states, result.points, inputs.biometrics.steps, lineStations);
		if (violations.length === 0) continue;

		console.log(`\n=== ${date} — ${violations.length} violation(s) ===`);
		for (const v of violations) {
			console.log(`\n  ${v.kind}  ${iso(v.startTs)}Z → ${iso(v.endTs)}Z`);
			console.log(`  ${v.detail}`);

			// The leg as the timeline shows it, plus its neighbours: a stranded
			// ride tail is obvious from what precedes the walk.
			const idx = result.states.findIndex((s) => s.startTs === v.startTs && s.endTs === v.endTs);
			for (let k = Math.max(0, idx - 1); k <= Math.min(result.states.length - 1, idx + 1); k++) {
				const s = result.states[k];
				if (!s) continue;
				const mark = k === idx ? "→" : " ";
				console.log(
					`   ${mark} ${iso(s.startTs)}–${iso(s.endTs)}  ${String(s.mode).padEnd(10)}` +
						`${s.place ? ` place=${s.place}` : ""}${s.wayName ? ` way=${s.wayName}` : ""}`,
				);
			}

			// Every fix inside the leg, with per-step distance / gap / speed. The
			// shape of the burst is the attribution: one huge step across a long
			// dt is a reacquire teleport; several even fast steps is real travel
			// the segmenter put in the wrong leg.
			const fixes = result.points.filter((p) => p.ts >= v.startTs && p.ts <= v.endTs);
			console.log(`    ${fixes.length} fix(es):`);
			for (let i = 0; i < fixes.length; i++) {
				const p = fixes[i];
				const prev = fixes[i - 1];
				const dt = prev ? p.ts - prev.ts : 0;
				const dm = prev ? metresBetween(prev, p) : 0;
				const kmh = dt > 0 ? (dm / dt) * 3.6 : 0;
				const flag = kmh >= 15 ? "  ⚡FAST" : "";
				console.log(
					`      ${iso(p.ts)}Z  ${p.lat.toFixed(6)},${p.lon.toFixed(6)}  ` +
						`+${String(Math.round(dt)).padStart(4)}s  ${Math.round(dm).toString().padStart(5)}m  ` +
						`${kmh.toFixed(1).padStart(6)} km/h${flag}`,
				);
			}
		}
	}
}

void main();

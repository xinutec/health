/**
 * CLI: render the pedestrian walk-match visual diff (#293).
 *
 * Replays each captured golden fixture with the walk-matcher ON, and for every
 * walking episode draws the RAW GPS fixes against the MATCHED line (and the
 * smoothed reference) as a grid of SVG panels — so an out-and-back spur is
 * visible by eye, and walks can be labelled good/bad to build ground truth.
 * Pure replay (no DB / Overpass), like score-walk-match.
 *
 *   node dist/cli/render-walk-match.js [out.svg] [YYYY-MM-DD ...]
 *     out.svg  — output path (default walk-match-diff.svg)
 *     dates    — limit to these days (default: every golden day)
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { maxCorridorStall, renderWalkGrid, type WalkPanel } from "../eval/walk-render.js";
import type { LatLon } from "../eval/walk-score.js";
import { FixtureOsmAdapter } from "../geo/osm-adapter-fixture.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { countSharpTurns, refineMatchedPath, type WalkFix } from "../geo/walk-smooth-map.js";
import { inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

const ll = (p: { lat: number; lon: number }): LatLon => ({ lat: p.lat, lon: p.lon });
const hhmm = (ts: number): string => new Date(ts * 1000).toISOString().slice(11, 16);

async function panelsForDay(date: string, user: string): Promise<WalkPanel[]> {
	const captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-${user}.json`, "utf8"));
	const base = inputsFromFixture(captured);
	const on = await computeVelocityFromInputs(
		{ ...base, osm: new FixtureOsmAdapter(captured.inputs.osmTrace) },
		{ walkMatch: true },
	);
	const off = await computeVelocityFromInputs(
		{ ...base, osm: new FixtureOsmAdapter(captured.inputs.osmTrace) },
		{ walkMatch: false },
	);
	const panels: WalkPanel[] = [];
	for (let i = 0; i < on.episodes.length; i++) {
		const e = on.episodes[i];
		if (e.mode !== "walking" || e.points.length < 2) continue;
		const t0 = e.points[0].ts ?? 0;
		const t1 = e.points[e.points.length - 1].ts ?? 0;
		const raw = on.rawFixes.filter((f) => f.ts >= t0 && f.ts <= t1).map(ll);
		if (raw.length < 3) continue;
		const matched = e.points.map(ll);
		const smoothed = (off.episodes[i]?.points ?? []).map(ll);
		// The Phase-1 refinement, gated: only shown when it actually de-boxes.
		const rawWalk: WalkFix[] = on.rawFixes
			.filter((f) => f.ts >= t0 && f.ts <= t1)
			.map((f) => ({ lat: f.lat, lon: f.lon, ts: f.ts, accuracyM: f.accuracy ?? undefined }));
		const refinedRaw = refineMatchedPath(rawWalk, matched);
		const refined =
			refinedRaw && countSharpTurns(refinedRaw.map(ll)) < countSharpTurns(matched) ? refinedRaw.map(ll) : undefined;
		panels.push({
			label: `${date} ${hhmm(t0)}`,
			raw,
			matched,
			smoothed,
			refined,
			stallM: maxCorridorStall(raw, matched),
		});
	}
	return panels;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const out = args.find((a) => a.endsWith(".svg")) ?? "walk-match-diff.svg";
	const dateArgs = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
	const user = "pippijn";
	const dates =
		dateArgs.length > 0
			? dateArgs
			: readdirSync("tests/golden/days")
					.filter((f) => f.endsWith(`-${user}.json`))
					.map((f) => f.replace(`-${user}.json`, ""))
					.sort();

	const panels: WalkPanel[] = [];
	for (const date of dates) {
		try {
			panels.push(...(await panelsForDay(date, user)));
		} catch (e) {
			console.error(`${date}: ${(e as Error).message}`);
		}
	}
	// Optional stall-band filter (env) to focus a legible subset on the
	// spur-suspect range, excluding the huge gap-fill diagonals and the clean
	// low-stall walks.
	const lo = Number(process.env.WALK_MIN_STALL ?? 0);
	const hi = Number(process.env.WALK_MAX_STALL ?? Number.POSITIVE_INFINITY);
	const shown = panels.filter((p) => p.stallM >= lo && p.stallM <= hi);
	writeFileSync(out, renderWalkGrid(shown));
	const worst = [...panels].sort((a, b) => b.stallM - a.stallM).slice(0, 8);
	console.log(`Rendered ${panels.length} walks → ${out}`);
	console.log("worst corridor-stall:");
	for (const p of worst) console.log(`  ${p.stallM.toFixed(0).padStart(4)}m  ${p.label}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

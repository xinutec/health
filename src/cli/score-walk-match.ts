/**
 * CLI: the deterministic referee for pedestrian map-matching
 * (`docs/proposals/geometry-roadmap.md`, #265/#271).
 *
 * Replays a captured golden fixture TWICE through the pure pipeline — once with
 * the walk-matcher off (`walkMatch:false` → walks resolve to the smoother) and
 * once on (the matched line where the gate fires) — and, per walking episode,
 * reports the off-walkable p90 of the drawn line in each arm. A walk is an
 * IMPROVEMENT when the candidate p90 drops, a REGRESSION when it rises, and
 * NEUTRAL when the matcher bailed (the line is unchanged).
 *
 * Zero DB, zero Overpass: the off-walkable distance is measured against the
 * fixture's own flattened `walkableRoads` trace, so no new OSM query is issued
 * and the verdict is a pure-function replay.
 *
 *   node dist/cli/score-walk-match.js              # sweep every golden day
 *   node dist/cli/score-walk-match.js 2026-06-24   # one day (pippijn)
 *   node dist/cli/score-walk-match.js --bless      # record the current metrics
 *                                                  # as the ratchet floor
 *
 * Exit code: with a blessed `tests/golden/walk-baseline.json` present, the
 * RATCHET is the gate — exit 1 only when a walk got worse than its recorded
 * floor (standing defects stay recorded and can only shrink; see
 * `eval/walk-gate.ts`). Without a baseline, falls back to the raw A/B exit.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isEnforceableTruth, parseGroundTruth } from "../eval/ground-truth.js";
import { buildingCrossingM, offPathBuildingCrossingM } from "../eval/walk-buildings.js";
import { gateWalks, WALK_SPEED_CEIL_KMH, type WalkBaseline, type WalkBaselineEntry } from "../eval/walk-gate.js";
import { walkPlausibility } from "../eval/walk-plausibility.js";
import { onNamedWayFraction } from "../eval/walk-route-correctness.js";
import { stepsInWindow } from "../geo/biometrics.js";
import { FixtureOsmAdapter } from "../geo/osm-adapter-fixture.js";
import type { BuildingFootprint } from "../geo/osm-local.js";
import type { OsmRoadWay, RoadGeometry } from "../geo/road-match.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import {
	countSharpTurns,
	DEFAULT_RECONSTRUCT_PROFILE,
	type MapSmoothProfile,
	REFINE_MATCHED_PROFILE,
	refineMatchedPath,
	type WalkFix,
} from "../geo/walk-smooth-map.js";
import { type CapturedDay, inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

/** Refine profile with env overrides, so the σ balance can be swept without a
 *  rebuild: REFINE_SMOOTH_SIGMA / REFINE_NET_SIGMA / REFINE_GPS_SIGMA (metres). */
function refineProfileFromEnv(): MapSmoothProfile {
	const num = (v: string | undefined, d: number) => (v ? Number(v) : d);
	return {
		...REFINE_MATCHED_PROFILE,
		gpsSigmaFallbackM: num(process.env.REFINE_GPS_SIGMA, REFINE_MATCHED_PROFILE.gpsSigmaFallbackM),
		smoothSigmaM: num(process.env.REFINE_SMOOTH_SIGMA, REFINE_MATCHED_PROFILE.smoothSigmaM),
		networkSigmaM: num(process.env.REFINE_NET_SIGMA, REFINE_MATCHED_PROFILE.networkSigmaM),
	};
}
const REFINE_PROFILE = refineProfileFromEnv();

/** A confirmed street name and the window it applies to, from the day's
 *  ground-truth narrative — only enforceable "walking on <way>" rows. This is
 *  the truth signal the geometric proxies lack: it names the street a leg ran
 *  along, so the drawn line can be scored by NAME, not geometry. */
interface NamedWalkWindow {
	startTs: number;
	endTs: number;
	name: string;
}

/** Load the enforceable named walk windows for a day, or [] when the day has no
 *  ground-truth file or no confirmed street-named walk rows. */
function loadNamedWalkWindows(date: string, tz: string): NamedWalkWindow[] {
	const path = `tests/golden/ground-truth/${date}.md`;
	if (!existsSync(path)) return [];
	const gt = parseGroundTruth(readFileSync(path, "utf8"), date, tz);
	const out: NamedWalkWindow[] = [];
	for (const row of gt.rows) {
		if (row.truth?.mode !== "walking" || !row.truth.wayName) continue;
		if (!isEnforceableTruth(row)) continue;
		out.push({ startTs: row.startTs, endTs: row.endTs, name: row.truth.wayName });
	}
	return out;
}

/** Accepted street names for an episode: the names of every named walk window
 *  that overlaps the episode's time span. Empty when the day's narrative names
 *  no street over this leg (→ route-correctness is left null, not scored). */
function acceptedNamesForEpisode(windows: readonly NamedWalkWindow[], startTs: number, endTs: number): Set<string> {
	const names = new Set<string>();
	for (const w of windows) if (w.endTs > startTs && w.startTs < endTs) names.add(w.name);
	return names;
}

/** Every walkable way anywhere in the captured trace — the universe the drawn
 *  line is scored against, flattened across all query keys. `undefined` section
 *  = fixture captured before the walkable field; treat as "no walkable data"
 *  (no matching possible). */
function allWalkable(captured: CapturedDay): OsmRoadWay[] {
	const section = captured.inputs.osmTrace.walkableRoads;
	if (section === undefined) return [];
	const out: OsmRoadWay[] = [];
	for (const ways of Object.values(section)) out.push(...ways);
	return out;
}

/** Every building footprint anywhere in the captured trace — the impassable
 *  layer the building-crossing metric scores against, flattened across all query
 *  keys. `undefined` section = fixture captured before the buildings field →
 *  "no building data" (the metric is left null, not scored as 0). */
function allBuildings(captured: CapturedDay): BuildingFootprint[] {
	const section = captured.inputs.osmTrace.buildingsNear;
	if (section === undefined) return [];
	const out: BuildingFootprint[] = [];
	for (const rings of Object.values(section)) out.push(...rings);
	return out;
}

function hhmm(ts: number): string {
	return new Date(ts * 1000).toISOString().slice(11, 16);
}

interface WalkVerdict {
	date: string;
	startTs: number;
	baselineKind: string;
	candidateKind: string;
	baselineP90: number | null;
	candidateP90: number | null;
	/** Raw-vs-matched over-route metric on the drawn candidate line (m). */
	candidateStallM: number;
	/** Mean walking speed the drawn candidate line implies (km/h). Flags the
	 *  underground/indoor teleport class the off-walkable p90 is blind to. */
	candidateSpeedKmh: number;
	/** Truth-anchored route-correctness: fraction of the drawn line running along
	 *  the ground-truth-confirmed street, baseline vs candidate. null when the
	 *  day's narrative names no street over this leg. A drop from baseline→candidate
	 *  is the invented-detour signal off-walkable-p90 rewards. */
	baselineRouteCorr: number | null;
	candidateRouteCorr: number | null;
	/** Sharp-turn (~90° staircase) count of the CURRENT drawn line — the de-boxing
	 *  witness off-walkable is blind to. */
	candidateSharpTurns: number;
	/** Building-crossing length (m) of the drawn line — the raw superset measure.
	 *  baseline (smoother) vs candidate (matched). null when the fixture carries
	 *  no building data. */
	baselineBuildingM: number | null;
	candidateBuildingM: number | null;
	/** TRUE-DEFECT lens: crossing length while OFF every walkable way. A line
	 *  riding a mapped through-building footway (arcade, station concourse) is a
	 *  legitimate passage and reads 0 here; a chord through a house reads full. */
	baselineOffPathM: number | null;
	candidateOffPathM: number | null;
	/** The matched-line REFINEMENT arm (Phase 1, both-staged) — the continuous
	 *  smoother run over the matched line as its own corridor, rounding the boxy
	 *  corners toward the raw GPS. null when it bailed. Its off-walkable p90,
	 *  stall, route-correctness, and sharp-turn count for the head-to-head. */
	refineP90: number | null;
	refineStallM: number | null;
	refineRouteCorr: number | null;
	refineSharpTurns: number | null;
	refineBuildingM: number | null;
	/** The from-scratch SMOOTHER-PRIMARY arm (true-path Phase 1): the continuous
	 *  MAP smoother run over the raw accuracy-weighted fixes + the whole walkable
	 *  network, as the DRAW (not a refinement of the matched line). This is the
	 *  candidate replacement for the Viterbi matcher — measured here before wiring. */
	smootherP90: number | null;
	smootherStallM: number | null;
	smootherRouteCorr: number | null;
	smootherSharpTurns: number | null;
	smootherBuildingM: number | null;
	smootherOffPathM: number | null;
	/** Step-budget consistency (#320, geometry-roadmap G0): the leg's pedometer
	 *  displacement budget (steps × stride, no slack) against each arm's drawn
	 *  length. The corridor metrics are blind to a coherent smear — they reward
	 *  agreement with the very fixes the pedometer contradicts — so a drawn
	 *  length far above the budget is the honest phantom witness. null budget =
	 *  no step data for the day. */
	stepBudgetM: number | null;
	candidateLenM: number;
	smootherLenM: number | null;
}

/** How far the candidate's route-correctness may fall below baseline before it
 *  counts as a route regression — i.e. the candidate drew a meaningfully larger
 *  share of the line onto a street the ground truth does not confirm. */
const ROUTE_CORR_EPS = 0.1;

/** A route regression: the candidate moved > `ROUTE_CORR_EPS` of the drawn line
 *  off the confirmed street(s). The invented-detour class caught by NAME. */
function routeRegressed(v: WalkVerdict): boolean {
	if (v.baselineRouteCorr === null || v.candidateRouteCorr === null) return false;
	return v.candidateRouteCorr < v.baselineRouteCorr - ROUTE_CORR_EPS;
}

/** The ratchet floor lives beside the (gitignored) fixtures it describes. */
const WALK_BASELINE_PATH = "tests/golden/walk-baseline.json";

/** Project a run's verdicts into the ratchet-baseline shape. */
function toBaseline(verdicts: readonly WalkVerdict[]): WalkBaseline {
	const out: WalkBaseline = {};
	for (const v of verdicts) {
		const entry: WalkBaselineEntry = {
			startTs: v.startTs,
			p90M: v.candidateP90,
			stallM: v.candidateStallM,
			speedKmh: v.candidateSpeedKmh,
			routeCorr: v.candidateRouteCorr,
			offPathM: v.candidateOffPathM,
			lenM: v.candidateLenM,
			budgetM: v.stepBudgetM,
		};
		if (!out[v.date]) out[v.date] = [];
		out[v.date].push(entry);
	}
	return out;
}

async function scoreDay(date: string, user: string): Promise<WalkVerdict[]> {
	const captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-${user}.json`, "utf8"));
	const walkable: RoadGeometry = { ways: allWalkable(captured) };
	const buildings = allBuildings(captured);
	// "Has building data" means actual footprint geometry, not an empty stub. The
	// live pipeline does not query buildingsNear, so today every fixture's section
	// is present-but-empty — the metric is left null (honestly "unmeasured"), NOT
	// reported as a clean 0, until building geometry is captured.
	const hasBuildings = buildings.length > 0;
	const crossM = (pts: readonly { lat: number; lon: number }[]): number | null =>
		hasBuildings ? buildingCrossingM(pts, buildings) : null;
	const offPathM = (pts: readonly { lat: number; lon: number }[]): number | null =>
		hasBuildings ? offPathBuildingCrossingM(pts, buildings, walkable) : null;
	const namedWindows = loadNamedWalkWindows(date, captured.meta.tz);
	const base = inputsFromFixture(captured);

	// Fresh adapter per arm (stateless, but explicit).
	const offInputs = { ...base, osm: new FixtureOsmAdapter(captured.inputs.osmTrace) };
	const onInputs = { ...base, osm: new FixtureOsmAdapter(captured.inputs.osmTrace) };
	const reconInputs = { ...base, osm: new FixtureOsmAdapter(captured.inputs.osmTrace) };
	const off = await computeVelocityFromInputs(offInputs, { walkMatch: false });
	const on = await computeVelocityFromInputs(onInputs, { walkMatch: true });
	// The SMOOTHER-PRIMARY arm as the PIPELINE would ship it (#330): the same
	// walkMatch pass with `walkDraw: "recon"` — reconstructWalk (cleaned fixes,
	// endpoint anchors, pedometer budget) as the draw, raw fallback when it
	// bails. Replaying through the pipeline (not a hand-rolled call here) keeps
	// the referee input-identical to prod: an earlier in-referee arm fed the
	// smoother UNFILTERED raw fixes — no speed cap, no rejectSpikes — and
	// charged it for teleport spikes prod never shows it.
	const reconRun = await computeVelocityFromInputs(reconInputs, { walkMatch: true, walkDraw: "recon" });

	// walkMatch only changes drawn geometry, not segmentation, so the episode
	// lists align by index. Score only walking legs with a drawable line.
	const verdicts: WalkVerdict[] = [];
	for (let i = 0; i < on.episodes.length; i++) {
		const onE = on.episodes[i];
		const offE = off.episodes[i];
		if (onE.mode !== "walking" || onE.points.length < 2) continue;
		// The raw GPS corridor the drawn line is measured against — needed for the
		// over-route (corridor-stall) witness `scoreWalk` alone cannot see.
		const raw = on.rawFixes
			.filter((f) => f.ts >= onE.startTs && f.ts <= onE.endTs)
			.map((f) => ({ lat: f.lat, lon: f.lon }));
		const candidate = walkPlausibility(
			raw,
			onE.points.map((p) => ({ lat: p.lat, lon: p.lon })),
			onE.startTs,
			onE.endTs,
			[],
			walkable,
		);
		const baseline =
			offE && offE.points.length >= 2
				? walkPlausibility(
						raw,
						offE.points.map((p) => ({ lat: p.lat, lon: p.lon })),
						offE.startTs,
						offE.endTs,
						[],
						walkable,
					)
				: null;
		const accepted = acceptedNamesForEpisode(namedWindows, onE.startTs, onE.endTs);
		const candidateRouteCorr =
			accepted.size > 0
				? onNamedWayFraction(
						onE.points.map((p) => ({ lat: p.lat, lon: p.lon })),
						accepted,
						walkable,
					)
				: null;
		const baselineRouteCorr =
			accepted.size > 0 && offE && offE.points.length >= 2
				? onNamedWayFraction(
						offE.points.map((p) => ({ lat: p.lat, lon: p.lon })),
						accepted,
						walkable,
					)
				: null;

		// The matched-line REFINEMENT arm — round the current matched line toward
		// the raw GPS, using the matched line as its own corridor. Measures the
		// Phase-1 algorithm directly, independent of pipeline wiring.
		const rawWalk: WalkFix[] = on.rawFixes
			.filter((f) => f.ts >= onE.startTs && f.ts <= onE.endTs)
			.map((f) => ({ lat: f.lat, lon: f.lon, ts: f.ts, accuracyM: f.accuracy ?? undefined }));
		const candidatePoints = onE.points.map((p) => ({ lat: p.lat, lon: p.lon }));
		const refined = refineMatchedPath(rawWalk, candidatePoints, REFINE_PROFILE);
		const refine = refined
			? walkPlausibility(
					raw,
					refined.map((p) => ({ lat: p.lat, lon: p.lon })),
					onE.startTs,
					onE.endTs,
					[],
					walkable,
				)
			: null;
		const refineRouteCorr =
			refined && accepted.size > 0
				? onNamedWayFraction(
						refined.map((p) => ({ lat: p.lat, lon: p.lon })),
						accepted,
						walkable,
					)
				: null;

		// The SMOOTHER-PRIMARY arm, read from the pipeline replay above: the leg as
		// `walkDraw: "recon"` would draw it — reconstructWalk over the SAME cleaned
		// fixes (speed cap + rejectSpikes), disc-read network, endpoint anchors and
		// pedometer budget as prod, with the honest raw fallback when it bails.
		// The episode lists align by index (walkMatch changes geometry, never
		// segmentation).
		const stepsWalked = stepsInWindow(base.biometrics.steps, onE.startTs, onE.endTs);
		const reconE = reconRun.episodes[i];
		const smoothPts =
			reconE && reconE.points.length >= 2 ? reconE.points.map((p) => ({ lat: p.lat, lon: p.lon })) : null;
		const smootherPlaus =
			smoothPts && smoothPts.length >= 2
				? walkPlausibility(raw, smoothPts, onE.startTs, onE.endTs, [], walkable)
				: null;
		const smootherRouteCorr = smoothPts && accepted.size > 0 ? onNamedWayFraction(smoothPts, accepted, walkable) : null;

		verdicts.push({
			date,
			startTs: onE.startTs,
			baselineKind: offE?.kind ?? "(none)",
			candidateKind: onE.kind,
			baselineP90: baseline?.offWalkableP90M ?? null,
			candidateP90: candidate.offWalkableP90M,
			candidateStallM: candidate.corridorStallM,
			candidateSpeedKmh: candidate.avgDrawnSpeedKmh,
			baselineRouteCorr,
			candidateRouteCorr,
			candidateSharpTurns: countSharpTurns(candidatePoints),
			baselineBuildingM: offE && offE.points.length >= 2 ? crossM(offE.points) : null,
			candidateBuildingM: crossM(candidatePoints),
			baselineOffPathM: offE && offE.points.length >= 2 ? offPathM(offE.points) : null,
			candidateOffPathM: offPathM(candidatePoints),
			refineP90: refine?.offWalkableP90M ?? null,
			refineStallM: refine?.corridorStallM ?? null,
			refineRouteCorr,
			refineSharpTurns: refined ? countSharpTurns(refined.map((p) => ({ lat: p.lat, lon: p.lon }))) : null,
			refineBuildingM: refined ? crossM(refined.map((p) => ({ lat: p.lat, lon: p.lon }))) : null,
			smootherP90: smootherPlaus?.offWalkableP90M ?? null,
			smootherStallM: smootherPlaus?.corridorStallM ?? null,
			smootherRouteCorr,
			smootherSharpTurns: smoothPts ? countSharpTurns(smoothPts) : null,
			smootherBuildingM: smoothPts ? crossM(smoothPts) : null,
			smootherOffPathM: smoothPts ? offPathM(smoothPts) : null,
			stepBudgetM: stepsWalked !== null ? stepsWalked * DEFAULT_RECONSTRUCT_PROFILE.stepStrideM : null,
			candidateLenM: candidate.drawnLengthM,
			smootherLenM: smootherPlaus?.drawnLengthM ?? null,
		});
	}
	return verdicts;
}

function classify(v: WalkVerdict): "improved" | "regressed" | "neutral" | "n/a" {
	if (v.baselineP90 === null || v.candidateP90 === null) return "n/a";
	const delta = v.candidateP90 - v.baselineP90;
	if (delta < -0.5) return "improved";
	if (delta > 0.5) return "regressed";
	return "neutral";
}

async function main(): Promise<void> {
	const user = "pippijn";
	const args = process.argv.slice(2);
	const bless = args.includes("--bless");
	const arg = args.find((a) => !a.startsWith("--"));
	const dates = arg
		? [arg]
		: readdirSync("tests/golden/days")
				.filter((f) => f.endsWith(`-${user}.json`))
				.map((f) => f.slice(0, 10))
				.sort();

	const all: WalkVerdict[] = [];
	for (const date of dates) {
		const verdicts = await scoreDay(date, user);
		all.push(...verdicts);
		if (verdicts.length === 0) {
			console.log(`${date}: no walking legs`);
			continue;
		}
		console.log(`${date}: ${verdicts.length} walk(s)`);
		for (const v of verdicts) {
			const tag = classify(v).toUpperCase().padEnd(9);
			const b = v.baselineP90 === null ? "  -" : `${v.baselineP90.toFixed(0).padStart(3)}m`;
			const c = v.candidateP90 === null ? "  -" : `${v.candidateP90.toFixed(0).padStart(3)}m`;
			const stallFlag = v.candidateStallM >= 80 ? " ⚠over-route" : "";
			const spd = v.candidateSpeedKmh;
			const spdFlag = spd > WALK_SPEED_CEIL_KMH ? " ⚠impossible-walk" : "";
			const route =
				v.baselineRouteCorr === null || v.candidateRouteCorr === null
					? ""
					: `  route ${(v.baselineRouteCorr * 100).toFixed(0)}%→${(v.candidateRouteCorr * 100).toFixed(0)}%${routeRegressed(v) ? " ⚠route-regress" : ""}`;
			const bldg =
				v.candidateBuildingM === null
					? ""
					: `  bldg ${(v.baselineBuildingM ?? 0).toFixed(0)}→${v.candidateBuildingM.toFixed(0)}m` +
						`  offPath ${(v.baselineOffPathM ?? 0).toFixed(0)}→${(v.candidateOffPathM ?? 0).toFixed(0)}m${(v.candidateOffPathM ?? 0) >= 5 ? " ⚠crosses-building" : ""}`;
			// Step-budget consistency (#320): drawn length vs the pedometer budget.
			// The one witness a coherent smear cannot fool — flag when the drawn
			// line is more than the reconstruction's slack over the budget.
			const budget =
				v.stepBudgetM === null
					? ""
					: `  len ${v.candidateLenM.toFixed(0)}m/budget ${v.stepBudgetM.toFixed(0)}m${v.candidateLenM > v.stepBudgetM * DEFAULT_RECONSTRUCT_PROFILE.stepSlackRatio ? " ⚠over-budget" : ""}`;
			console.log(
				`  ${tag} @${hhmm(v.startTs)}Z  offWalkP90 ${b} → ${c}  stall ${v.candidateStallM.toFixed(0).padStart(4)}m${stallFlag}  ${spd.toFixed(1).padStart(5)}km/h${spdFlag}${route}${bldg}${budget}   (${v.baselineKind} → ${v.candidateKind})`,
			);
			if (v.refineP90 !== null) {
				const sp90 = `${v.refineP90.toFixed(0).padStart(3)}m`;
				const sroute =
					v.refineRouteCorr === null || v.candidateRouteCorr === null
						? ""
						: `  route ${(v.candidateRouteCorr * 100).toFixed(0)}%→${(v.refineRouteCorr * 100).toFixed(0)}%`;
				console.log(
					`      └ MAP-refine  offWalkP90 ${sp90}  stall ${(v.refineStallM ?? 0).toFixed(0).padStart(4)}m  turns ${v.candidateSharpTurns}→${v.refineSharpTurns ?? "-"}${sroute}`,
				);
			}
			if (v.smootherP90 !== null) {
				const gp90 = `${v.smootherP90.toFixed(0).padStart(3)}m`;
				const groute =
					v.smootherRouteCorr === null || v.candidateRouteCorr === null
						? ""
						: `  route ${(v.candidateRouteCorr * 100).toFixed(0)}%→${(v.smootherRouteCorr * 100).toFixed(0)}%${v.smootherRouteCorr > (v.candidateRouteCorr ?? 0) + 0.05 ? " ✓" : ""}`;
				const goff =
					v.smootherOffPathM === null
						? ""
						: `  offPath ${(v.candidateOffPathM ?? 0).toFixed(0)}→${v.smootherOffPathM.toFixed(0)}m`;
				const glen = v.smootherLenM === null ? "" : `  len ${v.candidateLenM.toFixed(0)}→${v.smootherLenM.toFixed(0)}m`;
				console.log(
					`      └ SMOOTHER    offWalkP90 ${gp90}  stall ${(v.smootherStallM ?? 0).toFixed(0).padStart(4)}m  turns ${v.candidateSharpTurns}→${v.smootherSharpTurns ?? "-"}${groute}${goff}${glen}`,
				);
			}
		}
	}

	const improved = all.filter((v) => classify(v) === "improved").length;
	const regressed = all.filter((v) => classify(v) === "regressed").length;
	const neutral = all.filter((v) => classify(v) === "neutral" || classify(v) === "n/a").length;
	const impossible = all.filter((v) => v.candidateSpeedKmh > WALK_SPEED_CEIL_KMH);
	console.log(`\nSUMMARY: ${all.length} walks — improved ${improved}, regressed ${regressed}, neutral ${neutral}`);
	console.log(
		`PLAUSIBILITY: ${impossible.length} walk(s) drawn above ${WALK_SPEED_CEIL_KMH} km/h (implausible on foot)`,
	);
	for (const v of impossible.sort((a, b) => b.candidateSpeedKmh - a.candidateSpeedKmh)) {
		console.log(`  ${v.date} @${hhmm(v.startTs)}Z  ${v.candidateSpeedKmh.toFixed(1)} km/h  (${v.candidateKind})`);
	}
	if (regressed > 0) {
		console.log("REGRESSIONS:");
		for (const v of all.filter((x) => classify(x) === "regressed")) {
			console.log(`  ${v.date} @${hhmm(v.startTs)}Z  ${v.baselineP90?.toFixed(0)}m → ${v.candidateP90?.toFixed(0)}m`);
		}
	}
	// Truth-anchored route-correctness — the honest gate the off-walkable proxy
	// cannot be. Reported over the legs the narratives name a street for.
	const routed = all.filter((v) => v.candidateRouteCorr !== null);
	const routeRegressions = all.filter(routeRegressed);
	const meanRouteCorr =
		routed.length > 0 ? routed.reduce((s, v) => s + (v.candidateRouteCorr ?? 0), 0) / routed.length : null;
	console.log(
		`ROUTE-CORRECTNESS: ${routed.length} walk(s) with a named-street truth; mean on-street ${
			meanRouteCorr === null ? "n/a" : `${(meanRouteCorr * 100).toFixed(0)}%`
		}; route-regressed ${routeRegressions.length}`,
	);
	for (const v of routeRegressions) {
		console.log(
			`  ${v.date} @${hhmm(v.startTs)}Z  ${((v.baselineRouteCorr ?? 0) * 100).toFixed(0)}% → ${((v.candidateRouteCorr ?? 0) * 100).toFixed(0)}% on confirmed street`,
		);
	}

	// Building-crossing — the headline defect off-walkable-p90 is blind to. The
	// TRUE-DEFECT lens is offPath (in a building AND off every walkable way):
	// arcades and station concourses the walk really followed read 0 there, so a
	// non-zero offPath is a line through a house with no path — the thing to fix.
	const withB = all.filter((v) => v.candidateBuildingM !== null);
	const CROSS_M = 5;
	const candCross = withB.filter((v) => (v.candidateOffPathM ?? 0) >= CROSS_M);
	const rawCross = withB.filter((v) => (v.candidateBuildingM ?? 0) >= CROSS_M);
	console.log(
		`\nBUILDING-CROSSING (${withB.length} walks with building data): ` +
			`OFF-PATH (true defect) on ${candCross.length}; raw crossing (incl. mapped passages) on ${rawCross.length}`,
	);
	for (const v of candCross.sort((a, b) => (b.candidateOffPathM ?? 0) - (a.candidateOffPathM ?? 0))) {
		console.log(
			`  ${v.date} @${hhmm(v.startTs)}Z  ${(v.candidateOffPathM ?? 0).toFixed(0)}m off-path through buildings (raw ${(v.candidateBuildingM ?? 0).toFixed(0)}m)`,
		);
	}

	// Phase-1 head-to-head: the matched-line REFINEMENT vs the CURRENT drawn line.
	// Headline witness is SHARP TURNS — the refinement's job is to remove the boxy
	// ~90° graph corners WITHOUT worsening off-walkable / stall / route.
	const ref = all.filter((v) => v.refineP90 !== null && v.candidateP90 !== null);
	const p90Worse = ref.filter((v) => (v.refineP90 ?? 0) > (v.candidateP90 ?? 0) + 3).length;
	const stallWorse = ref.filter((v) => (v.refineStallM ?? 0) > v.candidateStallM + 15).length;
	const turnsBetter = ref.filter((v) => (v.refineSharpTurns ?? 0) < v.candidateSharpTurns).length;
	const turnsWorse = ref.filter((v) => (v.refineSharpTurns ?? 0) > v.candidateSharpTurns).length;
	const routedBoth = ref.filter((v) => v.refineRouteCorr !== null && v.candidateRouteCorr !== null);
	const routeWorse = routedBoth.filter((v) => (v.refineRouteCorr ?? 0) < (v.candidateRouteCorr ?? 0) - 0.05).length;
	const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
	console.log(
		`\nMAP-REFINE vs CURRENT (${ref.length} walks): ` +
			`sharpTurns mean ${mean(ref.map((v) => v.candidateSharpTurns)).toFixed(1)}→${mean(ref.map((v) => v.refineSharpTurns ?? 0)).toFixed(1)} (better ${turnsBetter}, worse ${turnsWorse}); ` +
			`offWalkP90 mean ${mean(ref.map((v) => v.candidateP90 ?? 0)).toFixed(1)}m→${mean(ref.map((v) => v.refineP90 ?? 0)).toFixed(1)}m (worse-by>3m ${p90Worse}); ` +
			`stall worse-by>15m ${stallWorse}; route worse-by>5% ${routeWorse}`,
	);

	// The production gate: apply the refinement ONLY where it actually reduces
	// sharp turns (the clamp already bounds faithfulness). Report what the gated
	// choice costs on the other witnesses — this is the real shipping impact.
	const applied = ref.filter((v) => (v.refineSharpTurns ?? 999) < v.candidateSharpTurns);
	const aStallWorse = applied.filter((v) => (v.refineStallM ?? 0) > v.candidateStallM + 15).length;
	const aOffWorse = applied.filter((v) => (v.refineP90 ?? 0) > (v.candidateP90 ?? 0) + 5).length;
	const aRouteWorse = applied.filter(
		(v) => v.refineRouteCorr !== null && (v.refineRouteCorr ?? 0) < (v.candidateRouteCorr ?? 0) - 0.05,
	).length;
	const aTurnsDrop = mean(applied.map((v) => v.candidateSharpTurns - (v.refineSharpTurns ?? 0)));
	console.log(
		`GATED (apply only where sharpTurns drop): ${applied.length}/${ref.length} walks refined, ` +
			`mean −${aTurnsDrop.toFixed(1)} sharp turns each; of those stall-worse>15m ${aStallWorse}, ` +
			`offWalk-worse>5m ${aOffWorse}, route-worse>5% ${aRouteWorse}`,
	);

	// SMOOTHER-PRIMARY head-to-head: the from-scratch continuous MAP smoother AS
	// THE DRAW vs the current matched line. This is the true-path Phase-1 candidate.
	// Headline witnesses: corridor-stall (the invented-detour / phantom-excursion
	// signal — this is what the Regent's Park reacquire case blows up) and
	// route-correctness against confirmed streets.
	const sm = all.filter((v) => v.smootherP90 !== null && v.candidateP90 !== null);
	const smStallBetter = sm.filter((v) => (v.smootherStallM ?? 0) < v.candidateStallM - 15).length;
	const smStallWorse = sm.filter((v) => (v.smootherStallM ?? 0) > v.candidateStallM + 15).length;
	const smRouted = sm.filter((v) => v.smootherRouteCorr !== null && v.candidateRouteCorr !== null);
	const smRouteBetter = smRouted.filter((v) => (v.smootherRouteCorr ?? 0) > (v.candidateRouteCorr ?? 0) + 0.05).length;
	const smRouteWorse = smRouted.filter((v) => (v.smootherRouteCorr ?? 0) < (v.candidateRouteCorr ?? 0) - 0.05).length;
	const smP90Worse = sm.filter((v) => (v.smootherP90 ?? 0) > (v.candidateP90 ?? 0) + 3).length;
	console.log(
		`\nSMOOTHER-PRIMARY vs CURRENT (${sm.length} walks): ` +
			`corridor-stall mean ${mean(sm.map((v) => v.candidateStallM)).toFixed(0)}m→${mean(sm.map((v) => v.smootherStallM ?? 0)).toFixed(0)}m (better>15m ${smStallBetter}, worse>15m ${smStallWorse}); ` +
			`route better>5% ${smRouteBetter}, worse>5% ${smRouteWorse}; offWalkP90 worse-by>3m ${smP90Worse}`,
	);
	// The legs where the smoother most reduces the corridor-stall — the phantom
	// detours it dissolves (the target class). Regent's Park should top this.
	for (const v of sm
		.filter((x) => (x.smootherStallM ?? 0) < x.candidateStallM - 40)
		.sort((a, b) => b.candidateStallM - (b.smootherStallM ?? 0) - (a.candidateStallM - (a.smootherStallM ?? 0)))
		.slice(0, 8)) {
		console.log(
			`  ${v.date} @${hhmm(v.startTs)}Z  stall ${v.candidateStallM.toFixed(0)}m → ${(v.smootherStallM ?? 0).toFixed(0)}m` +
				`  (dissolved ${(v.candidateStallM - (v.smootherStallM ?? 0)).toFixed(0)}m of phantom detour)`,
		);
	}

	// --- ratchet gate ------------------------------------------------------
	// The durable floor: compare this run's candidate metrics against the
	// blessed baseline. Unlike the A/B classification above (which carries
	// standing defects), the ratchet fails ONLY on a walk getting worse than
	// its own recorded floor — so it can gate deploys.
	const current = toBaseline(all);
	if (bless) {
		// Single-day bless merges into the existing floor; a full sweep replaces it.
		const existing: WalkBaseline = existsSync(WALK_BASELINE_PATH)
			? (JSON.parse(readFileSync(WALK_BASELINE_PATH, "utf8")) as WalkBaseline)
			: {};
		const next = arg ? { ...existing, ...current } : current;
		writeFileSync(WALK_BASELINE_PATH, `${JSON.stringify(next, null, "\t")}\n`);
		console.log(`\nRATCHET: blessed ${Object.values(next).flat().length} walk floor(s) → ${WALK_BASELINE_PATH}`);
		process.exit(0);
	}
	if (!existsSync(WALK_BASELINE_PATH)) {
		console.log(`\nRATCHET: no baseline at ${WALK_BASELINE_PATH} — run with --bless to record one.`);
		console.log("Falling back to the raw A/B exit (matcher vs smoother).");
		process.exit(regressed > 0 || routeRegressions.length > 0 ? 1 : 0);
	}
	const baseline = JSON.parse(readFileSync(WALK_BASELINE_PATH, "utf8")) as WalkBaseline;
	const gate = gateWalks(baseline, current, { onlyDates: dates });
	const fmt = (d: { date: string; startTs: number }) => `${d.date} @${hhmm(d.startTs)}Z`;
	console.log(
		`\nRATCHET vs ${WALK_BASELINE_PATH}: regressed ${gate.regressed.length}, improved ${gate.improved.length}, ` +
			`added ${gate.added.length}, vanished ${gate.unmatched.length}, unmeasured ${gate.unmeasured.length}`,
	);
	for (const r of gate.regressed) {
		console.log(
			`  ✗ ${fmt(r)}  ${r.metric} ${r.base.toFixed(r.metric === "route" ? 2 : 0)} → ${r.now.toFixed(r.metric === "route" ? 2 : 0)}`,
		);
	}
	for (const i of gate.improved) {
		console.log(
			`  ✓ ${fmt(i)}  ${i.metric} ${i.base.toFixed(i.metric === "route" ? 2 : 0)} → ${i.now.toFixed(i.metric === "route" ? 2 : 0)}  (re-bless to keep)`,
		);
	}
	for (const u of gate.unmeasured) console.log(`  ⚠ ${fmt(u)}  ${u.metric} was measured in the baseline, now null`);
	if (gate.added.length > 0 || gate.unmatched.length > 0) {
		console.log(
			`  walks without a floor: ${gate.added.map(fmt).join(", ") || "-"}; vanished from baseline: ${gate.unmatched.map(fmt).join(", ") || "-"} (states are golden-gated; re-bless to update)`,
		);
	}
	process.exit(gate.regressed.length > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

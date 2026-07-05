/**
 * Eval CLI: score the HSMM decoder OR the heuristic pipeline against
 * the structured ground-truth narratives in
 * `tests/golden/ground-truth/`.
 *
 * Replaces the self-referential `compare-hmm-vs-heuristic`
 * (mode-agreement-with-the-thing-we-want-to-beat) and `npm run golden`
 * (json-diff-vs-our-own-blessed-baseline). This is the first metric
 * anchored to ground truth — see `docs/design/probabilistic-principles.md`
 * §"Audit and verification".
 *
 * Usage (via prod-db.sh so the tunnel + env are set up):
 *
 *   scripts/prod-db.sh node dist/cli/compare-vs-ground-truth.js
 *   scripts/prod-db.sh node dist/cli/compare-vs-ground-truth.js --source hsmm
 *   scripts/prod-db.sh node dist/cli/compare-vs-ground-truth.js --source pipeline
 *   scripts/prod-db.sh node dist/cli/compare-vs-ground-truth.js --date 2026-05-22
 *
 * Output:
 *   - Per day: mode/place/line scorable counts and matching counts
 *   - Per row: row text + decoder agreement (M=mode, P=place, L=line)
 *   - Aggregate: total scorable minutes + matching percentages
 *   - Unresolved place names — focus_places needing display_name fixes
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { db, initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { type GroundTruthDay, parseGroundTruth } from "../eval/ground-truth.js";
import { scoreJourneys } from "../eval/journey-score.js";
import { type DayScore, type DecoderMinute, scoreDay } from "../eval/score-day.js";
import { parseHourProfile } from "../geo/focus-places.js";
import { stationsOnLine } from "../geo/line-stations.js";
import type { RouteGraph } from "../geo/route-graph.js";
import { bboxFromFixes, loadRouteGraphForBbox } from "../geo/route-graph-loader.js";
import { dateBoundsUtc } from "../geo/timezone.js";
import { computeVelocity, type EnrichedSegment, loadBiometrics } from "../geo/velocity.js";
import { DEFAULT_MIN_DURATION_BY_MODE, type GammaFit, logDurationProb } from "../hmm/duration-dist.js";
import { buildEmissionFn } from "../hmm/emissions.js";
import { buildEntryPrior } from "../hmm/entry-prior.js";
import { buildGeometricFeasibility } from "../hmm/geometric-feasibility.js";
import { dropGpsOutliers } from "../hmm/gps-outliers.js";
import { hsmmViterbi } from "../hmm/hsmm-viterbi.js";
import { buildInitialStatePrior } from "../hmm/initial-state.js";
import { buildLineProximityFactor } from "../hmm/line-proximity-factor.js";
import type { Observation } from "../hmm/observation.js";
import { buildObservationTensor } from "../hmm/observation.js";
import { routeAwareDecode } from "../hmm/route-aware-decoder.js";
import { buildRouteRailEvidence } from "../hmm/route-rail-evidence.js";
import { buildStateSpace, type FocusPlaceRef, type State } from "../hmm/state-space.js";
import { buildTransitionMatrix } from "../hmm/transitions.js";
import {
	assembleTubeJourneys,
	assembleTubeJourneysFromSegments,
	type JourneySegment,
	type TubeJourney,
} from "../hmm/tube-journey-assembler.js";

const config = z
	.object({
		db: z.object({
			host: z.string().default("health-db"),
			port: z.coerce.number().default(3306),
			user: z.string(),
			password: z.string(),
			database: z.string().default("health"),
		}),
		nextcloud: z.object({
			baseUrl: z.string().url().default("https://dash.xinutec.org"),
			clientId: z.string().min(1),
			clientSecret: z.string().min(1),
		}),
	})
	.parse({
		db: {
			host: process.env.DB_HOST,
			port: process.env.DB_PORT,
			user: process.env.DB_USER,
			password: process.env.DB_PASSWORD,
			database: process.env.DB_NAME,
		},
		nextcloud: {
			baseUrl: process.env.NC_BASE_URL,
			clientId: process.env.NC_CLIENT_ID,
			clientSecret: process.env.NC_CLIENT_SECRET,
		},
	});

const KNOWN_LINES = [
	"Metropolitan Line",
	"Jubilee Line",
	"Victoria Line",
	"Piccadilly Line",
	"Bakerloo Line",
	"Northern Line",
	"Circle Line",
	"Hammersmith & City Line",
	"District Line",
	"Central Line",
	"Elizabeth Line",
];

const BASELINE_DURATION_FITS: Record<State["mode"], GammaFit> = {
	stationary: { alpha: 0.85, beta: 0.0043, sampleCount: 132 },
	walking: { alpha: 1.07, beta: 0.034, sampleCount: 60 },
	cycling: { alpha: 1.0, beta: 0.05, sampleCount: 0 },
	driving: { alpha: 0.42, beta: 0.008, sampleCount: 24 },
	train: { alpha: 1.74, beta: 0.053, sampleCount: 24 },
	plane: { alpha: 1.0, beta: 0.011, sampleCount: 0 },
	unknown: { alpha: 0.45, beta: 0.0034, sampleCount: 15 },
};

interface CliArgs {
	source: "hsmm" | "pipeline" | "route-aware";
	userId: string;
	dates: string[] | null; // null → all gitignored ground-truth files for the user
	groundTruthDir: string;
	manifestPath: string;
	/** When set with `--source route-aware`, also runs the
	 *  tube-journey assembler over the decoded states and prints
	 *  the resulting journeys per day. Phase A of
	 *  `docs/proposals/decoder-roadmap.md`. */
	journey: boolean;
}

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	let source: CliArgs["source"] = "hsmm";
	let userId = "pippijn";
	let dates: string[] | null = null;
	let groundTruthDir = "tests/golden/ground-truth";
	let manifestPath = "tests/golden/manifest.json";
	let journey = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--source") source = (args[++i] as CliArgs["source"]) ?? source;
		else if (a === "--user") userId = args[++i] ?? userId;
		else if (a === "--date") dates = [args[++i] ?? ""].filter(Boolean);
		else if (a === "--ground-truth-dir") groundTruthDir = args[++i] ?? groundTruthDir;
		else if (a === "--manifest") manifestPath = args[++i] ?? manifestPath;
		else if (a === "--journey") journey = true;
	}
	return { source, userId, dates, groundTruthDir, manifestPath, journey };
}

interface ManifestEntry {
	date: string;
	user: string;
	tz: string;
	description?: string;
}

function loadGroundTruthDays(args: CliArgs): GroundTruthDay[] {
	const manifest = JSON.parse(readFileSync(args.manifestPath, "utf-8")) as ManifestEntry[];
	const tzByDate = new Map<string, string>();
	for (const e of manifest) if (e.user === args.userId) tzByDate.set(e.date, e.tz);

	const files = readdirSync(args.groundTruthDir)
		.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
		.sort();
	const days: GroundTruthDay[] = [];
	for (const f of files) {
		const date = f.replace(".md", "");
		if (args.dates !== null && !args.dates.includes(date)) continue;
		const tz = tzByDate.get(date);
		if (tz === undefined) {
			console.error(`# skipping ${date}: no manifest entry for user=${args.userId}`);
			continue;
		}
		const md = readFileSync(path.join(args.groundTruthDir, f), "utf-8");
		days.push(parseGroundTruth(md, date, tz));
	}
	return days;
}

interface PlaceWithCoords extends FocusPlaceRef {
	lat: number;
	lon: number;
	hourProfile: readonly number[] | null;
	totalDwellSec: number;
}

async function loadFocusPlacesForUser(userId: string): Promise<PlaceWithCoords[]> {
	const rows = await db()
		.selectFrom("focus_places")
		.where("user_id", "=", userId)
		.select(["id", "display_name", "centroid_lat", "centroid_lon", "hour_profile", "total_dwell_sec"])
		.execute();
	return rows.map((r) => ({
		id: r.id,
		displayName: r.display_name,
		lat: Number(r.centroid_lat),
		lon: Number(r.centroid_lon),
		hourProfile: parseHourProfile(r.hour_profile),
		totalDwellSec: Number(r.total_dwell_sec),
	}));
}

/**
 * Resolve ground-truth place names to focus_place ids.
 *
 * Strategy (in order, highest-dwell wins on ties):
 *   1. Exact case-insensitive equality on `display_name`
 *   2. Ground-truth name is a substring of `display_name` (e.g.
 *      "Cleveland Clinic" matches "Cleveland Clinic London")
 *   3. `display_name` is a substring of the ground-truth name (e.g.
 *      "Varley" matches "Varley Apartments")
 *   4. Synonyms for common labels — "Home" picks the highest-dwell
 *      residential focus place (`amenity_type` heuristic NOT available
 *      cheaply, so we use highest-dwell as the proxy).
 *
 * Unresolved names are returned as a separate list — the human can
 * then either rename the focus_place or add to a future alias table.
 */
function resolvePlaceNames(
	names: ReadonlySet<string>,
	places: readonly PlaceWithCoords[],
): { resolved: Map<string, number>; unresolved: string[] } {
	const resolved = new Map<string, number>();
	const unresolved: string[] = [];
	const byHighestDwell = [...places].sort((a, b) => b.totalDwellSec - a.totalDwellSec);
	for (const name of names) {
		const lower = name.toLowerCase();
		// 1. Exact match
		const exact = byHighestDwell.find((p) => p.displayName?.toLowerCase() === lower);
		if (exact) {
			resolved.set(name, exact.id);
			continue;
		}
		// 2. Name is substring of display_name
		const subOfDisplay = byHighestDwell.find((p) => p.displayName?.toLowerCase().includes(lower));
		if (subOfDisplay) {
			resolved.set(name, subOfDisplay.id);
			continue;
		}
		// 3. Display_name is substring of name
		const displayInName = byHighestDwell.find(
			(p) => p.displayName !== null && lower.includes(p.displayName.toLowerCase()),
		);
		if (displayInName) {
			resolved.set(name, displayInName.id);
			continue;
		}
		// 4. "Home" → highest-dwell place. Heuristic, marked separately
		// for visibility.
		if (lower === "home" && byHighestDwell.length > 0) {
			resolved.set(name, byHighestDwell[0].id);
			continue;
		}
		unresolved.push(name);
	}
	return { resolved, unresolved };
}

function collectAllPlaceNames(days: readonly GroundTruthDay[]): Set<string> {
	const names = new Set<string>();
	for (const day of days) {
		for (const row of day.rows) {
			if (row.blessed?.place) names.add(row.blessed.place);
		}
	}
	return names;
}

async function buildPlaceNearLine(places: readonly PlaceWithCoords[], lines: readonly string[]): Promise<Set<string>> {
	const WALK_DIST_M = 400;
	const placeNearLine = new Set<string>();
	for (const line of lines) {
		const stations = await stationsOnLine(line);
		if (stations.length === 0) continue;
		for (const p of places) {
			for (const s of stations) {
				if (haversineMeters(p.lat, p.lon, s.lat, s.lon) <= WALK_DIST_M) {
					placeNearLine.add(`${p.id}|${line}`);
					break;
				}
			}
		}
	}
	return placeNearLine;
}

/** Shift a `YYYY-MM-DD` date string by N calendar days (negative = back). */
function shiftDate(date: string, days: number): string {
	const [y, mo, d] = date.split("-").map(Number);
	const dt = new Date(Date.UTC(y, mo - 1, d));
	dt.setUTCDate(dt.getUTCDate() + days);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Run the HSMM on a day and turn the per-minute State[] into the
 *  DecoderMinute[] shape the scorer expects. */
async function decodeHsmm(
	userId: string,
	date: string,
	tz: string,
	places: readonly PlaceWithCoords[],
	placeNearLine: Set<string>,
	routeGraph: RouteGraph,
): Promise<DecoderMinute[]> {
	const velResult = await computeVelocity(config, userId, date, tz);
	const bounds = dateBoundsUtc(date, tz);
	const biom = await loadBiometrics(userId, bounds.startUtc, bounds.endUtc, tz);
	const cleanedPoints = dropGpsOutliers(velResult.points);
	const tensor = buildObservationTensor({
		date,
		tz,
		points: cleanedPoints,
		hr: biom.hr,
		steps: biom.steps,
		sleep: biom.sleep,
	});
	const states = buildStateSpace({ focusPlaces: places, knownLines: KNOWN_LINES });
	const placeCoords = new Map<number, { lat: number; lon: number }>();
	const placeHourProfiles = new Map<number, readonly number[]>();
	const placeVisitWeights = new Map<number, number>();
	const totalDwell = places.reduce((s, p) => s + p.totalDwellSec, 0);
	for (const p of places) {
		placeCoords.set(p.id, { lat: p.lat, lon: p.lon });
		if (p.hourProfile !== null) placeHourProfiles.set(p.id, p.hourProfile);
		placeVisitWeights.set(p.id, totalDwell > 0 ? p.totalDwellSec / totalDwell : 1 / places.length);
	}
	const transition = buildTransitionMatrix({
		states,
		placeNearLine: (placeId, lineName) => placeNearLine.has(`${placeId}|${lineName}`),
	});
	const baseEmission = buildEmissionFn({ placeCoords });
	const geometricFn = buildGeometricFeasibility({ placeCoords });
	const routeRailFn = buildRouteRailEvidence({ routeGraph });
	const lineProximityFn = buildLineProximityFactor({ routeGraph });
	const emission = (state: State, obs: (typeof tensor)[number]): number =>
		baseEmission(state, obs) + geometricFn(state, obs) + routeRailFn(state, obs) + lineProximityFn(state, obs);
	const initialLogProb = buildInitialStatePrior();
	const entryLogProb = buildEntryPrior({ placeHourProfiles, placeVisitWeights });
	const hmmStates = hsmmViterbi({
		observations: tensor,
		states,
		transitionLogProb: transition,
		emissionLogProb: emission,
		initialLogProb,
		entryLogProb,
		durationLogProb: (state, d) =>
			logDurationProb(d, state.mode, BASELINE_DURATION_FITS[state.mode], DEFAULT_MIN_DURATION_BY_MODE[state.mode]),
	});
	return tensor.map((obs, i) => ({
		ts: obs.ts,
		mode: hmmStates[i].mode,
		placeId: hmmStates[i].placeId,
		lineName: hmmStates[i].lineName,
	}));
}

/** Decode a day with the Phase 1 route-aware decoder (inner edge
 *  Viterbi per train segment). Mirrors `decodeHsmm`'s shape but
 *  uses `routeAwareDecode` for the outer + inner pass. */
interface RouteAwareDecodeResult {
	minutes: DecoderMinute[];
	tensor: readonly Observation[];
	states: readonly State[];
}

async function decodeRouteAware(
	userId: string,
	date: string,
	tz: string,
	places: readonly PlaceWithCoords[],
	routeGraph: RouteGraph,
): Promise<RouteAwareDecodeResult> {
	const velResult = await computeVelocity(config, userId, date, tz);
	const bounds = dateBoundsUtc(date, tz);
	const biom = await loadBiometrics(userId, bounds.startUtc, bounds.endUtc, tz);
	const cleanedPoints = dropGpsOutliers(velResult.points);
	const tensor = buildObservationTensor({
		date,
		tz,
		points: cleanedPoints,
		hr: biom.hr,
		steps: biom.steps,
		sleep: biom.sleep,
	});
	const placeHourProfiles = new Map<number, readonly number[]>();
	const placeVisitWeights = new Map<number, number>();
	const totalDwell = places.reduce((s, p) => s + p.totalDwellSec, 0);
	for (const p of places) {
		if (p.hourProfile !== null) placeHourProfiles.set(p.id, p.hourProfile);
		placeVisitWeights.set(p.id, totalDwell > 0 ? p.totalDwellSec / totalDwell : 1 / places.length);
	}
	const focusPlaces = places.map((p) => ({
		id: p.id,
		displayName: p.displayName,
		lat: p.lat,
		lon: p.lon,
	}));
	const result = routeAwareDecode({
		observations: tensor,
		routeGraph,
		knownLines: KNOWN_LINES,
		focusPlaces,
		placeHourProfiles,
		placeVisitWeights,
	});
	const minutes = tensor.map((obs, i) => ({
		ts: obs.ts,
		mode: result.states[i].mode,
		placeId: result.states[i].placeId,
		lineName: result.states[i].lineName,
	}));
	return { minutes, tensor, states: result.states };
}

/** Extract the rail line from a pipeline train segment's wayName,
 *  which is encoded as `Board → Alight · LineName` (or just
 *  `Board → Alight` when the line is unknown). Mirrors the encoding
 *  in `src/geo/velocity.ts` `parseRailWayName`. */
const PIPELINE_LINE_RE = / · ([^·]+)$/;
function pipelineLineName(wayName: string | undefined): string | null {
	if (wayName === undefined) return null;
	const m = PIPELINE_LINE_RE.exec(wayName);
	return m ? m[1].trim() : null;
}

/** Pipeline (heuristic) per-minute output: turn segments into
 *  per-minute decoder rows. The pipeline emits a display-name string
 *  for the place; we map back to focus_places.id via the supplied
 *  `placeNameToId` map (built once from focus_places). The pipeline
 *  emits `sleeping` as its own mode (vs HSMM's `stationary` +
 *  inBed observation) — leave as-is; the scorer canonicalises
 *  sleeping↔stationary. */
function pipelineToDecoderMinutes(
	segments: readonly EnrichedSegment[],
	date: string,
	tz: string,
	placeNameToId: ReadonlyMap<string, number>,
): DecoderMinute[] {
	const { startUtc } = dateBoundsUtc(date, tz);
	const minutes: DecoderMinute[] = [];
	for (let m = 0; m < 1440; m++) {
		const ts = startUtc + m * 60;
		const seg = segments.find((s) => s.startTs <= ts && ts < s.endTs);
		if (!seg) {
			minutes.push({ ts, mode: "unknown", placeId: null, lineName: null });
			continue;
		}
		// `vehicleKind=bus` refines a driving leg into a bus — mirror the UI
		// (`day-state.ts`) so the scorer sees the same mode the user does, and
		// a blessed `bus` row is scorable instead of always reading `driving`.
		const mode: DecoderMinute["mode"] =
			seg.vehicleKind === "bus" ? "bus" : ((seg.refinedMode ?? seg.mode) as DecoderMinute["mode"]);
		const placeId = seg.place !== undefined ? (placeNameToId.get(seg.place.toLowerCase()) ?? null) : null;
		const lineName = mode === "train" ? pipelineLineName(seg.wayName) : null;
		minutes.push({ ts, mode, placeId, lineName });
	}
	return minutes;
}

interface PipelineDecodeResult {
	minutes: DecoderMinute[];
	segments: readonly EnrichedSegment[];
}

async function decodePipeline(
	userId: string,
	date: string,
	tz: string,
	placeNameToId: ReadonlyMap<string, number>,
): Promise<PipelineDecodeResult> {
	const velResult = await computeVelocity(config, userId, date, tz);
	return {
		minutes: pipelineToDecoderMinutes(velResult.segments, date, tz, placeNameToId),
		segments: velResult.segments,
	};
}

function formatPct(num: number, denom: number): string {
	if (denom === 0) return "  n/a";
	return `${((num / denom) * 100).toFixed(1).padStart(5)}%`;
}

function renderDayReport(day: GroundTruthDay, score: DayScore, source: string): void {
	console.log(`\n## ${day.date} (${day.tz}) — ${source}`);
	console.log(
		`  mode:  ${score.modeMatching.toString().padStart(4)} / ${score.scorableMinutes.toString().padStart(4)} (${formatPct(score.modeMatching, score.scorableMinutes)})`,
	);
	console.log(
		`  place: ${score.placeMatching.toString().padStart(4)} / ${score.placeScorable.toString().padStart(4)} (${formatPct(score.placeMatching, score.placeScorable)})`,
	);
	console.log(
		`  line:  ${score.lineMatching.toString().padStart(4)} / ${score.lineScorable.toString().padStart(4)} (${formatPct(score.lineMatching, score.lineScorable)})`,
	);
	if (score.unresolvedPlaceNames.length > 0) {
		console.log(`  unresolved place names: ${score.unresolvedPlaceNames.join(", ")}`);
	}
	console.log("");
	console.log(
		"  per row (M=mode minutes matched / row minutes; P=place agreement; L=line agreement; · = not scorable)",
	);
	for (const r of score.rowResults) {
		const tag = r.row.status === "correct" ? "  " : "··";
		const mPart =
			r.row.status === "correct"
				? `M:${r.modeAgreementMinutes.toString().padStart(3)}/${r.rowMinutes.toString().padStart(3)}`
				: "M: ·  /  ·";
		const pPart = `P:${r.placeAgreement.padEnd(8)}`;
		const lPart = `L:${r.lineAgreement.padEnd(8)}`;
		const blessed = (
			r.row.blessed?.mode === "train"
				? `train ${r.row.blessed.trainFromTo?.from} → ${r.row.blessed.trainFromTo?.to}${r.row.blessed.lineName ? ` · ${r.row.blessed.lineName}` : ""}`
				: r.row.blessedText
		).slice(0, 50);
		console.log(`  ${tag} ${r.row.windowText.padEnd(15)} ${mPart}  ${pPart} ${lPart}  ${blessed}`);
	}
}

function formatHHMM(ts: number, tz: string): string {
	return new Date(ts * 1000).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		timeZone: tz,
		hour12: false,
	});
}

/** Print the tube journeys assembled for a single day. Phase A
 *  output — visibility only; no scoring against ground truth yet. */
function renderJourneys(date: string, tz: string, journeys: readonly TubeJourney[]): void {
	console.log(`\n## ${date} — tube journeys (${journeys.length})`);
	if (journeys.length === 0) {
		console.log("  (none)");
		return;
	}
	for (const j of journeys) {
		const start = formatHHMM(j.startTs, tz);
		const end = formatHHMM(j.endTs, tz);
		const board = j.boardStationName ?? "?";
		const alight = j.alightStationName ?? "?";
		const lines = j.lines.length > 0 ? j.lines.join(" + ") : "(no line)";
		console.log(
			`  ${start}-${end}  ${board} → ${alight}  via ${lines}  legs=${j.legs.length} steps=${j.intraStepCount}`,
		);
		for (const leg of j.legs) {
			const ls = formatHHMM(j.startTs + (leg.startMin - j.startMin) * 60, tz);
			const le = formatHHMM(j.startTs + (leg.endMin - j.startMin) * 60, tz);
			if (leg.kind === "train") {
				const lb = leg.boardStationName ?? "?";
				const la = leg.alightStationName ?? "?";
				console.log(`      ${ls}-${le}  train  ${lb} → ${la} · ${leg.line}`);
			} else {
				const st = leg.stationName ?? "?";
				console.log(`      ${ls}-${le}  interchange walk @ ${st}`);
			}
		}
	}
}

async function main(): Promise<void> {
	const args = parseArgs();
	initPool(config.db);
	await withConnection(migrate);

	console.error(`# compare-vs-ground-truth — source=${args.source} user=${args.userId}`);
	const days = loadGroundTruthDays(args);
	if (days.length === 0) {
		console.error("# no ground-truth files matched the filter");
		process.exit(0);
	}
	console.error(`# loaded ${days.length} ground-truth day(s)`);

	const places = await loadFocusPlacesForUser(args.userId);
	console.error(`# loaded ${places.length} focus_places for ${args.userId}`);

	// Resolve place names ONCE across all days — surfaces every
	// unresolved name in a single pass rather than per-day spam.
	const allNames = collectAllPlaceNames(days);
	const { resolved, unresolved } = resolvePlaceNames(allNames, places);
	console.error(`# resolved ${resolved.size}/${allNames.size} ground-truth place names`);
	if (unresolved.length > 0) {
		console.error(`# unresolved: ${unresolved.join(", ")}`);
	}

	let placeNearLine: Set<string> = new Set();
	let routeGraph: RouteGraph | null = null;
	if (args.source === "hsmm" || args.source === "route-aware") {
		placeNearLine = await buildPlaceNearLine(places, KNOWN_LINES);
		const bbox = bboxFromFixes(places.map((p) => ({ lat: p.lat, lon: p.lon })));
		if (bbox === null) throw new Error("no focus places — cannot build route graph");
		routeGraph = await loadRouteGraphForBbox(bbox, { featureTypes: ["railway"] });
		console.error(`# loaded ${routeGraph.edges.size} rail edges`);
	}

	// For the pipeline path: a separate display_name → id lookup so a
	// pipeline-emitted "Home (residence)" maps to the same id as the
	// ground-truth "Home" (which goes through the fuzzy resolver above).
	const pipelineNameToId = new Map<string, number>();
	for (const p of places) {
		if (p.displayName !== null) pipelineNameToId.set(p.displayName.toLowerCase(), p.id);
	}

	let totalScorable = 0;
	let totalModeMatching = 0;
	let totalPlaceScorable = 0;
	let totalPlaceMatching = 0;
	let totalLineScorable = 0;
	let totalLineMatching = 0;
	// Journey-level (boundary-robust leg fidelity + trip-structure gate).
	let totalJourneys = 0;
	let totalJourneySeqMatched = 0;
	let totalLegModeScorable = 0;
	let totalLegModeMatching = 0;
	let totalLegLineScorable = 0;
	let totalLegLineMatching = 0;

	for (const day of days) {
		try {
			// Ground-truth files can contain previous-evening sleep
			// (anchored to file_date - 1) and tonight-into-tomorrow
			// sleep (anchored to file_date + 1). The decoder runs
			// per local-tz calendar day, so we decode all three and
			// stitch the per-minute output. Wasteful but simple.
			const adjacentDates = [shiftDate(day.date, -1), day.date, shiftDate(day.date, 1)];
			const decoderChunks: DecoderMinute[] = [];
			let currentDayRouteAware: RouteAwareDecodeResult | null = null;
			let currentDayPipeline: PipelineDecodeResult | null = null;
			for (const d of adjacentDates) {
				let chunk: DecoderMinute[];
				if (args.source === "hsmm") {
					chunk = await decodeHsmm(args.userId, d, day.tz, places, placeNearLine, routeGraph as RouteGraph);
				} else if (args.source === "route-aware") {
					const ra = await decodeRouteAware(args.userId, d, day.tz, places, routeGraph as RouteGraph);
					chunk = ra.minutes;
					if (d === day.date) currentDayRouteAware = ra;
				} else {
					const pl = await decodePipeline(args.userId, d, day.tz, pipelineNameToId);
					chunk = pl.minutes;
					if (d === day.date) currentDayPipeline = pl;
				}
				decoderChunks.push(...chunk);
			}
			const score = scoreDay(day.rows, decoderChunks, resolved);
			renderDayReport(day, score, args.source);
			if (args.journey && currentDayRouteAware !== null) {
				const journeys = assembleTubeJourneys({
					observations: currentDayRouteAware.tensor,
					states: currentDayRouteAware.states,
					routeGraph: routeGraph as RouteGraph,
					trainCandidates: [],
				});
				renderJourneys(day.date, day.tz, journeys);
			}
			if (args.journey && currentDayPipeline !== null) {
				const segs: JourneySegment[] = currentDayPipeline.segments.map((s) => ({
					startTs: s.startTs,
					endTs: s.endTs,
					mode: s.refinedMode ?? s.mode,
					wayName: s.wayName,
					stepsTotal: s.biometrics?.stepsTotal ?? null,
				}));
				const journeys = assembleTubeJourneysFromSegments(segs);
				renderJourneys(day.date, day.tz, journeys);
			}
			totalScorable += score.scorableMinutes;
			totalModeMatching += score.modeMatching;
			totalPlaceScorable += score.placeScorable;
			totalPlaceMatching += score.placeMatching;
			totalLineScorable += score.lineScorable;
			totalLineMatching += score.lineMatching;

			const jscore = scoreJourneys(day.rows, decoderChunks);
			totalJourneys += jscore.journeysExpected;
			totalJourneySeqMatched += jscore.journeysModeSequenceMatched;
			totalLegModeScorable += jscore.legModeScorable;
			totalLegModeMatching += jscore.legModeMatching;
			totalLegLineScorable += jscore.legLineScorable;
			totalLegLineMatching += jscore.legLineMatching;
		} catch (e) {
			console.error(`# ${day.date} FAILED: ${e instanceof Error ? e.message : e}`);
		}
	}

	console.log(`\n## AGGREGATE (${days.length} days, source=${args.source})`);
	console.log(`  mode:  ${totalModeMatching}/${totalScorable} (${formatPct(totalModeMatching, totalScorable)})`);
	console.log(
		`  place: ${totalPlaceMatching}/${totalPlaceScorable} (${formatPct(totalPlaceMatching, totalPlaceScorable)})`,
	);
	console.log(
		`  line:  ${totalLineMatching}/${totalLineScorable} (${formatPct(totalLineMatching, totalLineScorable)})`,
	);
	console.log(`\n## JOURNEY-LEVEL (${days.length} days, source=${args.source})`);
	console.log(
		`  trips (mode-sequence):  ${totalJourneySeqMatched}/${totalJourneys} (${formatPct(totalJourneySeqMatched, totalJourneys)})`,
	);
	console.log(
		`  legs (mode, boundary-robust):  ${totalLegModeMatching}/${totalLegModeScorable} (${formatPct(totalLegModeMatching, totalLegModeScorable)})`,
	);
	console.log(
		`  legs (transit line):  ${totalLegLineMatching}/${totalLegLineScorable} (${formatPct(totalLegLineMatching, totalLegLineScorable)})`,
	);

	process.exit(0);
}

await main();

/**
 * Audit CLI: runs the existing heuristic pipeline and the MVP HMM
 * decoder on the same day(s), then surfaces minute-level
 * disagreements + an aggregate mode-confusion matrix.
 *
 * Phase 1.5 of `docs/design/overview.md` —
 * proves the HMM architecture before any user-facing change.
 *
 * Usage (via prod-db.sh so the tunnel + env are set up):
 *
 *   scripts/prod-db.sh node dist/cli/compare-hmm-vs-heuristic.js              # last 7 days
 *   scripts/prod-db.sh node dist/cli/compare-hmm-vs-heuristic.js --days 14
 *   scripts/prod-db.sh node dist/cli/compare-hmm-vs-heuristic.js --date 2026-05-22
 *   scripts/prod-db.sh node dist/cli/compare-hmm-vs-heuristic.js --user pippijn --tz Europe/London
 *
 * Output (per day):
 *   - Total minutes processed
 *   - Per-minute agreement rate
 *   - Mode-confusion matrix: rows=heuristic mode, cols=HMM mode
 *   - Up to 5 sample minutes per disagreement category, with the
 *     observation (speed/hr/cadence/gps-present) so a human can
 *     decide which classifier is right
 *
 * Exit 0 always (measurement tool, not regression detector).
 *
 * NOT wired into prod: the HMM result is computed for measurement
 * only. Decision to enable in prod comes after this audit shows
 * the HMM is consistently better than the heuristic on the
 * residuals it's designed to address.
 */

import { z } from "zod";
import { db, initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { parseHourProfile } from "../geo/focus-places.js";
import { stationsOnLine } from "../geo/line-stations.js";
import type { RouteGraph } from "../geo/route-graph.js";
import { bboxFromFixes, loadRouteGraphForBbox } from "../geo/route-graph-loader.js";
import { dateBoundsUtc } from "../geo/timezone.js";
import { computeVelocity, type EnrichedSegment, loadBiometrics } from "../geo/velocity.js";
import { DEFAULT_MIN_DURATION_BY_MODE, type GammaFit, logDurationProb } from "../hmm/duration-dist.js";
import { buildEmissionFn } from "../hmm/emissions.js";
import { buildEntryPrior } from "../hmm/entry-prior.js";
import type { LearnedEmissionParameters } from "../hmm/fit-emissions.js";
import { buildGeometricFeasibility } from "../hmm/geometric-feasibility.js";
import { dropGpsOutliers } from "../hmm/gps-outliers.js";
import { hsmmMarginals, type Marginals } from "../hmm/hsmm-marginals.js";
import { hsmmViterbi } from "../hmm/hsmm-viterbi.js";
import { buildInitialStatePrior } from "../hmm/initial-state.js";
import { buildLineProximityFactor } from "../hmm/line-proximity-factor.js";
import { buildObservationTensor, type Observation } from "../hmm/observation.js";
import { buildRouteRailEvidence } from "../hmm/route-rail-evidence.js";
import { buildStateSpace, type FocusPlaceRef, type State, stateKey } from "../hmm/state-space.js";
import { buildTransitionMatrix } from "../hmm/transitions.js";
import { viterbi } from "../hmm/viterbi.js";

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

/** Bootstrap the user's known rail lines. For MVP, hardcoded to
 *  the London Underground line names that linesAtPoint returns
 *  exact-match for. Combined-name variants (e.g.
 *  "Circle and Hammersmith & City Lines") are seen as their own
 *  HMM states via the catch-all `train|unknown_rail` plus any
 *  user-specific lines we surface here. */
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

interface CliArgs {
	userId: string;
	tz: string;
	dates: string[];
	modelVersion: string | null;
	render: boolean;
	hsmm: boolean;
	marginals: boolean;
}

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	let userId = "pippijn";
	let tz = "Europe/London";
	let days = 7;
	let explicitDate: string | null = null;
	let modelVersion: string | null = null;
	let render = false;
	let hsmm = false;
	let marginals = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--user") userId = args[++i] ?? userId;
		else if (args[i] === "--tz") tz = args[++i] ?? tz;
		else if (args[i] === "--days") days = Number(args[++i] ?? days) || days;
		else if (args[i] === "--date") explicitDate = args[++i] ?? null;
		else if (args[i] === "--model") modelVersion = args[++i] ?? null;
		else if (args[i] === "--render") render = true;
		else if (args[i] === "--hsmm") hsmm = true;
		else if (args[i] === "--marginals") marginals = true;
	}
	let dates: string[];
	if (explicitDate) {
		dates = [explicitDate];
	} else {
		dates = [];
		const now = new Date();
		for (let d = 1; d <= days; d++) {
			const date = new Date(now);
			date.setUTCDate(now.getUTCDate() - d);
			dates.push(date.toISOString().slice(0, 10));
		}
	}
	return { userId, tz, dates, modelVersion, render, hsmm, marginals };
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

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Build a `placeId|lineName` set marking which place-line pairs are
 *  walking-distance compatible. The HMM transition matrix uses this
 *  as the station-graph hard-zero — a train on line L cannot alight
 *  at place P (and vice versa) when no station on L is near P. */
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

interface DayResult {
	date: string;
	tensor: Observation[];
	heuristicSegments: EnrichedSegment[];
	hmmStates: State[];
	/** All HMM states in deterministic order (same as input to the
	 *  decoder). Needed to map `marginals[t][s]` → state. */
	states: State[];
	/** Per-minute posterior marginals over states, or `null` when
	 *  the user didn't request them (--marginals flag). */
	marginals: Marginals | null;
}

async function loadLearnedModel(userId: string, version: string): Promise<LearnedEmissionParameters> {
	const row = await db()
		.selectFrom("learned_hmm_models")
		.where("user_id", "=", userId)
		.where("version", "=", version)
		.select(["emissions_json", "training_day_count", "training_minute_count", "trained_at"])
		.executeTakeFirst();
	if (!row) throw new Error(`no learned_hmm_models row for user=${userId} version=${version}`);
	const parsed = JSON.parse(row.emissions_json) as LearnedEmissionParameters;
	console.error(
		`# Loaded model: version=${version} trained_at=${new Date(row.trained_at).toISOString()} days=${row.training_day_count} samples=${row.training_minute_count}`,
	);
	return parsed;
}

/** Baseline per-mode Gamma fits — moments-matched to the
 *  `dump-segment-durations` output on 45 days of training data.
 *  These are populated values to bootstrap the HSMM before a
 *  proper learned-duration loader exists; once we persist
 *  fitted distributions per user, swap these for DB-loaded
 *  values (same as the per-mode emissions story).
 *
 *  Empirical means / stddevs from 2026-04-01 → 2026-05-15:
 *    stationary    n=132  mean=201  std≈217  (bimodal: short cafe
 *                                              + overnight Home)
 *    walking       n=60   mean=31   std≈30
 *    driving       n=24   mean=52   std≈80   (one 429min outlier)
 *    train         n=24   mean=33   std≈25
 *    cycling       n=0    (fallback — assume similar to walking)
 *    plane         n=0    (fallback — long-tailed wide prior)
 *    unknown       n=15   mean=134  std≈200  (bimodal gap+overnight) */
const BASELINE_DURATION_FITS: Record<State["mode"], GammaFit> = {
	// Method-of-moments: α = μ²/σ², β = μ/σ²
	stationary: { alpha: 0.85, beta: 0.0043, sampleCount: 132 },
	walking: { alpha: 1.07, beta: 0.034, sampleCount: 60 },
	cycling: { alpha: 1.0, beta: 0.05, sampleCount: 0 }, // fallback
	driving: { alpha: 0.42, beta: 0.008, sampleCount: 24 },
	train: { alpha: 1.74, beta: 0.053, sampleCount: 24 },
	plane: { alpha: 1.0, beta: 0.011, sampleCount: 0 }, // fallback: mean ~90
	unknown: { alpha: 0.45, beta: 0.0034, sampleCount: 15 },
};

async function decodeDay(
	userId: string,
	date: string,
	tz: string,
	cache: {
		focusPlaces: PlaceWithCoords[];
		placeNearLine: Set<string>;
		routeGraph: RouteGraph;
		learnedEmissions: LearnedEmissionParameters | null;
		useHsmm: boolean;
		marginals: boolean;
	},
): Promise<DayResult> {
	const t0 = Date.now();
	const velResult = await computeVelocity(config, userId, date, tz);
	const bounds = dateBoundsUtc(date, tz);
	const biom = await loadBiometrics(userId, bounds.startUtc, bounds.endUtc, tz);
	// HMM-specific GPS outlier filter (more aggressive than the
	// velocity-pipeline qualityFilterGps, which preserves no-bridge
	// sustained-motion fixes by design). Drops fixes outside the
	// recent-window cluster median — eliminates the rogue stale-buffer
	// fixes that otherwise drive overnight place-bouncing.
	// HMM-specific GPS outlier filter (more aggressive than the
	// velocity-pipeline qualityFilterGps which preserves no-bridge
	// sustained-motion fixes by design).
	const cleanedPoints = dropGpsOutliers(velResult.points);
	const tensor = buildObservationTensor({
		date,
		tz,
		points: cleanedPoints,
		hr: biom.hr,
		steps: biom.steps,
		sleep: biom.sleep,
	});
	const states = buildStateSpace({ focusPlaces: cache.focusPlaces, knownLines: KNOWN_LINES });
	const placeCoords = new Map<number, { lat: number; lon: number }>();
	const placeHourProfiles = new Map<number, readonly number[]>();
	const placeVisitWeights = new Map<number, number>();
	const totalDwell = cache.focusPlaces.reduce((s, p) => s + p.totalDwellSec, 0);
	for (const p of cache.focusPlaces) {
		placeCoords.set(p.id, { lat: p.lat, lon: p.lon });
		if (p.hourProfile !== null) placeHourProfiles.set(p.id, p.hourProfile);
		placeVisitWeights.set(p.id, totalDwell > 0 ? p.totalDwellSec / totalDwell : 1 / cache.focusPlaces.length);
	}
	const transition = buildTransitionMatrix({
		states,
		placeNearLine: (placeId, lineName) => cache.placeNearLine.has(`${placeId}|${lineName}`),
	});
	const baseEmission = buildEmissionFn({
		placeCoords,
		learnedEmissions: cache.learnedEmissions ?? undefined,
	});
	const geometricFn = buildGeometricFeasibility({ placeCoords });
	const routeRailFn = buildRouteRailEvidence({ routeGraph: cache.routeGraph });
	const lineProximityFn = buildLineProximityFactor({ routeGraph: cache.routeGraph });
	const emission = (state: State, obs: (typeof tensor)[number]): number =>
		baseEmission(state, obs) + geometricFn(state, obs) + routeRailFn(state, obs) + lineProximityFn(state, obs);
	const initialLogProb = buildInitialStatePrior();
	const entryLogProb = buildEntryPrior({ placeHourProfiles, placeVisitWeights });
	const hmmStates = cache.useHsmm
		? hsmmViterbi({
				observations: tensor,
				states,
				transitionLogProb: transition,
				emissionLogProb: emission,
				initialLogProb,
				entryLogProb,
				durationLogProb: (state, d) =>
					logDurationProb(d, state.mode, BASELINE_DURATION_FITS[state.mode], DEFAULT_MIN_DURATION_BY_MODE[state.mode]),
			})
		: viterbi({
				observations: tensor,
				states,
				transitionLogProb: transition,
				emissionLogProb: emission,
				initialLogProb,
			});
	let marginals: Marginals | null = null;
	if (cache.marginals && cache.useHsmm) {
		const marginalsResult = hsmmMarginals({
			observations: tensor,
			states,
			transitionLogProb: transition,
			emissionLogProb: emission,
			initialLogProb,
			entryLogProb,
			durationLogProb: (state, d) =>
				logDurationProb(d, state.mode, BASELINE_DURATION_FITS[state.mode], DEFAULT_MIN_DURATION_BY_MODE[state.mode]),
		});
		marginals = marginalsResult.marginals;
	}
	const dt = Date.now() - t0;
	console.error(
		`  [${date}] decoded in ${dt}ms (heuristic + HMM${marginals ? " + marginals" : ""}): tensor=${tensor.length}min, states=${states.length}, segments=${velResult.segments.length}`,
	);
	return { date, tensor, heuristicSegments: velResult.segments, hmmStates, states, marginals };
}

function heuristicModeForMinute(segments: readonly EnrichedSegment[], ts: number): string {
	const seg = segments.find((s) => s.startTs <= ts && ts < s.endTs);
	if (!seg) return "(no-seg)";
	return seg.refinedMode ?? seg.mode;
}

interface DisagreementCell {
	count: number;
	samples: Array<{ ts: number; obs: Observation; hmmKey: string }>;
}

function buildConfusionMatrix(result: DayResult): {
	totalMinutes: number;
	agreeMinutes: number;
	cells: Map<string, DisagreementCell>;
} {
	const cells = new Map<string, DisagreementCell>();
	let total = 0;
	let agree = 0;
	for (let m = 0; m < result.tensor.length; m++) {
		const obs = result.tensor[m];
		const hMode = heuristicModeForMinute(result.heuristicSegments, obs.ts);
		const hmmState = result.hmmStates[m];
		const hmmMode = hmmState.mode;
		total++;
		if (hMode === hmmMode) {
			agree++;
			continue;
		}
		const key = `${hMode} → ${hmmMode}`;
		let cell = cells.get(key);
		if (!cell) {
			cell = { count: 0, samples: [] };
			cells.set(key, cell);
		}
		cell.count++;
		if (cell.samples.length < 5) cell.samples.push({ ts: obs.ts, obs, hmmKey: stateKey(hmmState) });
	}
	return { totalMinutes: total, agreeMinutes: agree, cells };
}

function formatObs(o: Observation): string {
	const parts: string[] = [];
	parts.push(`gps=${o.gps ? `${o.gps.speedKmh.toFixed(0)}km/h` : "null"}`);
	parts.push(`hr=${o.hr === null ? "null" : o.hr.toFixed(0)}`);
	parts.push(`cad=${o.cadence === null ? "null" : o.cadence}`);
	return parts.join(" ");
}

function formatTime(ts: number, tz: string): string {
	return new Date(ts * 1000).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
}

function heuristicRowFor(seg: EnrichedSegment): string {
	const mode = seg.refinedMode ?? seg.mode;
	const parts: string[] = [mode];
	if (seg.place) parts.push(`@ ${seg.place}`);
	if (seg.wayName) parts.push(`on ${seg.wayName}`);
	return parts.join(" ");
}

function placeLabel(placeId: number, places: readonly PlaceWithCoords[]): string {
	const p = places.find((q) => q.id === placeId);
	if (!p) return `#${placeId}`;
	return p.displayName ?? `#${placeId}`;
}

function hmmStateLabel(s: State, places: readonly PlaceWithCoords[]): string {
	if (s.mode === "stationary") {
		if (s.placeId === null) return "stationary @ (none)";
		return `stationary @ ${placeLabel(s.placeId, places)}`;
	}
	if (s.mode === "train") return `train · ${s.lineName ?? "?"}`;
	return s.mode;
}

/** Render a marginals-based summary of the day's posterior. For each
 *  hour, surface the top-3 most-likely state aggregates (mode +
 *  place) with their cumulative probability mass.
 *
 *  This is the architectural endpoint of the probabilistic-system
 *  framing: instead of committing to a single MAP guess, expose
 *  the posterior distribution so downstream presentation can
 *  reflect the model's actual confidence. */
function renderMarginalsConfidence(result: DayResult, places: readonly PlaceWithCoords[], tz: string): string {
	if (result.marginals === null) return "";
	const lines: string[] = [];
	lines.push("");
	lines.push("```");
	lines.push("# Posterior confidence per hour — top states with probability mass");
	lines.push("   Hour    Top 1                       Top 2                       Top 3");
	lines.push("   ------  --------------------------  --------------------------  --------------------------");
	const T = result.tensor.length;
	// Aggregate marginals per hour by averaging per-minute distributions.
	for (let hourStart = 0; hourStart < T; hourStart += 60) {
		const hourEnd = Math.min(T, hourStart + 60);
		const aggregate = new Float64Array(result.states.length);
		let n = 0;
		for (let m = hourStart; m < hourEnd; m++) {
			const row = result.marginals[m];
			for (let s = 0; s < aggregate.length; s++) aggregate[s] += row[s];
			n++;
		}
		if (n > 0) for (let s = 0; s < aggregate.length; s++) aggregate[s] /= n;

		const sorted = Array.from({ length: aggregate.length }, (_, s) => ({ s, p: aggregate[s] }))
			.filter((x) => x.p > 0)
			.sort((a, b) => b.p - a.p)
			.slice(0, 3);

		const startTs = result.tensor[hourStart].ts;
		const endTs = hourEnd < T ? result.tensor[hourEnd].ts : result.tensor[hourEnd - 1].ts + 60;
		const span = `${formatTime(startTs, tz)}-${formatTime(endTs, tz)}`;
		const cells = sorted.map((x) => {
			const label = hmmStateLabel(result.states[x.s], places);
			const pct = (x.p * 100).toFixed(0).padStart(3);
			return `${pct}% ${label.padEnd(20).slice(0, 20)}`;
		});
		while (cells.length < 3) cells.push("");
		lines.push(`   ${span.padEnd(7)}  ${cells.join("  ")}`);
	}
	lines.push("```");
	return lines.join("\n");
}

function renderSideBySide(result: DayResult, places: readonly PlaceWithCoords[], tz: string): string {
	const lines: string[] = [];
	lines.push("");
	lines.push("```");
	lines.push("   Time           Heuristic                            HMM");
	lines.push("   -------------  -----------------------------------  -----------------------------------");
	type Row = { startMin: number; endMin: number; heur: string; hmm: string };
	const rows: Row[] = [];
	for (let m = 0; m < result.tensor.length; m++) {
		const ts = result.tensor[m].ts;
		const hSeg = result.heuristicSegments.find((s) => s.startTs <= ts && ts < s.endTs);
		const heur = hSeg ? heuristicRowFor(hSeg) : "(no segment)";
		const hmm = hmmStateLabel(result.hmmStates[m], places);
		const prev = rows[rows.length - 1];
		if (prev && prev.heur === heur && prev.hmm === hmm) {
			prev.endMin = m;
		} else {
			rows.push({ startMin: m, endMin: m, heur, hmm });
		}
	}
	for (const r of rows) {
		const startTs = result.tensor[r.startMin].ts;
		const endTs =
			r.endMin + 1 < result.tensor.length ? result.tensor[r.endMin + 1].ts : result.tensor[r.endMin].ts + 60;
		const span = `${formatTime(startTs, tz)}-${formatTime(endTs, tz)}`;
		const heurCol = r.heur.padEnd(36).slice(0, 36);
		const hmmCol = r.hmm.padEnd(36).slice(0, 36);
		const tag = r.heur === r.hmm ? "   " : " ≠ ";
		lines.push(`${tag}${span.padEnd(13)}  ${heurCol} ${hmmCol}`);
	}
	lines.push("```");
	return lines.join("\n");
}

async function main(): Promise<void> {
	const { userId, tz, dates, modelVersion, render, hsmm, marginals } = parseArgs();
	initPool(config.db);
	await withConnection(migrate);

	console.error(`# HMM vs heuristic audit — user=${userId} tz=${tz}`);
	console.error(`# dates: ${dates.join(", ")}`);
	console.error(`# model: ${modelVersion ?? "hand-tuned MODE_PRIORS (no learned override)"}`);
	console.error(`# decoder: ${hsmm ? "HSMM (explicit-duration)" : "Markov Viterbi"}`);
	console.error();

	// Per-user lookups loaded once and reused across dates.
	console.error(`# loading user state (focus_places + station-graph${modelVersion ? " + learned model" : ""})`);
	const focusPlaces = await loadFocusPlacesForUser(userId);
	const placeNearLine = await buildPlaceNearLine(focusPlaces, KNOWN_LINES);
	const bbox = bboxFromFixes(focusPlaces.map((p) => ({ lat: p.lat, lon: p.lon })));
	if (bbox === null) throw new Error("no focus places — cannot build route graph");
	const routeGraph = await loadRouteGraphForBbox(bbox, { featureTypes: ["railway"] });
	console.error(`# loaded ${routeGraph.edges.size} rail edges for route-rail-evidence`);
	const learnedEmissions = modelVersion ? await loadLearnedModel(userId, modelVersion) : null;
	console.error(`  ${focusPlaces.length} focus_places, ${placeNearLine.size} place-line pairs in walking distance`);

	let allMinutes = 0;
	let allAgree = 0;
	const aggCells = new Map<string, DisagreementCell>();

	for (const date of dates) {
		try {
			const result = await decodeDay(userId, date, tz, {
				focusPlaces,
				placeNearLine,
				routeGraph,
				learnedEmissions,
				useHsmm: hsmm,
				marginals,
			});
			const { totalMinutes, agreeMinutes, cells } = buildConfusionMatrix(result);
			allMinutes += totalMinutes;
			allAgree += agreeMinutes;
			for (const [k, v] of cells.entries()) {
				let agg = aggCells.get(k);
				if (!agg) {
					agg = { count: 0, samples: [] };
					aggCells.set(k, agg);
				}
				agg.count += v.count;
				for (const s of v.samples) {
					if (agg.samples.length < 5) agg.samples.push(s);
				}
			}
			console.log(`\n## ${date}`);
			console.log(`agreement: ${agreeMinutes}/${totalMinutes} (${((agreeMinutes / totalMinutes) * 100).toFixed(1)}%)`);
			const sorted = [...cells.entries()].sort((a, b) => b[1].count - a[1].count);
			if (sorted.length > 0) {
				console.log(`disagreements:`);
				for (const [k, v] of sorted) {
					console.log(`  ${k}: ${v.count} min`);
				}
			}
			if (render) {
				console.log(renderSideBySide(result, focusPlaces, tz));
			}
			if (marginals) {
				console.log(renderMarginalsConfidence(result, focusPlaces, tz));
			}
		} catch (e) {
			console.error(`  [${date}] FAILED: ${e}`);
		}
	}

	console.log(`\n## AGGREGATE (${dates.length} days)`);
	console.log(
		`agreement: ${allAgree}/${allMinutes} (${allMinutes ? ((allAgree / allMinutes) * 100).toFixed(1) : "n/a"}%)`,
	);
	const aggSorted = [...aggCells.entries()].sort((a, b) => b[1].count - a[1].count);
	if (aggSorted.length > 0) {
		console.log(`\ntop disagreement cells:`);
		for (const [k, v] of aggSorted.slice(0, 20)) {
			console.log(`\n  ${k}: ${v.count} min`);
			for (const s of v.samples) {
				console.log(`    ${formatTime(s.ts, tz)} ${tz}  hmm=${s.hmmKey}  ${formatObs(s.obs)}`);
			}
		}
	}

	process.exit(0);
}

await main();

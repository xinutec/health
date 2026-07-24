/**
 * V8 reference values for the Lean port of the factor-scoring cluster
 * (`src/geo/factors/`): the six factors plus the aggregator.
 *
 * Run:
 *   nix develop /Users/pippijn/Code/health --command \
 *     npx tsx /Users/pippijn/Code/health/lean/experiments/factors-refs.mts
 */

import { scoreCandidates } from "../../src/geo/factors/aggregator.js";
import { modePrior } from "../../src/geo/factors/mode-prior.js";
import { osmDistance } from "../../src/geo/factors/osm-distance.js";
import { modeCoherence } from "../../src/geo/factors/mode-coherence.js";
import { classifierPrior } from "../../src/geo/factors/classifier-prior.js";
import { railCorridor } from "../../src/geo/factors/rail-corridor.js";
import { speedEmission } from "../../src/geo/factors/speed-emission.js";
import { biometricLL } from "../../src/geo/factors/biometric-ll.js";
import type { Factor, FactorContext, ModeCandidate } from "../../src/geo/factors/types.js";
import type { ModeStats, MinuteObservation } from "../../src/geo/mode-biometrics.js";
import type { TransportMode, WindowFeatures } from "../../src/geo/segments.js";

const f = (x: number): string =>
	Number.isFinite(x) ? x.toPrecision(17) : x > 0 ? "+inf" : x < 0 ? "-inf" : "nan";
const fs = (s: { score: number } | null): string => (s === null ? "null" : f(s.score));

function cand(mode: TransportMode, opts: Partial<ModeCandidate> = {}): ModeCandidate {
	return { mode, ...opts };
}

console.log("=== modePrior ===");
for (const m of ["cycling", "walking", "driving", "train", "stationary", "plane"] as TransportMode[]) {
	console.log(`${m}: ${fs(modePrior(cand(m), {}))}`);
}

console.log("");
console.log("=== osmDistance ===");
for (const d of [undefined, 0, 0.5, 1, 2, 5, 25, 30, 50, 100, 1000]) {
	const c = d === undefined ? cand("driving") : cand("driving", { wayDistanceM: d });
	console.log(`d=${d ?? "undefined"}: ${fs(osmDistance(c, {}))}`);
}
console.log(`d=NaN: ${fs(osmDistance(cand("driving", { wayDistanceM: Number.NaN }), {}))}`);
console.log(`d=Infinity: ${fs(osmDistance(cand("driving", { wayDistanceM: Number.POSITIVE_INFINITY }), {}))}`);

console.log("");
console.log("=== modeCoherence ===");
const SUBTYPES = [
	"footway", "path", "pedestrian", "cycleway", "bridleway", "steps",
	"motorway", "trunk", "primary", "secondary", "tertiary", "residential",
	"service", "unclassified", "track", "living_street",
	"rail", "subway", "light_rail", "tram", "monorail", "narrow_gauge",
	"runway", "taxiway", "aerodrome", "terminal",
	"river", "canal", "unknown_thing",
];
for (const mode of ["driving", "walking", "cycling", "train", "plane", "stationary", "boat"] as TransportMode[]) {
	const row = SUBTYPES.map((s) => `${s}=${fs(modeCoherence(cand(mode, { waySubtype: s }), {}))}`);
	console.log(`${mode}:`);
	for (const r of row) console.log(`  ${r}`);
}
// No subtype at all → factor does not apply.
console.log(`driving no-subtype: ${fs(modeCoherence(cand("driving"), {}))}`);
console.log(`driving empty-subtype: ${fs(modeCoherence(cand("driving", { waySubtype: "" }), {}))}`);

console.log("");
console.log("=== classifierPrior ===");
function cp(mode: TransportMode, originalMode: TransportMode | undefined, margin: number | undefined): string {
	const ctx: FactorContext = {};
	if (originalMode !== undefined) ctx.originalMode = originalMode;
	if (margin !== undefined) ctx.confidenceMargin = margin;
	return fs(classifierPrior(cand(mode), ctx));
}
console.log(`no original: ${cp("driving", undefined, 5)}`);
console.log(`no margin: ${cp("driving", "driving", undefined)}`);
console.log(`mode mismatch: ${cp("walking", "driving", 5)}`);
// The floor is EXCLUSIVE: margin 2 returns null, 2.0001 does not.
console.log(`margin 1: ${cp("driving", "driving", 1)}`);
console.log(`margin 2: ${cp("driving", "driving", 2)}`);
console.log(`margin 2.0001: ${cp("driving", "driving", 2.0001)}`);
console.log(`margin 3: ${cp("driving", "driving", 3)}`);
console.log(`margin 3.8: ${cp("driving", "driving", 3.8)}`);
console.log(`margin 7.4: ${cp("driving", "driving", 7.4)}`);
console.log(`margin 14: ${cp("driving", "driving", 14)}`);
console.log(`margin 1000 (capped): ${cp("driving", "driving", 1000)}`);

console.log("");
console.log("=== railCorridor ===");
function rc(mode: TransportMode, rail: number | null | undefined, road: number | null | undefined): string {
	const ctx: FactorContext = {};
	if (rail !== undefined) ctx.meanRailDistM = rail;
	if (road !== undefined) ctx.meanDrivableRoadDistM = road;
	return fs(railCorridor(cand(mode), ctx));
}
console.log(`train, both missing: ${rc("train", undefined, undefined)}`);
console.log(`train, rail null: ${rc("train", null, 40)}`);
console.log(`train, road null: ${rc("train", 2, null)}`);
console.log(`walking (n/a): ${rc("walking", 2, 40)}`);
console.log(`train 2 vs 40: ${rc("train", 2, 40)}`);
console.log(`driving 2 vs 40: ${rc("driving", 2, 40)}`);
console.log(`train 40 vs 2: ${rc("train", 40, 2)}`);
console.log(`train equal: ${rc("train", 10, 10)}`);
console.log(`train 0 vs 0: ${rc("train", 0, 0)}`);
console.log(`train 0 vs 2500: ${rc("train", 0, 2500)}`);

console.log("");
console.log("=== speedEmission (speed-only fallback) ===");
for (const mode of ["stationary", "walking", "cycling", "driving", "train", "plane", "boat"] as TransportMode[]) {
	const row = [0, 1, 2, 5, 8, 8.5, 10, 15, 15.5, 25, 25.5, 28, 40, 40.5, 80, 200, 250].map(
		(kmh) => `${kmh}=${fs(speedEmission(cand(mode), { speedKmh: kmh }))}`,
	);
	console.log(`${mode}: ${row.join(" ")}`);
}
console.log(`no speed, no features: ${fs(speedEmission(cand("driving"), {}))}`);

console.log("");
console.log("=== speedEmission (windowFeatures path) ===");
/** Every field of the REAL WindowFeatures must be set — a missing one
 *  propagates NaN through scoreWindow and collapses every mode to
 *  -Infinity, which would pin garbage rather than behaviour. */
function wf(o: Partial<WindowFeatures>): WindowFeatures {
	return {
		startTs: 0,
		endTs: 600,
		centroidLat: 51.52,
		centroidLon: -0.13,
		medianSpeed: 0,
		maxSpeed: 0,
		speedVariance: 0,
		headingChangeRate: 0,
		linearity: 0.5,
		accelerationBursts: 0,
		stopFraction: 0,
		netDisplacement: 0,
		boundingRadius: 100,
		pointCount: 60,
		...o,
	};
}
const FEATS: [string, WindowFeatures][] = [
	[
		"still",
		wf({ medianSpeed: 0.2, maxSpeed: 1, speedVariance: 0.1, boundingRadius: 5, stopFraction: 0.95, netDisplacement: 3, linearity: 0.1 }),
	],
	[
		"walk",
		wf({ medianSpeed: 4.5, maxSpeed: 7, speedVariance: 1.2, linearity: 0.4, headingChangeRate: 20, stopFraction: 0.05, netDisplacement: 700, boundingRadius: 400 }),
	],
	[
		"drive",
		wf({ medianSpeed: 35, maxSpeed: 60, speedVariance: 80, linearity: 0.8, headingChangeRate: 5, accelerationBursts: 4, netDisplacement: 5000, boundingRadius: 2600 }),
	],
	[
		"train",
		wf({ medianSpeed: 70, maxSpeed: 110, speedVariance: 120, linearity: 0.95, headingChangeRate: 1, netDisplacement: 11000, boundingRadius: 5600 }),
	],
];
for (const [label, feats] of FEATS) {
	const row = (["stationary", "walking", "cycling", "driving", "train", "plane"] as TransportMode[]).map(
		(m) => `${m}=${fs(speedEmission(cand(m), { windowFeatures: feats }))}`,
	);
	console.log(`${label}: ${row.join(" ")}`);
}
// windowFeatures takes precedence over speedKmh when both are present.
console.log(
	`precedence (walk feats + 99 kmh, walking): ${fs(
		speedEmission(cand("walking"), { windowFeatures: FEATS[1][1], speedKmh: 99 }),
	)}`,
);

console.log("");
console.log("=== biometricLL ===");
const obs = (hr: number | null, cadence: number | null, speed: number | null): MinuteObservation =>
	({ hr, cadence, speed }) as MinuteObservation;
const st = (
	mode: TransportMode,
	o: Partial<ModeStats> = {},
): ModeStats =>
	({
		mode,
		hrMean: 100,
		hrStd: 10,
		cadenceMean: 60,
		cadenceStd: 15,
		speedMean: 20,
		speedStd: 5,
		sampleCount: 100,
		...o,
	}) as ModeStats;
console.log(`no obs: ${fs(biometricLL(cand("driving"), { modeStats: [st("driving")] }))}`);
console.log(`no stats: ${fs(biometricLL(cand("driving"), { biometricObs: obs(100, 60, 20) }))}`);
console.log(
	`no stats for mode: ${fs(biometricLL(cand("train"), { biometricObs: obs(100, 60, 20), modeStats: [st("driving")] }))}`,
);
console.log(
	`at the mean: ${fs(biometricLL(cand("driving"), { biometricObs: obs(100, 60, 20), modeStats: [st("driving")] }))}`,
);
console.log(
	`1 sigma off: ${fs(biometricLL(cand("driving"), { biometricObs: obs(110, 75, 25), modeStats: [st("driving")] }))}`,
);
console.log(
	`far off: ${fs(biometricLL(cand("driving"), { biometricObs: obs(180, 200, 90), modeStats: [st("driving")] }))}`,
);
// All-null observation → no modality contributes → -Infinity → mapped to null.
console.log(
	`all-null obs: ${fs(biometricLL(cand("driving"), { biometricObs: obs(null, null, null), modeStats: [st("driving")] }))}`,
);
console.log(
	`hr only: ${fs(biometricLL(cand("driving"), { biometricObs: obs(100, null, null), modeStats: [st("driving")] }))}`,
);

console.log("");
console.log("=== scoreCandidates (aggregator) ===");
const ALL: Factor[] = [speedEmission, osmDistance, modeCoherence, classifierPrior, railCorridor, modePrior, biometricLL];
function agg(label: string, cands: ModeCandidate[], ctx: FactorContext, factors: Factor[] = ALL): void {
	const r = scoreCandidates(cands, ctx, factors);
	const alts = r.alternatives.map((a) => `${a.mode}/${a.wayName ?? "-"}=${f(a.totalScore)}`).join(" ");
	console.log(
		`${label}: best=${r.best.mode}/${r.best.wayName ?? "-"} total=${f(r.best.totalScore)} ` +
			`nfactors=${r.best.factors.length} margin=${f(r.margin)} alts=[${alts}]`,
	);
}
// Single candidate: margin is +Infinity.
agg("single", [cand("driving", { wayDistanceM: 25 })], { speedKmh: 30 });
// The wayName tie-break: identical scores, the labelled way wins.
agg(
	"wayName tie-break",
	[cand("walking", { wayDistanceM: 25 }), cand("walking", { wayDistanceM: 25, wayName: "Queen's Walk" })],
	{ speedKmh: 4 },
	[osmDistance],
);
// Reverse input order — the labelled one still wins, so it is not just stability.
agg(
	"wayName tie-break reversed",
	[cand("walking", { wayDistanceM: 25, wayName: "Queen's Walk" }), cand("walking", { wayDistanceM: 25 })],
	{ speedKmh: 4 },
	[osmDistance],
);
// All-equal, all-unlabelled: input order is preserved (V8 sort stability).
agg(
	"stable on full tie",
	[cand("walking", { wayDistanceM: 25 }), cand("driving", { wayDistanceM: 25 })],
	{},
	[osmDistance],
);
// The calibration case the docs call out: a tube line underfoot must not
// beat walking on a walking-pace segment.
agg(
	"tube underfoot at walking pace",
	[
		cand("walking", { wayDistanceM: 20, waySubtype: "footway", wayName: "Marchmont St" }),
		cand("train", { wayDistanceM: 2, waySubtype: "subway", wayName: "Piccadilly" }),
	],
	{ speedKmh: 4.5 },
);
// Rail corridor discriminating train from driving at vehicular speed.
agg(
	"rail corridor picks train",
	[
		cand("train", { wayDistanceM: 2, waySubtype: "subway", wayName: "Jubilee" }),
		cand("driving", { wayDistanceM: 40, waySubtype: "primary", wayName: "A41" }),
	],
	{ speedKmh: 45, meanRailDistM: 2, meanDrivableRoadDistM: 40 },
);
// Same geometry, road-hugging: driving wins.
agg(
	"road corridor picks driving",
	[
		cand("train", { wayDistanceM: 40, waySubtype: "subway", wayName: "Jubilee" }),
		cand("driving", { wayDistanceM: 2, waySubtype: "primary", wayName: "A41" }),
	],
	{ speedKmh: 45, meanRailDistM: 40, meanDrivableRoadDistM: 2 },
);
// The cycling penalty: a confidently-cycling original with biometric
// agreement must still not out-score driving without extra evidence.
agg(
	"cycling penalty holds",
	[cand("cycling", { wayDistanceM: 25 }), cand("driving", { wayDistanceM: 25 })],
	{ speedKmh: 20, originalMode: "cycling", confidenceMargin: 10 },
);
// A -Infinity from speed-emission rules a candidate out entirely.
agg(
	"minus-infinity candidate loses",
	[cand("train", { wayDistanceM: 1, waySubtype: "subway" }), cand("walking", { wayDistanceM: 200 })],
	{ windowFeatures: FEATS[1][1] },
);
// When BOTH candidates score -Infinity the comparator computes
// (-inf) - (-inf) = NaN. ECMAScript treats a NaN comparator result as 0,
// so the wayName tie-break never runs and input order is preserved — and
// the margin is NaN, not 0. Pinned because the obvious Lean transcription
// (compare scores, then fall through to the wayName rule when equal)
// silently disagrees on both counts.
const negInf: Factor = () => ({ name: "neg", score: Number.NEGATIVE_INFINITY, rationale: "" });
agg("both -inf, unnamed first", [cand("walking"), cand("walking", { wayName: "Named" })], {}, [negInf]);
agg("both -inf, named first", [cand("walking", { wayName: "Named" }), cand("walking")], {}, [negInf]);

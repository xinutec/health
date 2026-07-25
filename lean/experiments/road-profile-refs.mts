/**
 * V8 reference values for the Lean port of `src/geo/road-match.ts` — the
 * `ROAD_PROFILE` tuning and the `matchRoadSegment` wrapper over the shared
 * matcher core.
 *
 * `road-match.ts` is a thin adapter: everything it calls (`matchTrajectory`)
 * is already Lean as `qMatchTrajectory`. What is NOT yet Lean is the profile
 * itself — and the road profile is not just "walk with different numbers". Two
 * of its fields drive code paths the walk guards never reach:
 *
 *   - `wayContinuityNats: 5` — the road turn-prior. `WALK_PROFILE` sets it to
 *     0, so every existing guard runs with the switch penalty DISABLED. The
 *     scenario below is sized so the prior alone decides: a drive pulls onto a
 *     parallel service road, and the penalty is what keeps the matched line on
 *     the street it started on.
 *   - `buildingCrossFactor: 1` — buildings OFF (`> 1` is the guard in
 *     `matchTrajectory`). A road caller supplies no building layer anyway, but
 *     the wrapper passes `geo` wholesale, so the port must reproduce the guard
 *     rather than assume the layer is empty.
 *
 * The quantised field values are DERIVED here from the float `ROAD_PROFILE`
 * rather than hand-transcribed, so retuning the profile shows up as a guard
 * failure instead of silent drift. The reference matcher output comes from the
 * BigInt twin (`match-twin.ts`), which is the pinned integer semantics the Lean
 * matcher already implements — Lean must equal the twin bit-for-bit.
 *
 * Run:
 *   nix develop /Users/pippijn/Code/health --command \
 *     npx tsx /Users/pippijn/Code/health/lean/experiments/road-profile-refs.mts
 */

import {
	type QMatchProfile,
	type QWay,
	qMatchTrajectory,
	WALK_QPROFILE,
} from "../../src/geo/match-twin.js";
import { type QPt, quantPt } from "../../src/geo/quant-twin.js";
import { ROAD_PROFILE } from "../../src/geo/road-match.js";

const lines: string[] = [];
const say = (label: string, value: string): void => lines.push(`${label} = ${value}`);
const section = (name: string): void => lines.push(`\n=== ${name} ===`);

// ---------------------------------------------------------------------------
// The profile, quantised

/** Metres → µm, as an exact integer (every profile length is a whole number of
 *  µm at these magnitudes; assert rather than trust). */
const um = (m: number): bigint => {
	const v = m * 1e6;
	if (!Number.isInteger(v)) throw new Error(`profile length ${m} m is not a whole µm`);
	return BigInt(v);
};

/** A float fraction as an exact num/den over the given denominator. */
const frac = (x: number, den: bigint): bigint => {
	const n = x * Number(den);
	if (!Number.isInteger(n)) throw new Error(`fraction ${x} is not exact over /${den}`);
	return BigInt(n);
};

const ROAD_QPROFILE: QMatchProfile = {
	minFixes: ROAD_PROFILE.minFixes,
	radiusUm: um(ROAD_PROFILE.matchRadiusM),
	maxCandidatesPerFix: ROAD_PROFILE.maxCandidatesPerFix,
	sigmaUm: um(ROAD_PROFILE.sigmaZ),
	betaUm: um(ROAD_PROFILE.beta),
	gapBridgeUm: um(ROAD_PROFILE.gapBridgeM),
	detourFactor: BigInt(ROAD_PROFILE.detourFactor),
	detourSlackUm: um(ROAD_PROFILE.detourSlackM),
	maxLenNum: frac(ROAD_PROFILE.maxLenFactor, 5n),
	maxLenDen: 5n,
	maxLenSlackUm: um(ROAD_PROFILE.maxLenSlackM),
	maxRoadlessNum: frac(ROAD_PROFILE.maxRoadlessFraction, 5n),
	maxRoadlessDen: 5n,
	corridorNearUm: um(ROAD_PROFILE.corridorNearM),
	corridorFarUm: um(ROAD_PROFILE.corridorFarM),
	corridorMaxPenalty: BigInt(ROAD_PROFILE.corridorMaxPenalty),
	wayContinuityNats: BigInt(ROAD_PROFILE.wayContinuityNats),
	spurReturnUm: um(ROAD_PROFILE.spurReturnM),
	spurMaxSpanVerts: ROAD_PROFILE.spurMaxSpanVerts,
	simplifyTolUm: um(ROAD_PROFILE.simplifyToleranceM),
	buildingCrossFactor: BigInt(ROAD_PROFILE.buildingCrossFactor),
	buildingSupportUm: um(ROAD_PROFILE.buildingSupportM),
};

section("ROAD_QPROFILE — derived from the float ROAD_PROFILE");
for (const [k, v] of Object.entries(ROAD_QPROFILE)) say(k, String(v));

section("road vs walk — the fields that differ");
for (const k of Object.keys(ROAD_QPROFILE) as Array<keyof QMatchProfile>) {
	if (String(ROAD_QPROFILE[k]) !== String(WALK_QPROFILE[k])) {
		say(k, `road=${ROAD_QPROFILE[k]} walk=${WALK_QPROFILE[k]}`);
	}
}

// ---------------------------------------------------------------------------
// Scenario geometry.
//
// Sizing the discriminator is the whole difficulty, because three terms fight:
//
//   emission gain   Δ(d²)·β        accumulates over EVERY fix on the better way
//   switch cost     nats·2σ²·β     paid once per way change
//   transition      |Δroute|·2σ²   paid once, for the detour the crossing adds
//
// So a case where the prior decides needs many fixes clearly nearer the second
// way (to out-earn the transition) but a total gain still under one switch. Two
// ways 6 m apart — inside the 8 m road bridge, so the hop is routable with a
// ~6 m detour — and ten fixes sitting on the second one puts the gain at ~2×
// the transition and ~4.5× under the 5-nat bar. A zero-penalty matcher takes
// the hop; the road profile holds its way.

const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111_320;
const MLON = 1 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));
/** North/east metres from the frame origin → a quantised point. */
const P = (n: number, e: number, ts = 0): QPt => quantPt({ lat: LAT0 + n * MLAT, lon: LON0 + e * MLON, ts });

/** The through street, 400 m east, vertices every 50 m. */
const HIGH: QWay = {
	coords: [0, 50, 100, 150, 200, 250, 300, 350, 400].map((e) => P(0, e)),
	name: "High Street",
};
/** A service road alongside its eastern half, 6 m north, sharing eastings so
 *  every pair bridges. */
const SERVICE: QWay = { coords: [200, 250, 300, 350, 400].map((e) => P(6, e)), name: "Service Road" };
const WAYS: QWay[] = [HIGH, SERVICE];

/** A drive that runs the street, then pulls onto the service road and stays
 *  there: four fixes on `High Street`, ten on `Service Road`. */
const DRIFT: QPt[] = [
	...[20, 80, 140, 190].map((e, i) => P(0, e, 1000 + i * 30)),
	...[205, 225, 245, 265, 285, 305, 325, 345, 365, 385].map((e, i) => P(6, e, 1120 + i * 30)),
];

/** A plain run down the western half, where only `High Street` exists. */
const STRAIGHT: QPt[] = [0, 30, 60, 90, 120, 150, 180].map((e, i) => P(-2, e, 1000 + i * 30));

/** A track 300 m north of anything mapped — off-network past the 50 m radius. */
const FAR: QPt[] = [0, 50, 100, 150, 200].map((e, i) => P(300, e, 1000 + i * 30));

/** A footprint straddling the eastern half of both ways. */
const BLOCK: QPt[] = [P(-10, 200), P(10, 200), P(10, 400), P(-10, 400), P(-10, 200)];

const showPath = (label: string, r: { path: QPt[]; routeDetail: QPt[] } | null): void => {
	if (r === null) {
		say(label, "null");
		return;
	}
	say(`${label} path`, r.path.map((p) => `${p.la},${p.lo},${p.ts}`).join(" "));
	say(`${label} detail`, r.routeDetail.map((p) => `${p.la},${p.lo},${p.ts}`).join(" "));
};

section("scenario input (quantised — feed Lean these integers verbatim)");
for (const [name, w] of [
	["High Street", HIGH],
	["Service Road", SERVICE],
] as Array<[string, QWay]>) {
	say(`way ${name}`, w.coords.map((p) => `${p.la},${p.lo}`).join(" "));
}
say("drift fixes", DRIFT.map((p) => `${p.la},${p.lo},${p.ts}`).join(" "));
say("straight fixes", STRAIGHT.map((p) => `${p.la},${p.lo},${p.ts}`).join(" "));
say("far fixes", FAR.map((p) => `${p.la},${p.lo},${p.ts}`).join(" "));
say("block ring", BLOCK.map((p) => `${p.la},${p.lo}`).join(" "));

section("wayContinuityNats — the road turn prior");
// Identical input, one field changed. The road profile holds the line on `High
// Street` for the whole drive; dropping the prior to 0 lets the same matcher
// follow the fixes onto `Service Road` — the end latitude tells them apart
// (515200000 = High Street, 515200539 = Service Road).
showPath("drift @ road", qMatchTrajectory(DRIFT, WAYS, [], ROAD_QPROFILE));
showPath("drift @ road, nats=0", qMatchTrajectory(DRIFT, WAYS, [], { ...ROAD_QPROFILE, wayContinuityNats: 0n }));
showPath("straight @ road", qMatchTrajectory(STRAIGHT, WAYS, [], ROAD_QPROFILE));

section("buildings are off at buildingCrossFactor 1");
// A footprint straddling the eastern half. `qMatchTrajectory` builds the
// building penalty only when `buildingCrossFactor > 1`, so at the road profile's
// 1 the layer is inert and the result is byte-identical to the no-buildings run
// above — which is the whole reason a road caller may pass `geo` wholesale. The
// penalty machinery itself is pinned by the walk guards, not here.
showPath("drift @ road + buildings", qMatchTrajectory(DRIFT, WAYS, [BLOCK], ROAD_QPROFILE));
showPath(
	"drift @ road + buildings, factor 25",
	qMatchTrajectory(DRIFT, WAYS, [BLOCK], {
		...ROAD_QPROFILE,
		buildingCrossFactor: 25n,
		buildingSupportUm: 15_000_000n,
	}),
);

section("the wrapper's bails and its one option");
// `matchRoadSegment` has exactly one knob: `matchRadiusM`, spliced over the
// profile. Below minFixes, and off-network past the radius, both return null.
showPath("two fixes (< minFixes 3)", qMatchTrajectory(STRAIGHT.slice(0, 2), WAYS, [], ROAD_QPROFILE));
showPath("no ways", qMatchTrajectory(STRAIGHT, [], [], ROAD_QPROFILE));
showPath("300 m off-network (> 50 m radius)", qMatchTrajectory(FAR, WAYS, [], ROAD_QPROFILE));
showPath("300 m off-network @ radius 400 m", qMatchTrajectory(FAR, WAYS, [], { ...ROAD_QPROFILE, radiusUm: um(400) }));
// A radius override tight enough that only the nearer way is a candidate at all.
showPath("drift @ radius 3 m", qMatchTrajectory(DRIFT, WAYS, [], { ...ROAD_QPROFILE, radiusUm: um(3) }));

console.log(lines.join("\n"));

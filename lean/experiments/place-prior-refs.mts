/**
 * V8 reference values for the Lean port of `src/geo/place-prior.ts` and
 * `src/geo/place-snap.ts`.
 *
 * Run:
 *   nix develop /Users/pippijn/Code/health --command \
 *     npx tsx /Users/pippijn/Code/health/lean/experiments/place-prior-refs.mts
 */

import { scorePlaceForSegment, pickBestPlace, magnetStrength, type PlaceCandidate } from "../../src/geo/place-prior.js";
import { snapToPlace, haversineMeters, type KnownPlace } from "../../src/geo/place-snap.js";

const f = (x: number): string => (Number.isFinite(x) ? x.toPrecision(17) : String(x));

/** An hour profile concentrated on the given hours (equal mass each). */
function profile(hours: number[]): number[] {
	const p = new Array(24).fill(0);
	for (const h of hours) p[h] = 1 / hours.length;
	return p;
}
const UNIFORM = new Array(24).fill(1 / 24);
const DAYTIME = profile([9, 10, 11, 12, 13, 14, 15, 16, 17]);
const EVENING = profile([19, 20, 21, 22]);

function C(
	id: number,
	lat: number,
	lon: number,
	radiusM: number,
	uniqueDays: number,
	hourProfile: number[] | null,
): PlaceCandidate {
	return { id, centroidLat: lat, centroidLon: lon, radiusM, uniqueDays, hourProfile };
}

// A London anchor point and places at controlled offsets from it.
const LAT = 51.5205;
const LON = -0.1275;
/** Roughly `m` metres north of the anchor. */
const north = (m: number): number => LAT + m / 111_320;

console.log("=== haversineMeters ===");
console.log(`anchor->100m north = ${f(haversineMeters(LAT, LON, north(100), LON))}`);
console.log(`anchor->anchor = ${f(haversineMeters(LAT, LON, LAT, LON))}`);
console.log(`51.52,-0.13 -> 51.53,-0.12 = ${f(haversineMeters(51.52, -0.13, 51.53, -0.12))}`);

console.log("");
console.log("=== magnetStrength ===");
for (const d of [0, 1, 10, 100, 500]) {
	console.log(`uniqueDays=${d} => ${f(magnetStrength(C(1, LAT, LON, 25, d, null)))}`);
}

console.log("");
console.log("=== scorePlaceForSegment ===");
function showScore(label: string, c: PlaceCandidate, lat: number, lon: number, stayHourProfile: readonly number[], bio?: number): void {
	console.log(`${label}: ${f(scorePlaceForSegment(c, lat, lon, { stayHourProfile, biometricCoherence: bio }))}`);
}
// Established place (Work), one-off place, and an un-mined profile.
const work = C(1, LAT, LON, 25, 120, DAYTIME);
const oneOff = C(2, LAT, LON, 25, 1, EVENING);
const unmined = C(3, LAT, LON, 25, 30, null);

showScore("work at centroid, daytime stay", work, LAT, LON, DAYTIME);
showScore("work 100m away, daytime stay", work, north(100), LON, DAYTIME);
showScore("work 300m away, daytime stay", work, north(300), LON, DAYTIME);
showScore("work at centroid, evening stay", work, LAT, LON, EVENING);
showScore("work at centroid, uniform stay", work, LAT, LON, UNIFORM);
showScore("one-off at centroid, evening stay", oneOff, LAT, LON, EVENING);
showScore("one-off 100m away, evening stay", oneOff, north(100), LON, EVENING);
showScore("unmined profile scores 0 on time", unmined, LAT, LON, DAYTIME);
showScore("uniform place profile scores ~0", C(4, LAT, LON, 25, 30, UNIFORM), LAT, LON, DAYTIME);
showScore("empty stay profile", work, LAT, LON, new Array(24).fill(0));
// Magnet boost only applies with positive biometric coherence AND inside radius.
showScore("work at centroid, bio=1", work, LAT, LON, DAYTIME, 1);
showScore("work 100m, bio=1", work, north(100), LON, DAYTIME, 1);
showScore("work 400m (outside magnet), bio=1", work, north(400), LON, DAYTIME, 1);
showScore("work at centroid, bio=0.5", work, LAT, LON, DAYTIME, 0.5);
showScore("one-off at centroid, bio=1", oneOff, LAT, LON, EVENING, 1);
// A large empirical radius overrides the floor.
showScore("wide place (radius 300) at 200m", C(5, LAT, LON, 300, 50, null), north(200), LON, UNIFORM);

console.log("");
console.log("=== pickBestPlace ===");
function showPick(
	label: string,
	cands: PlaceCandidate[],
	lat: number,
	lon: number,
	stayHourProfile: readonly number[],
	bio?: number,
): void {
	const r = pickBestPlace(cands, lat, lon, { stayHourProfile, biometricCoherence: bio });
	console.log(`${label}: ${r === null ? "null" : `id=${r.winner.id} score=${f(r.score)}`}`);
}
showPick("empty", [], LAT, LON, DAYTIME);
showPick("work at centroid", [work], LAT, LON, DAYTIME);
// The 3σ veto: work's σ floor is ~100 m, so 3σ ≈ 300 m.
showPick("work 250m", [work], north(250), LON, DAYTIME);
showPick("work 299m", [work], north(299), LON, DAYTIME);
showPick("work 305m", [work], north(305), LON, DAYTIME);
showPick("work 500m", [work], north(500), LON, DAYTIME);
// The absolute far-reach cap: a once-seen place is capped at 90 m even though
// its 3σ reach would be 120 m (the Wembley "Selekt Chicken" shape).
showPick("one-off 85m", [oneOff], north(85), LON, EVENING);
showPick("one-off 95m", [oneOff], north(95), LON, EVENING);
showPick("one-off 118m", [oneOff], north(118), LON, EVENING);
// Two visit-days already lifts the cap above the 3σ reach.
showPick("2-day place 100m", [C(6, LAT, LON, 25, 2, EVENING)], north(100), LON, EVENING);
// Co-located candidates separated only by time-of-day.
const cafe = C(7, north(50), LON, 25, 20, DAYTIME);
const home = C(8, north(50), LON, 25, 200, EVENING);
showPick("co-located, daytime stay", [cafe, home], north(50), LON, DAYTIME);
showPick("co-located, evening stay", [cafe, home], north(50), LON, EVENING);
// A far established place must not steal from a near one (Pizza-Union-as-Work).
showPick("near one-off beats far work", [work, C(9, north(400), LON, 25, 1, EVENING)], north(400), LON, EVENING);
// Veto relaxation under magnet x coherence.
showPick("work 320m, bio=0", [work], north(320), LON, DAYTIME, 0);
showPick("work 320m, bio=1", [work], north(320), LON, DAYTIME, 1);
showPick("work 700m, bio=1", [work], north(700), LON, DAYTIME, 1);
// Posterior floor: a distant, low-history place scores below -8.
showPick("sparse place at 200m", [C(10, LAT, LON, 25, 1, null)], north(200), LON, UNIFORM);

console.log("");
console.log("=== snapToPlace ===");
function K(lat: number, lon: number, radiusM?: number, id?: string | number): KnownPlace {
	return radiusM === undefined ? { centroidLat: lat, centroidLon: lon, id } : { centroidLat: lat, centroidLon: lon, radiusM, id };
}
function showSnap(
	label: string,
	lat: number,
	lon: number,
	accuracy: number | null,
	places: KnownPlace[],
	opts?: Record<string, number>,
): void {
	const r = snapToPlace({ lat, lon, accuracy }, places, opts);
	console.log(
		`${label}: snapped=${r.snapped} lat=${f(r.lat)} acc=${r.accuracy === null ? "null" : f(r.accuracy)}` +
			(r.snapped ? ` to=${r.snappedTo?.id} dist=${f(r.snapDistanceM!)}` : ""),
	);
}
showSnap("precise fix is trusted", north(20), LON, 10, [K(LAT, LON, 15, "home")]);
showSnap("null accuracy still snaps", north(20), LON, null, [K(LAT, LON, 15, "home")]);
showSnap("noisy fix snaps", north(20), LON, 50, [K(LAT, LON, 15, "home")]);
showSnap("default radius when omitted", north(20), LON, 50, [K(LAT, LON, undefined, "home")]);
showSnap("no places", north(20), LON, 50, []);
showSnap("out of snap radius", north(200), LON, 50, [K(LAT, LON, 15, "home")]);
showSnap("ambiguous runner-up", north(20), LON, 50, [K(LAT, LON, 15, "home"), K(north(35), LON, 15, "cafe")]);
showSnap("unambiguous runner-up", north(10), LON, 50, [K(LAT, LON, 15, "home"), K(north(60), LON, 15, "cafe")]);
showSnap("accuracy exactly at threshold", north(20), LON, 30, [K(LAT, LON, 15, "home")]);
showSnap("custom snapRadius", north(200), LON, 50, [K(LAT, LON, 15, "home")], { snapRadiusM: 250 });
showSnap("custom ambiguityRatio", north(20), LON, 50, [K(LAT, LON, 15, "home"), K(north(35), LON, 15, "cafe")], {
	ambiguityRatio: 1.1,
});

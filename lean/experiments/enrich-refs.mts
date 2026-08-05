/**
 * Reference values for `Verified.Geo.Enrich` and the two helpers
 * `Verified.Geo.RefineMode` grew with it (`sampleIdxs`, `dedupNearestWays`,
 * `rejectImplausibleDriving`).
 *
 * The subject is `enrichMovingSegment` (`src/geo/velocity.ts`), which is not
 * exported — it closes over `inputs.osm`. So what is pinned here is every piece
 * of it that IS reachable: the two `osm.ts` exports it calls, and the two pure
 * reductions written inline in it (`sampleIdxs`, the way dedup), computed here by
 * the same expressions the TS uses so a divergence in the transcription shows up
 * as a differing number rather than as a differing golden day.
 *
 * `#418`: nothing typechecks this file against its subject. The two inline
 * reductions are re-expressed rather than imported, which is exactly the drift
 * this repo has been bitten by twice — so they are written to mirror
 * `velocity.ts:798-839` line for line, and that block is the thing to diff when
 * this file and the Lean disagree.
 *
 * Run: TMPDIR=/tmp npx tsx lean/experiments/enrich-refs.mts
 */

import { commonCity, extractCity, rejectImplausibleDriving } from "../../src/geo/osm.js";
// `osm-adapter` re-imports these rather than declaring them, so a type-only
// import from there resolves to a local binding it does not re-export.
import type { NearbyWay, NominatimResult } from "../../src/geo/osm.js";

const addr = (a: Partial<NominatimResult["address"]>): NominatimResult =>
	({ address: a }) as NominatimResult;

console.log("== extractCity ==");
for (const [label, r] of [
	["null", null],
	["metro over city", addr({ state_district: "Greater London", city: "City of Westminster" })],
	["unrecognised district", addr({ state_district: "Gelderland", town: "Arnhem" })],
	["City of London", addr({ city: "City of London" })],
	["plain city", addr({ city: "Amsterdam" })],
	["village", addr({ village: "Otterlo" })],
	["municipality", addr({ municipality: "Ede" })],
	["nothing", addr({})],
] as const) {
	console.log(`  ${label.padEnd(22)} ${JSON.stringify(extractCity(r))}`);
}

console.log("== commonCity ==");
const london = addr({ state_district: "Greater London" });
const arnhem = addr({ city: "Arnhem" });
for (const [label, a, b] of [
	["same", london, london],
	["different", london, arnhem],
	["one null", london, null],
	["both null", null, null],
] as const) {
	console.log(`  ${label.padEnd(22)} ${JSON.stringify(commonCity(a, b))}`);
}

// `velocity.ts:704` — a ~110 m grid. Math.round is half-toward-+∞, so it is NOT
// symmetric about zero and the negative cases are the ones worth pinning.
const cityGrid = (n: number): number => Math.round(n * 1000) / 1000;
console.log("== cityGrid ==");
for (const n of [51.5024999, 51.5025, -0.1235, -0.1236]) {
	console.log(`  ${String(n).padEnd(22)} ${cityGrid(n)}`);
}

// `velocity.ts:798-801`.
const sampleIdxs = (n: number, count: number): number[] =>
	Array.from({ length: count }, (_, i) => Math.floor((i * (n - 1)) / Math.max(1, count - 1)));
console.log("== sampleIdxs ==");
for (const [n, c] of [
	[9, 5],
	[10, 5],
	[3, 3],
	[1, 1],
] as const) {
	console.log(`  n=${n} count=${c}`.padEnd(24) + JSON.stringify(sampleIdxs(n, c)));
}

// `velocity.ts:826-840`. The RESULT ORDER is the point: a key already in the Map
// keeps its original position when its value is replaced, so `pickBestHighway`
// sees first-SAMPLE order rather than nearest-first.
const way = (type: string, subtype: string, name: string | undefined, distanceM: number | undefined): NearbyWay =>
	({ type, subtype, name, distanceM }) as NearbyWay;
function dedupNearestWays(wayResults: NearbyWay[][]): NearbyWay[] {
	const byKey = new Map<string, NearbyWay>();
	for (const ways of wayResults) {
		for (const w of ways) {
			const key = `${w.type}/${w.subtype}/${w.name ?? ""}`;
			const existing = byKey.get(key);
			if (!existing) {
				byKey.set(key, w);
			} else {
				const existingD = existing.distanceM ?? Number.POSITIVE_INFINITY;
				const newD = w.distanceM ?? Number.POSITIVE_INFINITY;
				if (newD < existingD) byKey.set(key, w);
			}
		}
	}
	return [...byKey.values()];
}
console.log("== dedupNearestWays ==");
const SAMPLES: NearbyWay[][] = [
	[way("highway", "residential", "Midway", 12), way("highway", "footway", undefined, 3)],
	[way("highway", "residential", "Midway", 8), way("highway", "primary", "Holloway Road", 9)],
	[way("highway", "primary", "Holloway Road", 40), way("railway", "subway", "Piccadilly", 30)],
];
for (const w of dedupNearestWays(SAMPLES)) {
	console.log(`  ${w.type}/${w.subtype}/${w.name ?? ""} @ ${w.distanceM}`);
}

console.log("== rejectImplausibleDriving ==");
const SUBWAY = way("railway", "subway", "Metropolitan", 40);
const FAR_SUBWAY = way("railway", "subway", "Metropolitan", 140);
const MOTORWAY = way("highway", "motorway", "M1", 5);
const ARTERIAL = way("highway", "trunk", "Euston Road", 6);
for (const [label, mode, maxKmh, ways] of [
	["not driving", "walking", 99, [ARTERIAL, SUBWAY]],
	["under the bar", "driving", 80, [ARTERIAL, SUBWAY]],
	["on a motorway", "driving", 99, [MOTORWAY, SUBWAY]],
	["no subway in range", "driving", 99, [ARTERIAL, FAR_SUBWAY]],
	["demoted", "driving", 99, [ARTERIAL, SUBWAY]],
	["demoted, rounds up", "driving", 98.5, [ARTERIAL, SUBWAY]],
] as const) {
	const out = rejectImplausibleDriving({ mode, wayName: "Euston Road" }, maxKmh, [...ways]);
	console.log(`  ${label.padEnd(22)} ${JSON.stringify(out)}`);
}

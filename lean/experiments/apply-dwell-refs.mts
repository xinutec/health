#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `applyDwellContinuation`
 * (`src/geo/dwell-continuation.ts`), ported into
 * `Verified/Geo/DwellContinuation.lean`.
 *
 * The pure kernels (`meanDwellSec`, `dwellSurvival`, `dwellContinuation`) were
 * already ported and pinned by `dwell-refs.mts`; this covers the DayState
 * orchestration around them — anchor choice, the segment centroid, the place
 * match and the insertion.
 *
 * Prints the whole returned array as JSON, because the ANSWER is the array:
 * which state was chosen as the anchor only shows through where the
 * continuation lands and which optional fields it inherited.
 *
 * Run: npx tsx lean/experiments/apply-dwell-refs.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const D = await import(path.join(repo, "src/geo/dwell-continuation.ts"));

type State = Record<string, unknown>;
type Seg = Record<string, unknown>;
type Place = Record<string, unknown>;

const st = (startTs: number, endTs: number, mode: string, extra: State = {}): State => ({
	startTs,
	endTs,
	mode,
	...extra,
});

/** τ = 36000 s (10 h), so the 0.5 floor gives a horizon of 36000·ln2 ≈ 24953 s. */
const home = (extra: Place = {}): Place => ({
	centroidLat: 51.5,
	centroidLon: -0.2,
	totalDwellSec: 1_080_000,
	visitCount: 30,
	uniqueDays: 30,
	...extra,
});

const at = (lat: number, lon: number): Seg => ({ centroidLat: lat, centroidLon: lon });

const DAY_END = 1_000_000;

const run = (label: string, states: State[], segments: Seg[], places: Place[], dayEndTs = DAY_END): void => {
	const out = D.applyDwellContinuation({ states, segments, knownPlaces: places, dayEndTs });
	console.log(`${label.padEnd(26)} ${JSON.stringify(out)}`);
};

console.log("-- constants");
console.log(`MIN_ESTABLISH_DAYS ${D.MIN_ESTABLISH_DAYS}`);
console.log(`CONFIDENCE_FLOOR   ${D.CONFIDENCE_FLOOR}`);

console.log("\n-- applyDwellContinuation");
const stay = st(900_000, 950_000, "stationary", { place: "Home", tz: "Europe/London" });

run("happyPath", [stay], [at(51.5, -0.2)], [home()]);
run("noStates", [], [at(51.5, -0.2)], [home()]);
// The anchor is the latest-ENDING state that STARTED before the day end — not
// the array's last element.
run(
	"anchorNotLastElement",
	[stay, st(1_010_000, 1_040_000, "sleeping", { place: "Home" })],
	[at(51.5, -0.2)],
	[home()],
);
// …and endTs ties keep the EARLIER state, which shows through `place`.
run(
	"endTsTieKeepsEarlier",
	[st(900_000, 950_000, "stationary", { place: "First" }), st(910_000, 950_000, "stationary", { place: "Second" })],
	[at(51.5, -0.2)],
	[home()],
);
run("everyStateStartsPastDayEnd", [st(1_010_000, 1_040_000, "stationary", { place: "Home" })], [at(51.5, -0.2)], [home()]);
run("anchorIsMoving", [st(900_000, 950_000, "walking", { place: "Home" })], [at(51.5, -0.2)], [home()]);
run("anchorIsSleeping", [st(900_000, 950_000, "sleeping", { place: "Home" })], [at(51.5, -0.2)], [home()]);
run("anchorReachesDayEnd", [st(900_000, DAY_END, "stationary", { place: "Home" })], [at(51.5, -0.2)], [home()]);
// Optional-field inheritance: an EMPTY string is falsy in the TS spread and is
// dropped, so it does not survive as `place: ""`.
run("emptyPlaceDropped", [st(900_000, 950_000, "stationary", { place: "", tz: "" })], [at(51.5, -0.2)], [home()]);
run("noPlaceNoTz", [st(900_000, 950_000, "stationary")], [at(51.5, -0.2)], [home()]);

// The stay centroid is the LAST segment carrying one, not the last segment.
run("lastCentroidSkipsNull", [stay], [at(51.5, -0.2), { centroidLat: null, centroidLon: null }], [home()]);
// Two real centroids: the LATER one is the day's last stay, and only it is in
// reach of the place — so taking the first would refuse.
run("lastCentroidWins", [stay], [at(51.51, -0.2), at(51.5, -0.2)], [home()]);
run("noSegmentCentroid", [stay], [{}, { centroidLat: 51.5 }], [home()]);

// The place match: within max(120 m, radiusM), nearest wins, ties keep FIRST.
const far = home({ centroidLat: 51.51 });   // ~1.1 km away
run("noPlaceInReach", [stay], [at(51.5, -0.2)], [far]);
run("radiusExtendsReach", [stay], [at(51.5, -0.2)], [home({ centroidLat: 51.51, radiusM: 2000 })]);
run(
	"nearestWinsNotFirst",
	[stay],
	[at(51.5, -0.2)],
	[home({ centroidLat: 51.5008, uniqueDays: 30 }), home({ totalDwellSec: 108_000, visitCount: 30 })],
);
run(
	"distanceTieKeepsFirst",
	[stay],
	[at(51.5, -0.2)],
	[home({ centroidLon: -0.2 + 0.0005 }), home({ centroidLon: -0.2 - 0.0005, totalDwellSec: 108_000 })],
);

// The kernel's own refusals, reached THROUGH the pass.
run("placeTooYoung", [stay], [at(51.5, -0.2)], [home({ uniqueDays: 4 })]);
run("missingDwellStats", [stay], [at(51.5, -0.2)], [{ centroidLat: 51.5, centroidLon: -0.2, uniqueDays: 30 }]);
// Each missing stat refuses on its OWN — the `?? 0` defaults are not jointly
// protective, so a fixture predating either field is a refusal, not a guess.
run("missingTotalDwellOnly", [stay], [at(51.5, -0.2)], [{ centroidLat: 51.5, centroidLon: -0.2, uniqueDays: 30, visitCount: 30 }]);
run("missingVisitCountOnly", [stay], [at(51.5, -0.2)], [{ centroidLat: 51.5, centroidLon: -0.2, uniqueDays: 30, totalDwellSec: 1_080_000 }]);
// τ = 1 s: the horizon is ln2 = 0.69 s, which ROUNDS UP to a 1-second stay.
run("horizonRoundsToOne", [stay], [at(51.5, -0.2)], [home({ totalDwellSec: 30, visitCount: 30 })]);
// τ = 0.7 s: the horizon is 0.49 s, rounds to 0, and no room means no insert.
run("horizonRoundsToZero", [stay], [at(51.5, -0.2)], [home({ totalDwellSec: 21, visitCount: 30 })]);

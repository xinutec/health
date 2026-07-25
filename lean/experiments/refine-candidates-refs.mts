/**
 * V8 reference values for the Lean port of
 * `src/geo/factors/refine-mode-candidates.ts` — the candidate generator that
 * turns nearby OSM ways plus the classifier's `originalMode` into the labelling
 * space the factor aggregator scores.
 *
 * The module is wholly pure. Behaviours the guards pin:
 *   - way ORDER and per-way mode order are preserved into the output, and the
 *     `originalMode` fallback is always appended LAST;
 *   - the named/unnamed dedup is per MODE, and an empty-string name counts as
 *     unnamed (the TS tests `c.wayName && c.wayName.length > 0`);
 *   - the fallback is appended after both filters, so it survives a veto of its
 *     own mode — and can therefore duplicate a way-attached candidate.
 *
 * Note on the filter order: the TS runs the cadence veto before the dedup, but
 * `isCadenceImplausibleForMode` depends only on the candidate's MODE, so it
 * removes every candidate of a mode or none of them. It can therefore never
 * strand an unnamed candidate whose named sibling was vetoed, and the two
 * filters commute. The last case below pins them running together anyway.
 *
 * Run:
 *   nix develop /Users/pippijn/Code/health --command \
 *     npx tsx /Users/pippijn/Code/health/lean/experiments/refine-candidates-refs.mts
 */

import { generateRefineModeCandidates, type BiometricContext } from "../../src/geo/factors/refine-mode-candidates.js";
import type { ModeStats } from "../../src/geo/mode-biometrics.js";
import type { NearbyWay } from "../../src/geo/osm.js";

const lines: string[] = [];
const say = (label: string, value: string): void => lines.push(`${label} = ${value}`);
const section = (name: string): void => lines.push(`\n=== ${name} ===`);

const way = (type: string, subtype: string, name?: string, distanceM?: number): NearbyWay => ({
	type,
	subtype,
	...(name === undefined ? {} : { name }),
	...(distanceM === undefined ? {} : { distanceM }),
});

const show = (label: string, ways: NearbyWay[], original = "walking", bio?: BiometricContext): void => {
	const cs = generateRefineModeCandidates(original as never, ways, bio);
	say(
		label,
		cs
			.map((c) => `${c.mode}|${c.wayName ?? "-"}|${c.waySubtype ?? "-"}|${c.wayDistanceM ?? "-"}`)
			.join("  "),
	);
};

section("modesForWay — one way at a time");
show("railway rail", [way("railway", "rail", "West Coast Main Line", 5)]);
show("railway subway", [way("railway", "subway", "Metropolitan Line", 3)]);
show("aeroway runway", [way("aeroway", "runway", "09L/27R", 20)]);
show("aeroway taxiway", [way("aeroway", "taxiway", undefined, 20)]);
show("aeroway terminal", [way("aeroway", "terminal", "T5", 20)]);
show("highway cycleway", [way("highway", "cycleway", "Canal Path", 4)]);
show("highway footway", [way("highway", "footway", undefined, 2)]);
show("highway path", [way("highway", "path", undefined, 2)]);
show("highway pedestrian", [way("highway", "pedestrian", "Market Sq", 2)]);
show("highway bridleway", [way("highway", "bridleway", undefined, 2)]);
show("highway steps", [way("highway", "steps", undefined, 2)]);
show("highway motorway", [way("highway", "motorway", "M1", 30)]);
show("highway residential", [way("highway", "residential", "Barn Rise", 8)]);
show("highway service", [way("highway", "service", undefined, 8)]);
show("highway track", [way("highway", "track", undefined, 8)]);
show("highway living_street", [way("highway", "living_street", "Woonerf", 8)]);
show("highway unclassified", [way("highway", "unclassified", "Lane", 8)]);
// Neither driveable nor pedestrian nor cycleway — contributes nothing.
show("highway construction", [way("highway", "construction", "Closed Rd", 8)]);
show("waterway river", [way("waterway", "river", "Thames", 8)]);
show("unknown type", [way("power", "line", undefined, 8)]);
show("no ways at all", []);

section("ordering and the fallback");
// Way order and per-way mode order both survive; the fallback is last.
show("two ways, order preserved", [
	way("highway", "residential", "Barn Rise", 8),
	way("highway", "footway", undefined, 2),
]);
show("fallback mode is the original", [way("railway", "rail", "WCML", 5)], "train");
// The fallback can duplicate a way-attached candidate.
show("fallback duplicates a candidate", [way("highway", "footway", undefined, 2)], "walking");

section("named/unnamed dedup, per mode");
// The pavement (unnamed footway) and the road it parallels: walking appears
// from both, and the unnamed one is dropped.
show("named road beats unnamed pavement", [
	way("highway", "residential", "Barn Rise", 8),
	way("highway", "footway", undefined, 2),
]);
// No named candidate of that mode → the unnamed one is kept.
show("all unnamed, kept", [way("highway", "footway", undefined, 2), way("highway", "path", undefined, 3)]);
// Dedup is PER MODE: cycling has a name here, walking does not.
show("per-mode, not global", [
	way("highway", "cycleway", "Canal Path", 4),
	way("highway", "footway", undefined, 2),
]);
// An empty-string name counts as unnamed.
show("empty name is unnamed", [
	way("highway", "residential", "", 8),
	way("highway", "residential", "Barn Rise", 9),
]);

section("cadence veto");
const stats: ModeStats[] = [
	{
		mode: "driving",
		hrMean: 80,
		hrStd: 8,
		hrSampleCount: 500,
		cadenceMean: 4,
		cadenceStd: 3,
		cadenceSampleCount: 500,
		speedMean: 40,
		speedStd: 15,
		speedSampleCount: 500,
		sampleCount: 500,
	},
	{
		mode: "cycling",
		hrMean: 120,
		hrStd: 12,
		hrSampleCount: 300,
		cadenceMean: 10,
		cadenceStd: 5,
		cadenceSampleCount: 300,
		speedMean: 18,
		speedStd: 6,
		speedSampleCount: 300,
		sampleCount: 300,
	},
];
const bio = (cadence: number | undefined, speed: number | undefined): BiometricContext => ({
	obs: { hr: 90, cadence, speed },
	stats,
});
// Walking cadence at walking speed: driving and cycling are vetoed off the
// road, leaving walking — and the fallback.
show("cadence vetoes driving+cycling", [way("highway", "residential", "Barn Rise", 8)], "walking", bio(105, 4));
// Above the speed ceiling the veto premise fails, so nothing is dropped.
show("fast: veto premise fails", [way("highway", "residential", "Barn Rise", 8)], "walking", bio(105, 40));
// No cadence observation at all.
show("no cadence", [way("highway", "residential", "Barn Rise", 8)], "walking", bio(undefined, 4));
// The fallback survives a veto of its OWN mode.
show("fallback survives its own veto", [way("highway", "residential", "Barn Rise", 8)], "driving", bio(105, 4));
/* The interaction worth pinning: the cadence veto runs BEFORE the dedup, so
   removing the named road's cycling candidate lets the unnamed cycleway's
   cycling candidate survive where it would otherwise have been dropped. */
show(
	"veto changes what dedup sees",
	[way("highway", "residential", "Barn Rise", 8), way("highway", "cycleway", undefined, 2)],
	"walking",
	bio(105, 4),
);

console.log(lines.join("\n"));

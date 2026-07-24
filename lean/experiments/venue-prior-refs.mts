/**
 * V8 reference values for the Lean port of `src/geo/venue-prior.ts`.
 *
 * Run:
 *   nix develop /Users/pippijn/Code/health --command \
 *     npx tsx /Users/pippijn/Code/health/lean/experiments/venue-prior-refs.mts
 *
 * Covers the scorer (`rankVenues` + its parts), the hard attribution gate,
 * the soft responsibilities softmax, and both miners. Every value comes from
 * the shipping functions.
 *
 * NOTE on timezone: `rankVenues` reads opening hours through
 * `openFractionDuring`, which resolves minutes via `Intl` in the stay's tz.
 * That resolution stays SHELL in the Lean port, so the cases here pin the
 * *scores* for known open/closed outcomes; the tz→minute mapping itself is
 * covered by the opening-hours port.
 */

import {
	rankVenues,
	attributeStayVenue,
	stayResponsibilities,
	effectiveSampleSize,
	minePriors,
	minePriorsSoft,
	dwellBucket,
	categoryOfSubtype,
	localHourOf,
	type StayShape,
	type VenuePriors,
	type AttributedStay,
} from "../../src/geo/venue-prior.js";
import type { NearbyLandmark } from "../../src/geo/osm.js";

const f = (x: number): string => (Number.isFinite(x) ? x.toPrecision(17) : String(x));
const fn = (x: number | null): string => (x === null ? "null" : f(x));

function L(
	name: string,
	type: NearbyLandmark["type"],
	subtype: string,
	distanceM: number,
	extra: Partial<NearbyLandmark> = {},
): NearbyLandmark {
	return { name, type, subtype, distanceM, ...extra };
}

// A weekday-evening meal-length stay in London: 19:00-20:14 local.
const stay: StayShape = {
	startUnix: Date.UTC(2026, 4, 12, 18, 0, 0) / 1000, // 19:00 BST
	endUnix: Date.UTC(2026, 4, 12, 19, 14, 0) / 1000,
	tz: "Europe/London",
};

console.log("=== helpers ===");
for (const s of [0, 59, 600, 601, 2400, 2401, 9000, 9001, 100000]) {
	console.log(`dwellBucket(${s}) = ${dwellBucket(s)}`);
}
for (const st of ["restaurant", "hotel", "cinema", "pharmacy", "hospital", "station", "wormhole", "park"]) {
	console.log(`categoryOfSubtype(${st}) = ${categoryOfSubtype(st)}`);
}
console.log(`localHourOf(stay.start, Europe/London) = ${localHourOf(stay.startUnix, "Europe/London")}`);
console.log(`localHourOf(stay.start, UTC) = ${localHourOf(stay.startUnix, "UTC")}`);

console.log("");
console.log("=== rankVenues: no stay, no priors (distance + venue only) ===");
function showRank(label: string, lms: NearbyLandmark[], s: StayShape | null, p: VenuePriors | null): void {
	console.log(`-- ${label}`);
	for (const c of rankVenues(lms, s, p)) {
		console.log(
			`   ${c.landmark.name} total=${f(c.total)} dist=${f(c.parts.distance)} venue=${f(c.parts.venue)} ` +
				`shape=${fn(c.parts.shape)} hours=${fn(c.parts.hours)} nearField=${c.nearField}`,
		);
	}
}

// The pinned pickBestLandmark behaviours: a venue beats an area at comparable
// distance, but not across a big distance gap.
showRank("cafe 30m vs park 10m", [L("Cafe", "amenity", "cafe", 30), L("Park", "leisure", "park", 10)], null, null);
showRank("cafe 95m vs park 5m", [L("Cafe", "amenity", "cafe", 95), L("Park", "leisure", "park", 5)], null, null);
showRank(
	"enclosing institution outranks near point",
	[L("Clinic", "amenity", "clinic", 40, { enclosing: true }), L("Kiosk", "shop", "kiosk", 3)],
	null,
	null,
);
showRank(
	"near-field: clinic 8m beats cafe 28m",
	[L("Cafe", "amenity", "cafe", 28), L("Clinic", "amenity", "clinic", 8)],
	null,
	null,
);
showRank(
	"two near-field venues: nearer wins",
	[L("Far", "amenity", "cafe", 11), L("Near", "shop", "bakery", 4)],
	null,
	null,
);
showRank(
	"reverseGeocoded never near-field",
	[L("Geocoded", "amenity", "restaurant", 0, { reverseGeocoded: true }), L("Real", "amenity", "cafe", 9)],
	null,
	null,
);
showRank(
	"street furniture filtered out of the pool",
	[L("Post Box", "amenity", "post_box", 2), L("Cafe", "amenity", "cafe", 45)],
	null,
	null,
);
showRank("only furniture => ranked anyway", [L("Post Box", "amenity", "post_box", 2)], null, null);
showRank(
	"tie on total and distance => name collation",
	[L("Zebra", "amenity", "cafe", 20), L("apple", "amenity", "cafe", 20), L("Beta", "amenity", "cafe", 20)],
	null,
	null,
);

console.log("");
console.log("=== rankVenues: with stay + opening hours ===");
// Open during the stay vs closed during the stay (19:00-20:14 Tue).
showRank(
	"open vs closed at similar distance",
	[
		L("OpenResto", "amenity", "restaurant", 32, { openingHours: "Mo-Su 12:00-23:00" }),
		L("ClosedPharm", "amenity", "pharmacy", 18, { openingHours: "Mo-Fr 09:00-18:00" }),
	],
	stay,
	null,
);
showRank(
	"closed venue at 8m loses near-field status",
	[
		L("ClosedPharm", "amenity", "pharmacy", 8, { openingHours: "Mo-Fr 09:00-18:00" }),
		L("OpenResto", "amenity", "restaurant", 32, { openingHours: "Mo-Su 12:00-23:00" }),
	],
	stay,
	null,
);
showRank(
	"unparseable hours = no evidence",
	[L("Odd", "amenity", "cafe", 25, { openingHours: "sunrise-sunset" })],
	stay,
	null,
);
showRank("partial overlap", [L("Half", "amenity", "bar", 25, { openingHours: "Mo-Su 19:37-23:00" })], stay, null);

console.log("");
console.log("=== minePriors (hard attribution) ===");
const attributed: AttributedStay[] = [
	{ subtype: "cafe", durationSec: 1800, localHour: 10 },
	{ subtype: "cafe", durationSec: 3600, localHour: 11 },
	{ subtype: "restaurant", durationSec: 4800, localHour: 19 },
	{ subtype: "restaurant", durationSec: 5400, localHour: 20 },
	{ subtype: "restaurant", durationSec: 300, localHour: 13 },
	{ subtype: "pharmacy", durationSec: 400, localHour: 14 },
	{ subtype: "hospital", durationSec: 12000, localHour: 9 },
];
const priors = minePriors(attributed);
console.log(`totalVisits=${priors.totalVisits}`);
for (const [st, s] of Object.entries(priors.bySubtype)) {
	console.log(`  ${st}: visits=${s.visits} dwell=[${s.dwell.join(",")}] hoursNonZero=${s.hours
		.map((v, i) => (v > 0 ? `${i}:${v}` : null))
		.filter(Boolean)
		.join(" ")}`);
}
for (const [c, s] of Object.entries(priors.byCategory)) {
	console.log(`  cat ${c}: visits=${s!.visits} dwell=[${s!.dwell.join(",")}]`);
}
console.log(`negative hour wraps: ${JSON.stringify(minePriors([{ subtype: "cafe", durationSec: 60, localHour: -3 }]).bySubtype.cafe.hours)}`);

console.log("");
console.log("=== rankVenues with mined priors (shape term) ===");
showRank(
	"restaurant vs pharmacy, meal-length evening stay",
	[L("Resto", "amenity", "restaurant", 32), L("Pharm", "amenity", "pharmacy", 30)],
	stay,
	priors,
);
showRank(
	"unseen subtype falls back to category then uniform",
	[L("Bar", "amenity", "bar", 30), L("Wormhole", "amenity", "wormhole", 30)],
	stay,
	priors,
);
showRank("empty priors score exactly 0 shape", [L("Resto", "amenity", "restaurant", 30)], stay, {
	bySubtype: {},
	byCategory: {},
	totalVisits: 0,
});
showRank("leisure participates in the prior, place does not", [
	L("Park", "leisure", "park", 30),
	L("Square", "place", "square", 30),
], stay, priors);

console.log("");
console.log("=== attributeStayVenue ===");
function showAttr(label: string, lms: NearbyLandmark[]): void {
	const r = attributeStayVenue(lms);
	console.log(`${label}: ${r === null ? "null" : `${r.name}@${f(r.distanceM)}`}`);
}
showAttr("clear winner", [L("Cafe", "amenity", "cafe", 10), L("Shop", "shop", "books", 60)]);
showAttr("runner-up too close", [L("Cafe", "amenity", "cafe", 10), L("Shop", "shop", "books", 25)]);
showAttr("top too far", [L("Cafe", "amenity", "cafe", 35), L("Shop", "shop", "books", 90)]);
showAttr("exactly at the gate", [L("Cafe", "amenity", "cafe", 30), L("Shop", "shop", "books", 50)]);
showAttr("margin exactly 20", [L("Cafe", "amenity", "cafe", 10), L("Shop", "shop", "books", 30)]);
showAttr("same name twice then far other", [
	L("Cafe", "amenity", "cafe", 10),
	L("Cafe", "shop", "bakery", 12),
	L("Other", "shop", "books", 80),
]);
showAttr("only areas", [L("Park", "leisure", "park", 5)]);
showAttr("only furniture", [L("Post Box", "amenity", "post_box", 5)]);
showAttr("empty", []);

console.log("");
console.log("=== stayResponsibilities (softmax + other) ===");
function showResp(label: string, lms: NearbyLandmark[], s: StayShape | null): void {
	const r = stayResponsibilities(lms, s);
	console.log(
		`${label}: ${r.candidates.map((c) => `${c.landmark.name}=${f(c.r)}`).join(" ")} other=${f(r.other)} ess=${f(
			effectiveSampleSize([r]),
		)}`,
	);
}
showResp("two close venues", [L("A", "amenity", "cafe", 10), L("B", "amenity", "restaurant", 15)], null);
showResp("lone far venue", [L("A", "amenity", "cafe", 95)], null);
showResp("no candidates", [], null);
showResp("dense high street", [
	L("A", "amenity", "cafe", 8),
	L("B", "amenity", "restaurant", 12),
	L("C", "shop", "clothes", 16),
	L("D", "amenity", "bar", 20),
], null);
showResp("closed venue discounted", [
	L("Open", "amenity", "restaurant", 20, { openingHours: "Mo-Su 12:00-23:00" }),
	L("Closed", "amenity", "pharmacy", 20, { openingHours: "Mo-Fr 09:00-18:00" }),
], stay);
showResp("areas and furniture excluded", [L("Park", "leisure", "park", 5), L("Box", "amenity", "post_box", 3)], null);

console.log("");
console.log("=== minePriorsSoft ===");
const soft = minePriorsSoft([
	{
		responsibilities: stayResponsibilities([L("A", "amenity", "cafe", 10), L("B", "amenity", "restaurant", 15)], null),
		durationSec: 3600,
		localHour: 11,
	},
	{
		responsibilities: stayResponsibilities([L("C", "amenity", "cafe", 20)], null),
		durationSec: 5400,
		localHour: 19,
	},
]);
console.log(`soft totalVisits=${f(soft.totalVisits)}`);
for (const [st, s] of Object.entries(soft.bySubtype)) {
	console.log(`  ${st}: visits=${f(s.visits)} dwell=[${s.dwell.map(f).join(",")}]`);
}
for (const [c, s] of Object.entries(soft.byCategory)) {
	console.log(`  cat ${c}: visits=${f(s!.visits)}`);
}

console.log("");
console.log("=== localeCompare (the last-resort tie-break) ===");
const pairs: [string, string][] = [
	["a", "B"],
	["B", "a"],
	["Apple", "apple"],
	["apple", "Apple"],
	["The Library", "Urban Social"],
	["Zebra", "apple"],
	["Beta", "Zebra"],
	["10 Downing", "2 Downing"],
	["Cafe", "Café"],
	["cafe", "cafe"],
	// Where the ASCII-safe boundary is: ICU sorts punctuation < digits <
	// letters, which is NOT codepoint order ('_' is 0x5F, above 'A').
	["A", "1"],
	["1", "A"],
	["A", "_"],
	["_", "A"],
	["Cafe Rouge", "Cafe-Rouge"],
	["St. Pancras", "St Pancras"],
	["St Pancras", "StPancras"],
	["a b", "ab"],
	["a", "a "],
	["Co-op", "Coop"],
	["O'Neill", "ONeill"],
	["3", "10"],
	["Z", "a"],
	["z", "A"],
];
for (const [a, b] of pairs) {
	console.log(`${JSON.stringify(a)}.localeCompare(${JSON.stringify(b)}) = ${a.localeCompare(b)}`);
}
console.log(`default locale: ${Intl.DateTimeFormat().resolvedOptions().locale}`);

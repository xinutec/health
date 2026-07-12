import { describe, expect, it } from "vitest";
import type { EnrichedSegment } from "../src/geo/enriched-segment.js";
import { resolveVehicleIdentity } from "../src/geo/passes/vehicle-identity.js";

function seg(over: Partial<EnrichedSegment> = {}): EnrichedSegment {
	return {
		startTs: 0,
		endTs: 600,
		mode: "driving",
		confidence: 0.8,
		confidenceMargin: 2,
		avgSpeed: 40,
		maxSpeed: 60,
		linearity: 0.9,
		pointCount: 20,
		...over,
	} as EnrichedSegment;
}

const stay = (over: Partial<EnrichedSegment> = {}): EnrichedSegment =>
	seg({ mode: "stationary", place: "Home", ...over });

const modes = (segs: EnrichedSegment[]): string[] => segs.map((s) => s.refinedMode ?? s.mode);

describe("resolveVehicleIdentity", () => {
	// The 2026-07-12 bug: one minute into a Metropolitan Line ride the rail
	// passes had too little track to identify the line, nothing else claimed the
	// leg, and the trailing `driving` placeholder reached the UI as a confident
	// car — on rails, on no street. It is the *last* segment because the ride is
	// still happening.
	it("demotes the ride still in progress when no pass has claimed it", () => {
		const out = resolveVehicleIdentity([
			stay(),
			seg({ wayName: undefined, matchedPath: undefined, vehicleKind: undefined }),
		]);
		expect(modes(out)).toEqual(["stationary", "vehicle"]);
		expect(out[1].refinedReason).toMatch(/still in progress/);
	});

	// THE COUNTER-EXAMPLE THAT KILLED THE OBVIOUS RULE (2026-05-20 23:16–23:22).
	// A user-confirmed taxi home from Varley. It carries NO way name and NO road
	// match — the matcher simply failed on it — so "no road evidence ⇒ not a car"
	// would rename a real drive. It is finished (a Home stay follows), and that
	// is what makes it safe: only an unfinished ride is still a guess.
	it("leaves a finished drive alone even with no road evidence at all", () => {
		const out = resolveVehicleIdentity([seg({ wayName: undefined, matchedPath: undefined }), stay()]);
		expect(modes(out)).toEqual(["driving", "stationary"]);
		expect(out[0].refinedReason).toBeUndefined();
	});

	// The other counter-example (2026-05-25 12:41–12:55): one user-confirmed car
	// ride home that the segmenter splits in two, leaving the 12:52–12:55 tail
	// unnamed. Both halves are the same real drive; neither may be renamed.
	it("leaves an unnamed tail of a split drive alone", () => {
		const out = resolveVehicleIdentity([
			seg({ wayName: "Fulton Road", startTs: 0, endTs: 660 }),
			seg({ wayName: undefined, matchedPath: undefined, startTs: 660, endTs: 840 }),
			stay({ startTs: 840, endTs: 1200 }),
		]);
		expect(modes(out)).toEqual(["driving", "driving", "stationary"]);
	});

	// Mid-drive in a real car, once the matcher has placed it on a street, we DO
	// know what it is — the trailing position no longer matters.
	it("keeps the trailing leg as `driving` once a road has been matched", () => {
		const out = resolveVehicleIdentity([
			stay(),
			seg({ matchedPath: [{ lat: 51, lon: 0 }] } as Partial<EnrichedSegment>),
		]);
		expect(modes(out)).toEqual(["stationary", "driving"]);
	});

	it("keeps the trailing leg as `driving` once OSM has named the street", () => {
		const out = resolveVehicleIdentity([stay(), seg({ wayName: "Barn Rise" })]);
		expect(modes(out)).toEqual(["stationary", "driving"]);
	});

	// The bus matcher identified it — that IS the identification, and a leg named
	// from its route needs no road match.
	it("keeps a trailing bus, identified by route evidence", () => {
		const out = resolveVehicleIdentity([stay(), seg({ vehicleKind: "bus" } as Partial<EnrichedSegment>)]);
		expect(modes(out)).toEqual(["stationary", "driving"]);
		expect(out[1].vehicleKind).toBe("bus");
	});

	// Once the rail passes claim the leg it is a train. A train has no road match
	// by definition, so an unguarded rule would demote every tube ride — the very
	// bug this pass exists to fix.
	it("never touches a trailing train", () => {
		const out = resolveVehicleIdentity([stay(), seg({ mode: "driving", refinedMode: "train", wayName: undefined })]);
		expect(modes(out)).toEqual(["stationary", "train"]);
	});

	// Non-`driving` modes are none of this pass's business: `cycling` came from
	// cadence and heart rate, not from a road, so the absence of a road says
	// nothing about it.
	it("leaves a trailing walk or cycle alone", () => {
		expect(modes(resolveVehicleIdentity([stay(), seg({ mode: "walking", wayName: undefined })]))).toEqual([
			"stationary",
			"walking",
		]);
		expect(modes(resolveVehicleIdentity([stay(), seg({ mode: "cycling", wayName: undefined })]))).toEqual([
			"stationary",
			"cycling",
		]);
	});

	it("handles an empty day", () => {
		expect(resolveVehicleIdentity([])).toEqual([]);
	});
});

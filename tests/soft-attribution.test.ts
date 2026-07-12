import { describe, expect, it } from "vitest";
import type { NearbyLandmark } from "../src/geo/osm.js";
import { effectiveSampleSize, type StayShape, stayResponsibilities } from "../src/geo/venue-prior.js";

const venue = (name: string, subtype: string, distanceM: number, openingHours?: string): NearbyLandmark => ({
	name,
	type: subtype === "convenience" || subtype === "bakery" ? "shop" : "amenity",
	subtype,
	distanceM,
	...(openingHours ? { openingHours } : {}),
});

// The real 2026-06-28 Urban Social candidate set, as the mirror returns it.
const UPPER_STREET: NearbyLandmark[] = [
	venue("Green Shop", "convenience", 1),
	venue("Benita Bakery", "bakery", 3),
	venue("The Library", "pub", 6),
	venue("William Hill", "bookmaker", 7),
	venue("Urban Social Coffee", "cafe", 10),
	venue("KFC", "fast_food", 14),
];

const SIT: StayShape = { startUnix: 1782638278, endUnix: 1782642873, tz: "Europe/London" }; // 77 min, 10:17

const rOf = (r: ReturnType<typeof stayResponsibilities>, name: string): number =>
	r.candidates.find((c) => c.landmark.name === name)?.r ?? 0;

describe("stayResponsibilities — how much of a stay each venue may claim", () => {
	it("always sums to exactly 1 across the candidates plus `other`", () => {
		const r = stayResponsibilities(UPPER_STREET, SIT);
		const total = r.candidates.reduce((s, c) => s + c.r, 0) + r.other;
		expect(total).toBeCloseTo(1, 10);
	});

	it("gives an isolated venue nearly the whole stay", () => {
		const r = stayResponsibilities([venue("Lone Cafe", "cafe", 5)], SIT);
		expect(rOf(r, "Lone Cafe")).toBeGreaterThan(0.9);
		expect(r.other).toBeLessThan(0.1);
	});

	// The point of the whole design: on a dense high street NO venue may claim
	// the stay outright. The hard gate throws this stay away entirely; soft
	// attribution lets every candidate learn a fraction of it.
	it("spreads a dense high street across its candidates, committing to none", () => {
		const r = stayResponsibilities(UPPER_STREET, SIT);
		for (const c of r.candidates) {
			expect(c.r).toBeLessThan(0.5); // nobody owns this stay
			expect(c.r).toBeGreaterThan(0.01); // and nobody is dismissed
		}
		// The café is a genuine contender on geometry alone — it is not the
		// favourite (it is 10 m out), but it is very much in the running, which
		// is exactly the mass the current gate discards.
		expect(rOf(r, "Urban Social Coffee")).toBeGreaterThan(0.05);
	});

	// `other` mass rises monotonically as the only candidate recedes. This
	// ORDERING is structural and is what the design relies on. The absolute
	// magnitudes are NOT calibrated — OTHER_COMPONENT_NATS is provisional (see
	// its docstring), and P0's miner exists to fit it against the ~8% base rate
	// the referee measured. Asserting "a 95 m café gives >0.8 other" would be
	// asserting a number nobody has earned.
	it("shifts mass to `other` as the only candidate recedes", () => {
		const near = stayResponsibilities([venue("Cafe", "cafe", 5)], SIT).other;
		const mid = stayResponsibilities([venue("Cafe", "cafe", 50)], SIT).other;
		const far = stayResponsibilities([venue("Cafe", "cafe", 95)], SIT).other;
		expect(near).toBeLessThan(mid);
		expect(mid).toBeLessThan(far);
		expect(near).toBeLessThan(0.1); // a venue you are sitting on is not "somewhere else"
	});

	it("pins the current (uncalibrated) `other` split so a recalibration is a visible diff", () => {
		// Change this number when OTHER_COMPONENT_NATS is fitted. It is a
		// tripwire, not a target.
		expect(stayResponsibilities([venue("Distant Cafe", "cafe", 95)], SIT).other).toBeCloseTo(0.455, 2);
	});

	it("is empty (all `other`) when there are no venue candidates at all", () => {
		const r = stayResponsibilities([], SIT);
		expect(r.candidates).toHaveLength(0);
		expect(r.other).toBe(1);
	});

	it("lets opening hours move the mass — a venue closed during the sit claims less", () => {
		const open = venue("Open Cafe", "cafe", 8, "Mo-Su 00:00-24:00");
		const shut = venue("Shut Cafe", "cafe", 8, "Mo-Su 02:00-03:00");
		const r = stayResponsibilities([open, shut], SIT);
		expect(rOf(r, "Open Cafe")).toBeGreaterThan(rOf(r, "Shut Cafe") * 3);
	});

	it("never lets a mined prior influence the weights — the same landmarks give the same split", () => {
		// stayResponsibilities takes no priors argument BY CONSTRUCTION: feeding
		// the shape prior into the weights that train the shape prior is the
		// feedback loop that made focus_place #6053 self-confirm. This test
		// exists to make that a contract, not an accident of the signature.
		expect(stayResponsibilities.length).toBe(2); // (landmarks, stay) — no priors
	});

	it("ignores street furniture and reverse-geocoded pseudo-candidates", () => {
		const r = stayResponsibilities(
			[
				venue("Corner Cafe", "cafe", 8),
				{ ...venue("A Post Box", "post_box", 1), type: "amenity" },
				{ ...venue("Nominatim Guess", "cafe", 0), reverseGeocoded: true },
			],
			SIT,
		);
		expect(r.candidates.map((c) => c.landmark.name)).toEqual(["Corner Cafe"]);
	});
});

describe("effectiveSampleSize — the P0 stop condition", () => {
	it("counts the claimed mass, not the stays", () => {
		const isolated = stayResponsibilities([venue("Lone Cafe", "cafe", 5)], SIT);
		const dense = stayResponsibilities(UPPER_STREET, SIT);
		const hopeless = stayResponsibilities([venue("Distant Cafe", "cafe", 95)], SIT);

		// A clean stay is worth ~a whole visit of evidence.
		expect(effectiveSampleSize([isolated])).toBeGreaterThan(0.9);

		// THE POINT: a dense-high-street stay is worth nearly a whole visit too
		// — spread across its candidates. The hard gate scores it exactly 0.
		// This difference, multiplied across the history, is the whole proposal.
		expect(effectiveSampleSize([dense])).toBeGreaterThan(0.9);

		// A stay with nothing plausible nearby carries less evidence, which is
		// correct — but see the OTHER_COMPONENT_NATS docstring: HOW much less is
		// not yet calibrated. Only the ordering is asserted here.
		expect(effectiveSampleSize([hopeless])).toBeLessThan(effectiveSampleSize([isolated]));

		expect(effectiveSampleSize([isolated, dense, hopeless])).toBeCloseTo(
			effectiveSampleSize([isolated]) + effectiveSampleSize([dense]) + effectiveSampleSize([hopeless]),
			10,
		);
	});
});

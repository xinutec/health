/**
 * `decode ∘ encode = id` on real segments, states and episodes.
 *
 * The `LEAN_DAY=on` path rebuilds typed values from the wire, so a field the
 * encoder forgets is a field the served day silently loses — and the SHADOW
 * cannot report it, because both arms of that comparison run through the same
 * encoder. Nothing in the tenant's green verdict says the encoding is total.
 *
 * So the property under test is not really "the decoder works". It is that the
 * pair is lossless over values the pipeline actually produces, which fails if
 * either side forgets a field. The fixtures are the corpus's own segments where
 * one is available (`tests/golden/days` is gitignored, so the test falls back to
 * literals that carry every optional field at once).
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { EnrichedSegment } from "../src/geo/enriched-segment.js";
import type { EpisodeGeometry } from "../src/geo/episode-geometry.js";
import {
	decodeEpisode,
	decodeSeg,
	decodeState,
	graftEpisodes,
	graftShells,
	takeGrafted,
} from "../src/lean/day-decode.js";
import { encodeEpisode, encodeSeg, encodeState } from "../src/lean/fold-payload.js";
import type { DayState } from "../src/sleep/day-state.js";

/** Every optional the type has, set at once — the shape a partial encoder is
 *  most likely to drop something from. Values are deliberately awkward: a
 *  fractional vertex `ts` (#420), a null `hrMean` beside a non-null `hrMax`,
 *  and a `sleepFraction` that is not representable as a short decimal. */
const FULL_SEG: EnrichedSegment = {
	startTs: 1_778_804_979,
	endTs: 1_778_806_123,
	mode: "walking",
	confidence: 0.812_345_678_901_234_5,
	confidenceMargin: 2.5,
	avgSpeed: 4.732_1,
	maxSpeed: 9.9,
	linearity: 0.333_333_333_333_333_3,
	pointCount: 42,
	refinedMode: "walking",
	refinedReason: "cadence agrees",
	refinedKinds: ["low-cadence"],
	place: "Somewhere",
	city: "London",
	wayName: "Some Street",
	centroidLat: 51.549_2,
	centroidLon: -0.221_5,
	focusPlaceId: 1234,
	needsReenrich: true,
	vehicleKind: "bus",
	roadCorridorFraction: 0.75,
	displayTz: "Europe/London",
	snappedPath: [{ lat: 51.1, lon: -0.1, ts: 1_778_804_979.5 }],
	matchedPath: [{ lat: 51.2, lon: -0.2, ts: 1_778_805_000 }],
	walkMatchedPath: [{ lat: 51.3, lon: -0.3, ts: 1_778_805_100 }],
	walkSmoothedPath: [{ lat: 51.4, lon: -0.4, ts: 1_778_805_200 }],
	biometrics: {
		hrMean: null,
		hrMin: null,
		hrMax: 143,
		hrStd: 12.345,
		sampleCount: 7,
		overlapsSleep: false,
		sleepFraction: 0.123_456_789_012_345_66,
		stepsTotal: null,
	},
};

/** The other end: nothing optional at all. An encoder that wrote `null` and a
 *  decoder that read it back as a present-but-null key would pass the test
 *  above and fail this one. */
const BARE_SEG: EnrichedSegment = {
	startTs: 1_778_800_000,
	endTs: 1_778_800_600,
	mode: "stationary",
	confidence: 1,
	confidenceMargin: 3,
	avgSpeed: 0,
	maxSpeed: 0,
	linearity: 0,
	pointCount: 5,
};

describe("the day wire round-trips", () => {
	it("returns a fully-populated segment unchanged", () => {
		expect(decodeSeg(encodeSeg(FULL_SEG))).toEqual(FULL_SEG);
	});

	it("returns a bare segment unchanged, adding no keys", () => {
		const back = decodeSeg(encodeSeg(BARE_SEG));
		expect(back).toEqual(BARE_SEG);
		// `toEqual` treats an own key holding `undefined` as absent, and
		// `day-compare.canon` does not — it renders one and omits the other, so a
		// stray key would read as a divergence in the tenant while this test
		// stayed green. Assert the key SET too.
		expect(Object.keys(back).sort()).toEqual(Object.keys(BARE_SEG).sort());
	});

	it("keeps a fractional vertex timestamp exactly", () => {
		const back = decodeSeg(encodeSeg(FULL_SEG));
		expect(back.snappedPath?.[0].ts).toBe(1_778_804_979.5);
	});

	it("keeps a null biometric apart from a zero one", () => {
		const biom = FULL_SEG.biometrics;
		if (biom === undefined) throw new Error("FULL_SEG must carry biometrics for this test to mean anything");
		const zeroed: EnrichedSegment = { ...FULL_SEG, biometrics: { ...biom, stepsTotal: 0, hrMean: 0 } };
		expect(decodeSeg(encodeSeg(zeroed)).biometrics?.stepsTotal).toBe(0);
		expect(decodeSeg(encodeSeg(FULL_SEG)).biometrics?.stepsTotal).toBeNull();
	});

	it("round-trips a state with every optional, and one with none", () => {
		const full: DayState = {
			startTs: 1,
			endTs: 2,
			mode: "stationary",
			place: "Home",
			wayName: "Street",
			asleep: true,
			tz: "Europe/London",
			minutesAsleep: 411,
			inferred: true,
		};
		const bare: DayState = { startTs: 3, endTs: 4, mode: "walking" };
		expect(decodeState(encodeState(full))).toEqual(full);
		expect(decodeState(encodeState(bare))).toEqual(bare);
		expect(Object.keys(decodeState(encodeState(bare))).sort()).toEqual(Object.keys(bare).sort());
	});

	it("round-trips an episode, including a vertex with no timestamp", () => {
		const ep: EpisodeGeometry = {
			startTs: 10,
			endTs: 20,
			mode: "walking",
			kind: "matched",
			place: "Home",
			points: [
				{ lat: 51.5, lon: -0.1, ts: 12.25 },
				{ lat: 51.6, lon: -0.2 },
			],
		};
		const back = decodeEpisode(encodeEpisode(ep));
		expect(back).toEqual(ep);
		expect("ts" in back.points[1]).toBe(false);
	});
});

describe("the shells are grafted, and only where they are shells", () => {
	const leanSeg: EnrichedSegment = { ...FULL_SEG, walkMatchedPath: undefined, walkSmoothedPath: undefined };

	it("puts the TS solver paths back and leaves everything else alone", () => {
		const [got] = graftShells([{ ...leanSeg, place: "Lean says here" }], [FULL_SEG]) ?? [];
		expect(got.walkMatchedPath).toEqual(FULL_SEG.walkMatchedPath);
		expect(got.walkSmoothedPath).toEqual(FULL_SEG.walkSmoothedPath);
		// The graft must not become a general "prefer TS": a real divergence in a
		// field the fold DOES decide is the whole point of serving.
		expect(got.place).toBe("Lean says here");
	});

	it("refuses to graft across a count mismatch", () => {
		expect(graftShells([leanSeg], [FULL_SEG, FULL_SEG])).toBeUndefined();
	});

	// The condition that only started to matter when the fold got a host that
	// answers its own OSM lookups (#959). Before that the Lean arm never had a
	// path, so "fill the gap" and "prefer TS" were the same function — and the
	// unconditional version would now throw away geometry the fold really drew
	// and serve the TS line, making the host invisible.
	it("KEEPS Lean's own path where the fold drew one", () => {
		const drawnByLean = [{ lat: 51.5, lon: -0.1, ts: 1_778_804_979 }];
		const [got] = graftShells([{ ...leanSeg, walkMatchedPath: drawnByLean }], [FULL_SEG]) ?? [];
		expect(got.walkMatchedPath).toEqual(drawnByLean);
		// …and still fills the one the fold left alone.
		expect(got.walkSmoothedPath).toEqual(FULL_SEG.walkSmoothedPath);
	});

	const raw = (e: EpisodeGeometry): EpisodeGeometry => ({ ...e, kind: "raw", points: [{ lat: 0, lon: 0 }] });
	const drawn: EpisodeGeometry = {
		startTs: 1,
		endTs: 2,
		mode: "walking",
		kind: "matched",
		points: [{ lat: 51, lon: -0.1 }],
	};

	it("takes the TS episode where the Lean one fell back to raw chords", () => {
		expect(graftEpisodes([raw(drawn)], [drawn])).toEqual([drawn]);
	});

	it("serves a Lean episode that differs for any OTHER reason", () => {
		// Both arms raw, different geometry: nothing about a missing solver
		// explains this, so it is exactly what `on` is for.
		const tsRaw = raw(drawn);
		const leanRaw: EpisodeGeometry = { ...tsRaw, points: [{ lat: 9, lon: 9 }] };
		expect(graftEpisodes([leanRaw], [tsRaw])).toEqual([leanRaw]);
	});

	it("does not take the TS episode when the kinds disagree in any other way", () => {
		const tsAnchor: EpisodeGeometry = { ...drawn, kind: "anchor" };
		const leanRaw = raw(drawn);
		expect(graftEpisodes([leanRaw], [tsAnchor])).toEqual([leanRaw]);
	});

	// #959 deletes both halves once this reads zero across live days, so the
	// counter has to be trustworthy in both directions before it is evidence.
	describe("counts what it took, so the deletion can be measured", () => {
		beforeEach(() => {
			takeGrafted();
		});

		it("counts a fill and a replaced episode", () => {
			graftShells([leanSeg], [FULL_SEG]);
			graftEpisodes([raw(drawn)], [drawn]);
			expect(takeGrafted()).toEqual({ fields: 2, episodes: 1 });
		});

		it("counts NOTHING when the fold drew everything itself", () => {
			graftShells([FULL_SEG], [FULL_SEG]);
			graftEpisodes([drawn], [drawn]);
			expect(takeGrafted()).toEqual({ fields: 0, episodes: 0 });
		});

		// A field TS does not have either is not a graft — otherwise every day
		// with a segment neither arm drew would read as a counter-example and
		// the deletion would never clear.
		it("does not count a field that is absent on BOTH sides", () => {
			const neither: EnrichedSegment = { ...FULL_SEG, walkMatchedPath: undefined, walkSmoothedPath: undefined };
			graftShells([leanSeg], [neither]);
			expect(takeGrafted().fields).toBe(0);
		});

		it("resets, so a count belongs to one day", () => {
			graftShells([leanSeg], [FULL_SEG]);
			takeGrafted();
			expect(takeGrafted()).toEqual({ fields: 0, episodes: 0 });
		});
	});
});

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

import { describe, expect, it } from "vitest";
import type { EnrichedSegment } from "../src/geo/enriched-segment.js";
import type { EpisodeGeometry } from "../src/geo/episode-geometry.js";
import { decodeEpisode, decodeSeg, decodeState } from "../src/lean/day-decode.js";
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

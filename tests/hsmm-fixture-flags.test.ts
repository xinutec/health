/**
 * The decode-flag configuration a golden-hsmm fixture carries.
 *
 * A fixture that records no configuration replays under whatever the loader
 * happens to default to — and for the whole v1 corpus that default was every
 * C4 flag OFF, while production runs them ON. That silently split the corpus:
 * `golden-hsmm` could never go green and `score-decoder` reported regressions
 * that did not exist. These tests pin the contract that closes it.
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_DECODE_FLAGS,
	type DecodeFlags,
	decodeFlagsFor,
	type HsmmCapturedDay,
	hsmmInputsFromFixture,
	toSerializedHsmmInputs,
} from "../src/cli/hsmm-fixture.js";
import type { HsmmInputs } from "../src/hmm/decode.js";

const bareInputs = (over: Partial<HsmmInputs> = {}): HsmmInputs => ({
	date: "2026-01-01",
	tz: "Europe/London",
	points: [],
	hr: [],
	steps: [],
	sleep: [],
	places: [],
	placeNearLine: new Set(),
	routeGraph: { nodes: [], adjacency: new Map() } as unknown as HsmmInputs["routeGraph"],
	continuityContext: null,
	proximityByMinute: new Map(),
	railStopRelations: [],
	...over,
});

const capturedWith = (decodeFlags: DecodeFlags | undefined): HsmmCapturedDay => ({
	meta: {
		fixtureFormatVersion: decodeFlags ? 2 : 1,
		capturedAt: "2026-01-01T00:00:00.000Z",
		capturedAtCodeSha: "deadbeef",
		date: "2026-01-01",
		user: "test",
		tz: "Europe/London",
		description: "",
	},
	inputs: {
		points: [],
		hr: [],
		steps: [],
		sleep: [],
		places: [],
		placeNearLine: [],
		rawOsmLines: [],
		rawOsmPoints: [],
		continuityContext: null,
		proximityByMinute: [],
		...(decodeFlags ? { decodeFlags } : {}),
	},
	expected: [],
});

describe("decodeFlagsFor", () => {
	it("reports a v1 fixture (no recorded flags) as NOT recorded, and hands back production defaults", () => {
		const { flags, recorded } = decodeFlagsFor(capturedWith(undefined));
		expect(recorded).toBe(false);
		expect(flags).toEqual(DEFAULT_DECODE_FLAGS);
	});

	it("returns the fixture's own flags verbatim when recorded, even an all-off config", () => {
		const off: DecodeFlags = {
			imputeCadence: false,
			segmentEvidence: false,
			chainContext: false,
			reacquireRobustSpeed: false,
		};
		const { flags, recorded } = decodeFlagsFor(capturedWith(off));
		expect(recorded).toBe(true);
		expect(flags).toEqual(off);
	});

	it("production defaults are all four flags on — the config kubes actually deploys", () => {
		expect(DEFAULT_DECODE_FLAGS).toEqual({
			imputeCadence: true,
			segmentEvidence: true,
			chainContext: true,
			reacquireRobustSpeed: true,
		});
	});
});

describe("hsmmInputsFromFixture applies the recorded flags", () => {
	it("sets all four flags on the reconstructed inputs from a recorded config", () => {
		const flags: DecodeFlags = {
			imputeCadence: true,
			segmentEvidence: false,
			chainContext: true,
			reacquireRobustSpeed: false,
		};
		const inputs = hsmmInputsFromFixture(capturedWith(flags));
		expect(inputs.imputeCadence).toBe(true);
		expect(inputs.segmentEvidence).toBe(false);
		expect(inputs.chainContext).toBe(true);
		expect(inputs.reacquireRobustSpeed).toBe(false);
	});

	it("falls back to production defaults for a v1 fixture rather than leaving them undefined", () => {
		const inputs = hsmmInputsFromFixture(capturedWith(undefined));
		// The bug was these coming out undefined -> falsy -> flags-off decode.
		expect(inputs.imputeCadence).toBe(true);
		expect(inputs.segmentEvidence).toBe(true);
		expect(inputs.chainContext).toBe(true);
		expect(inputs.reacquireRobustSpeed).toBe(true);
	});
});

describe("toSerializedHsmmInputs records the configuration", () => {
	it("captures the flags the day was decoded under, so the bless is self-describing", () => {
		const ser = toSerializedHsmmInputs(
			bareInputs({ imputeCadence: true, segmentEvidence: true, chainContext: false, reacquireRobustSpeed: true }),
			{ lines: [], points: [] },
		);
		expect(ser.decodeFlags).toEqual({
			imputeCadence: true,
			segmentEvidence: true,
			chainContext: false,
			reacquireRobustSpeed: true,
		});
	});

	it("treats an unset flag on the live inputs as false, not missing", () => {
		const ser = toSerializedHsmmInputs(bareInputs(), { lines: [], points: [] });
		expect(ser.decodeFlags).toEqual({
			imputeCadence: false,
			segmentEvidence: false,
			chainContext: false,
			reacquireRobustSpeed: false,
		});
	});

	it("round-trips: serialize a config, reload it, and the flags survive", () => {
		const ser = toSerializedHsmmInputs(
			bareInputs({ imputeCadence: false, segmentEvidence: true, chainContext: true, reacquireRobustSpeed: false }),
			{ lines: [], points: [] },
		);
		const reloaded = hsmmInputsFromFixture({ ...capturedWith(undefined), inputs: { ...ser } });
		expect(reloaded.imputeCadence).toBe(false);
		expect(reloaded.segmentEvidence).toBe(true);
		expect(reloaded.chainContext).toBe(true);
		expect(reloaded.reacquireRobustSpeed).toBe(false);
	});
});

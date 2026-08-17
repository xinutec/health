/**
 * `LEAN_BIOLABELS=solo` — seventh tenant off the TS arm (#975).
 *
 * The shared contract is on `tests/lean-gpsquality-solo.test.ts`. What is
 * specific here:
 *
 *  - `serve()` SWALLOWS a bridge failure and returns null. That is its contract
 *    for the modes with a TS arm to fall back to; under solo the null has to be
 *    turned back into a throw, or the tenant returns the segments UNLABELLED —
 *    which looks exactly like a day on which nothing needed a flip. That is the
 *    quietest failure in this whole port and the main thing these pin.
 *  - two entry points with different constructions: per-segment `applyDecision`
 *    on one, `rebuildWalkThrough` on the other. The latter is not a comparison
 *    helper — it is how the walkthrough answer is BUILT — so it survives solo.
 *  - the `segments.length === 0` guard is gone, on evidence: the bridge answers
 *    an empty request with `{"decisions":[]}` rather than erroring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	demoteJitterWalkToStationaryViaLean,
	leanBioLabelsMode,
	logLeanBioLabelsLedger,
	resetLeanBioLabelsStats,
} from "../src/lean/lean-biometric-labels.js";
import { LeanBridgeError, leanBioLabelsServe } from "../src/lean/lean-core.js";

vi.mock("../src/lean/lean-core.js", async (orig) => ({
	...(await orig<typeof import("../src/lean/lean-core.js")>()),
	leanBioLabelsServe: vi.fn(),
}));

const served = vi.mocked(leanBioLabelsServe);

type Seg = { startTs: number; endTs: number; mode: string; pointCount: number };
const segs: Seg[] = [
	{ startTs: 1000, endTs: 1060, mode: "walking", pointCount: 4 },
	{ startTs: 1060, endTs: 1120, mode: "walking", pointCount: 5 },
];

const boom = () => {
	throw new Error("solo must not evaluate the TS arm");
};

beforeEach(() => {
	resetLeanBioLabelsStats();
	served.mockReset();
});

afterEach(() => {
	delete process.env.LEAN_BIOLABELS;
	resetLeanBioLabelsStats();
	vi.restoreAllMocks();
});

describe("the biolabels solo flag", () => {
	it("parses solo and fails safe on anything else", () => {
		process.env.LEAN_BIOLABELS = "solo";
		expect(leanBioLabelsMode()).toBe("solo");
		for (const v of ["sol", "SOLO", ""]) {
			process.env.LEAN_BIOLABELS = v;
			expect(leanBioLabelsMode()).toBe("off");
		}
	});
});

describe("solo does not run the TS labeller", () => {
	it("never calls the thunk", () => {
		process.env.LEAN_BIOLABELS = "solo";
		served.mockReturnValue({ decisions: [null, null] } as unknown as ReturnType<typeof leanBioLabelsServe>);
		expect(() => demoteJitterWalkToStationaryViaLean(segs as never, [], boom)).not.toThrow();
		expect(served).toHaveBeenCalledOnce();
	});

	// The guard that looked like it had to stay. It does not: the bridge answers
	// an empty request cleanly, so an empty day costs one trivial call.
	it("asks the bridge even for an empty day", () => {
		process.env.LEAN_BIOLABELS = "solo";
		served.mockReturnValue({ decisions: [] } as unknown as ReturnType<typeof leanBioLabelsServe>);
		expect(demoteJitterWalkToStationaryViaLean([] as never, [], boom)).toEqual([]);
		expect(served).toHaveBeenCalledOnce();
	});
});

describe("a swallowed failure must become a throw", () => {
	// ⚠ THE POINT OF THIS FILE. `serve()` catches `LeanBridgeError` and returns
	// null so the other modes can fall back. Under solo that null must NOT become
	// "no decisions" — returning the segments unlabelled is indistinguishable
	// from a day where the labeller correctly changed nothing.
	it("throws when the bridge dies instead of returning segments unlabelled", () => {
		process.env.LEAN_BIOLABELS = "solo";
		served.mockImplementation(() => {
			throw new LeanBridgeError("bridge down");
		});
		expect(() => demoteJitterWalkToStationaryViaLean(segs as never, [], boom)).toThrow(LeanBridgeError);
	});

	it("throws on a response with no decisions field", () => {
		process.env.LEAN_BIOLABELS = "solo";
		served.mockReturnValue({} as unknown as ReturnType<typeof leanBioLabelsServe>);
		expect(() => demoteJitterWalkToStationaryViaLean(segs as never, [], boom)).toThrow(LeanBridgeError);
	});
});

describe("the ledger claims no comparison it did not make", () => {
	it("says SOLO rather than EXACT", () => {
		process.env.LEAN_BIOLABELS = "solo";
		served.mockReturnValue({ decisions: [null, null] } as unknown as ReturnType<typeof leanBioLabelsServe>);
		demoteJitterWalkToStationaryViaLean(segs as never, [], boom);

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanBioLabelsLedger("2026-08-17");
		const line = log.mock.calls[0]?.[0] as string;
		expect(line).toContain("lean-biolabels[solo]");
		expect(line).toContain("SOLO");
		// This tenant's EXACT is documented as "two levels, not three — anything
		// other than EXACT is a decision flip", so a vacuous one reads as the
		// strongest claim available.
		expect(line).not.toContain("EXACT");
		expect(verdict?.mode).toBe("solo");
	});
});

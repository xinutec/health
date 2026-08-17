/**
 * `LEAN_MATCH=solo` — fifth tenant off the TS arm (#975).
 *
 * The shared contract is documented on `tests/lean-gpsquality-solo.test.ts`.
 * What is specific here:
 *
 *  - this is the tenant with the LARGEST TypeScript behind it. `ts()` is
 *    `matchWalkSegment` → `matchTrajectory` (`map-match-core.ts`, 1,982 lines),
 *    the real trellis. ⚠ Not to be confused with #749's "both arms run the same
 *    Lean matcher", which was about the day fold reaching `qMatchWalkSegment`
 *    through a second transport — a different question entirely.
 *  - `all accepted` is a false-green peculiar to this tenant. It asserts every
 *    divergence was adjudicated against the accepted-delta manifest; under solo
 *    the manifest is never consulted, because there are no deltas to consult it
 *    about.
 *  - `null` is an ANSWER (unmatchable leg → the caller draws the raw line), so
 *    solo must return it rather than throw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoadFix, RoadGeometry } from "../src/geo/map-match-core.js";
import { LeanBridgeError, leanMatchServe } from "../src/lean/lean-core.js";
import {
	leanMatchMode,
	logLeanMatchLedger,
	matchWalkSegmentViaLean,
	resetLeanMatchStats,
} from "../src/lean/lean-match.js";

vi.mock("../src/lean/lean-core.js", async (orig) => ({
	...(await orig<typeof import("../src/lean/lean-core.js")>()),
	leanMatchServe: vi.fn(),
}));

const served = vi.mocked(leanMatchServe);

const fixes: RoadFix[] = [
	{ lat: 51.5, lon: -0.1, ts: 1000 },
	{ lat: 51.5001, lon: -0.1001, ts: 1010 },
	{ lat: 51.5002, lon: -0.1002, ts: 1020 },
];
const geo: RoadGeometry = { ways: [], buildings: [] };

/** Quantised rows, as the bridge returns them: `[lat, lon, ts]` in 1e-7°. */
const qrow = (i: number) => [515000000 + i, -1000000 - i, 1000 + 10 * i];

const boom = () => {
	throw new Error("solo must not evaluate the TS arm");
};

beforeEach(() => {
	resetLeanMatchStats();
	served.mockReset();
});

afterEach(() => {
	delete process.env.LEAN_MATCH;
	resetLeanMatchStats();
	vi.restoreAllMocks();
});

describe("the match solo flag", () => {
	it("parses solo and fails safe on anything else", () => {
		process.env.LEAN_MATCH = "solo";
		expect(leanMatchMode()).toBe("solo");
		for (const v of ["sol", "SOLO", ""]) {
			process.env.LEAN_MATCH = v;
			expect(leanMatchMode()).toBe("off");
		}
	});
});

describe("solo does not run the TS matcher", () => {
	it("never calls the thunk", () => {
		process.env.LEAN_MATCH = "solo";
		served.mockReturnValue({
			path: [qrow(0), qrow(1)],
			coarse: [qrow(0), qrow(1)],
		} as unknown as ReturnType<typeof leanMatchServe>);
		const out = matchWalkSegmentViaLean(fixes, geo, boom);
		expect(out?.path).toHaveLength(2);
		expect(served).toHaveBeenCalledOnce();
	});

	// ⚠ The `fixes.length < 3` guard is deliberately NOT carried over: it
	// hard-codes what `minFixes` already is on both sides, and the Lean matcher
	// applies it itself. Two fixes must still reach the bridge.
	it("asks the bridge even for a leg the guard would have short-circuited", () => {
		process.env.LEAN_MATCH = "solo";
		served.mockReturnValue({ none: true } as unknown as ReturnType<typeof leanMatchServe>);
		expect(matchWalkSegmentViaLean(fixes.slice(0, 2), geo, boom)).toBeNull();
		expect(served).toHaveBeenCalledOnce();
	});

	// Unmatchable is a real outcome — the caller draws the raw line. Throwing
	// would fail every day with a leg the graph cannot carry.
	it("returns null for an unmatchable leg rather than throwing", () => {
		process.env.LEAN_MATCH = "solo";
		served.mockReturnValue({ none: true } as unknown as ReturnType<typeof leanMatchServe>);
		expect(matchWalkSegmentViaLean(fixes, geo, boom)).toBeNull();
	});
});

describe("solo has no fallback", () => {
	it("lets a bridge failure propagate instead of serving TS", () => {
		process.env.LEAN_MATCH = "solo";
		served.mockImplementation(() => {
			throw new LeanBridgeError("bridge down");
		});
		expect(() => matchWalkSegmentViaLean(fixes, geo, boom)).toThrow(LeanBridgeError);
	});
});

describe("the ledger claims no adjudication it did not make", () => {
	it("says SOLO — not EXACT, and not 'all accepted'", () => {
		process.env.LEAN_MATCH = "solo";
		served.mockReturnValue({
			path: [qrow(0), qrow(1)],
			coarse: [qrow(0), qrow(1)],
		} as unknown as ReturnType<typeof leanMatchServe>);
		matchWalkSegmentViaLean(fixes, geo, boom);

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanMatchLedger("2026-08-17");
		const line = log.mock.calls[0]?.[0] as string;
		expect(line).toContain("lean-match[solo]");
		expect(line).toContain("SOLO");
		expect(line).not.toContain("EXACT");
		// The tenant-specific lie: no delta was measured, so the manifest that
		// word refers to was never opened.
		expect(line).not.toContain("all accepted");
		expect(verdict?.mode).toBe("solo");
		expect(verdict?.unexplained).toEqual([]);
	});
});

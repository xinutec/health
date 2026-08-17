/**
 * `LEAN_HEAD` — the pipeline-head tenant (#975).
 *
 * The shared four-mode contract is documented on
 * `tests/lean-gpsquality-solo.test.ts`. What is specific here:
 *
 *  - ONE flag, TWO ops, so the risk is not that the tenant is wrong but that one
 *    op is. Both are exercised separately throughout.
 *  - `snap` is BATCHED. The TS calls `snapToPlace` once per fix inside a `.map`;
 *    a port that kept that shape would make thousands of bridge calls per day.
 *    Pinned by counting calls, not by reading the code.
 *  - `snapped` is a returned FLAG. A fix already at a centroid snaps WITHOUT
 *    moving, so a port inferring the decision from the geometry would record it
 *    as a non-snap. That case is here explicitly.
 *  - `stayPoints` absent and `[]` are DIFFERENT requests: absent means "double
 *    the movement fixes up as stay evidence" (`classifySegments`' own default),
 *    empty means "there is no stay evidence". Collapsing them silently disables
 *    stay detection for the day.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { floatToBits } from "../src/lean/float-bits.js";
import { LeanBridgeError, leanHeadServe } from "../src/lean/lean-core.js";
import {
	classifySegmentsViaLean,
	leanHeadMode,
	logLeanHeadLedger,
	resetLeanHeadStats,
	snapAllViaLean,
} from "../src/lean/lean-head.js";

vi.mock("../src/lean/lean-core.js", async (orig) => ({
	...(await orig<typeof import("../src/lean/lean-core.js")>()),
	leanHeadServe: vi.fn(),
}));

const served = vi.mocked(leanHeadServe);

const boom = () => {
	throw new Error("solo must not evaluate the TS arm");
};

type Fix = { lat: number; lon: number; accuracy: number | null };
const fixes: Fix[] = [
	{ lat: 51.5, lon: -0.1, accuracy: 50 },
	{ lat: 51.6, lon: -0.2, accuracy: 10 },
];
const places = [{ centroidLat: 51.5, centroidLon: -0.1, radiusM: 15, id: "home" }];

const segPts = [
	{ ts: 0, lat: 51.5, lon: -0.1, speed_kmh: 0.2, bearing: 0 },
	{ ts: 60, lat: 51.5, lon: -0.1, speed_kmh: 0.3, bearing: 0 },
];

const leanSeg = (startTs: number, endTs: number, mode: string) => ({
	startTs,
	endTs,
	mode,
	confidence: floatToBits(0.9),
	confidenceMargin: floatToBits(1000),
	avgSpeed: floatToBits(0),
	maxSpeed: floatToBits(0),
	linearity: floatToBits(0),
	pointCount: 2,
	refinedReason: null,
	refinedKinds: [],
});

const tsSeg = (startTs: number, endTs: number, mode: string) =>
	({
		startTs,
		endTs,
		mode,
		confidence: 0.9,
		confidenceMargin: 1000,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount: 2,
	}) as never;

beforeEach(() => {
	resetLeanHeadStats();
	served.mockReset();
});

afterEach(() => {
	delete process.env.LEAN_HEAD;
	resetLeanHeadStats();
	vi.restoreAllMocks();
});

describe("the head flag", () => {
	it("parses all four modes and fails safe on anything else", () => {
		for (const v of ["shadow", "on", "solo"]) {
			process.env.LEAN_HEAD = v;
			expect(leanHeadMode()).toBe(v);
		}
		for (const v of ["sol", "SOLO", "", "yes"]) {
			process.env.LEAN_HEAD = v;
			expect(leanHeadMode()).toBe("off");
		}
	});

	it("off never touches the bridge, for either op", () => {
		process.env.LEAN_HEAD = "off";
		expect(snapAllViaLean(fixes, places, () => fixes)).toEqual(fixes);
		expect(classifySegmentsViaLean(segPts, undefined, () => [])).toEqual([]);
		expect(served).not.toHaveBeenCalled();
	});
});

describe("snap is batched", () => {
	// ⚠ THE POINT. The TS shape is one call per fix; keeping it would be
	// thousands of bridge round trips for one day. Counted, not read.
	it("makes ONE call for a whole day of fixes", () => {
		process.env.LEAN_HEAD = "solo";
		const many = Array.from({ length: 500 }, (_, i) => ({ lat: 51.5 + i * 1e-5, lon: -0.1, accuracy: 50 }));
		served.mockReturnValue({
			snapped: many.map((p) => [floatToBits(p.lat), floatToBits(p.lon), floatToBits(50), false]),
		} as ReturnType<typeof leanHeadServe>);
		snapAllViaLean(many, places, boom);
		expect(served).toHaveBeenCalledOnce();
		expect((served.mock.calls[0][0] as { fixes: unknown[] }).fixes).toHaveLength(500);
	});

	it("rejects a response whose row count does not match the request", () => {
		process.env.LEAN_HEAD = "solo";
		served.mockReturnValue({ snapped: [[floatToBits(51.5), floatToBits(-0.1), null, false]] } as ReturnType<
			typeof leanHeadServe
		>);
		expect(() => snapAllViaLean(fixes, places, boom)).toThrow(LeanBridgeError);
	});
});

describe("snapped is the returned flag, not the geometry", () => {
	// A fix already AT the centroid snaps without moving. Inferring the decision
	// from "did the coordinates change" would call this a non-snap and, under
	// `on`, hand downstream a point the TS considered snapped.
	it("honours snapped=true even when the coordinates are unchanged", () => {
		process.env.LEAN_HEAD = "solo";
		const atCentroid = [{ lat: 51.5, lon: -0.1, accuracy: 50 }];
		served.mockReturnValue({
			snapped: [[floatToBits(51.5), floatToBits(-0.1), floatToBits(15), true]],
		} as ReturnType<typeof leanHeadServe>);
		const out = snapAllViaLean(atCentroid, places, boom);
		// The accuracy came from the PLACE, which only happens on a snap.
		expect(out[0].accuracy).toBe(15);
	});

	it("returns the very same object when not snapped", () => {
		process.env.LEAN_HEAD = "solo";
		served.mockReturnValue({
			snapped: fixes.map((p) => [floatToBits(p.lat), floatToBits(p.lon), floatToBits(50), false]),
		} as ReturnType<typeof leanHeadServe>);
		const out = snapAllViaLean(fixes, places, boom);
		// Identity, not a copy: downstream compares by reference in places.
		expect(out[0]).toBe(fixes[0]);
	});
});

describe("segments distinguishes absent stayPoints from empty", () => {
	// Absent means "double the movement fixes up as stay evidence", which is
	// `classifySegments`' own default. Empty means "no stay evidence". Sending
	// `[]` for `undefined` silently disables stay detection.
	it("sends null for absent and an array for empty", () => {
		process.env.LEAN_HEAD = "solo";
		served.mockReturnValue({ segs: [] } as ReturnType<typeof leanHeadServe>);

		classifySegmentsViaLean(segPts, undefined, boom);
		expect((served.mock.calls[0][0] as { stayPts: unknown }).stayPts).toBeNull();

		served.mockClear();
		classifySegmentsViaLean(segPts, [], boom);
		expect((served.mock.calls[0][0] as { stayPts: unknown }).stayPts).toEqual([]);
	});
});

describe("shadow serves TS, on serves Lean", () => {
	it("shadow returns the TS answer while still calling the bridge", () => {
		process.env.LEAN_HEAD = "shadow";
		served.mockReturnValue({ segs: [leanSeg(0, 120, "walking")] } as ReturnType<typeof leanHeadServe>);
		const out = classifySegmentsViaLean(segPts, undefined, () => [tsSeg(0, 120, "stationary")]);
		expect(out[0].mode).toBe("stationary");
		expect(served).toHaveBeenCalledOnce();
	});

	it("on returns the Lean answer", () => {
		process.env.LEAN_HEAD = "on";
		served.mockReturnValue({ segs: [leanSeg(0, 120, "walking")] } as ReturnType<typeof leanHeadServe>);
		const out = classifySegmentsViaLean(segPts, undefined, () => [tsSeg(0, 120, "stationary")]);
		expect(out[0].mode).toBe("walking");
	});

	it("on falls back to TS on a bridge failure", () => {
		process.env.LEAN_HEAD = "on";
		served.mockImplementation(() => {
			throw new LeanBridgeError("bridge down");
		});
		const out = classifySegmentsViaLean(segPts, undefined, () => [tsSeg(0, 120, "stationary")]);
		expect(out[0].mode).toBe("stationary");
	});
});

describe("solo has no fallback and no TS arm", () => {
	it("never evaluates the thunk, for either op", () => {
		process.env.LEAN_HEAD = "solo";
		served.mockReturnValue({
			snapped: fixes.map((p) => [floatToBits(p.lat), floatToBits(p.lon), null, false]),
			segs: [],
		} as ReturnType<typeof leanHeadServe>);
		expect(() => snapAllViaLean(fixes, places, boom)).not.toThrow();
		expect(() => classifySegmentsViaLean(segPts, undefined, boom)).not.toThrow();
	});

	it("lets a bridge failure propagate rather than serving TS", () => {
		process.env.LEAN_HEAD = "solo";
		served.mockImplementation(() => {
			throw new LeanBridgeError("bridge down");
		});
		expect(() => classifySegmentsViaLean(segPts, undefined, () => [tsSeg(0, 120, "stationary")])).toThrow(
			LeanBridgeError,
		);
	});

	it("treats an error body as a failure, not as an empty result", () => {
		process.env.LEAN_HEAD = "solo";
		served.mockReturnValue({ error: "bad input" } as ReturnType<typeof leanHeadServe>);
		expect(() => classifySegmentsViaLean(segPts, undefined, boom)).toThrow(LeanBridgeError);
	});
});

describe("the ledger claims no comparison it did not make", () => {
	it("says SOLO, never EXACT, and keeps per-op counts", () => {
		process.env.LEAN_HEAD = "solo";
		served.mockReturnValue({
			snapped: fixes.map((p) => [floatToBits(p.lat), floatToBits(p.lon), null, false]),
			segs: [],
		} as ReturnType<typeof leanHeadServe>);
		snapAllViaLean(fixes, places, boom);
		classifySegmentsViaLean(segPts, undefined, boom);

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanHeadLedger("2026-08-17");
		const line = log.mock.calls[0]?.[0] as string;
		expect(line).toContain("lean-head[solo]");
		expect(line).toContain("SOLO");
		expect(line).not.toContain("EXACT");
		// One flag governs two ops, so "the tenant ran" is not "both ops ran".
		expect(line).toContain("snap 1/0f");
		expect(line).toContain("segments 1/0f");
		expect(verdict?.mode).toBe("solo");
		expect(verdict?.klass).toBe("exact");
	});

	it("reports NOT EXERCISED when staged but never called", () => {
		process.env.LEAN_HEAD = "on";
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanHeadLedger("2026-08-17");
		expect(log.mock.calls[0]?.[0] as string).toContain("NOT EXERCISED");
		expect(verdict?.klass).toBe("not-exercised");
	});

	it("returns null when off, so an untouched tenant costs the gate nothing", () => {
		process.env.LEAN_HEAD = "off";
		expect(logLeanHeadLedger("2026-08-17")).toBeNull();
	});

	it("counts a real divergence rather than reporting EXACT", () => {
		process.env.LEAN_HEAD = "on";
		served.mockReturnValue({ segs: [leanSeg(0, 120, "walking")] } as ReturnType<typeof leanHeadServe>);
		classifySegmentsViaLean(segPts, undefined, () => [tsSeg(0, 120, "stationary")]);

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanHeadLedger("2026-08-17");
		const line = log.mock.calls[0]?.[0] as string;
		expect(line).toContain("DIVERGED");
		expect(line).not.toContain("EXACT");
		expect(verdict?.klass).toBe("diverged");
	});
});

describe("the refined fields are compared, not just the easy ones", () => {
	// `inferTransitGaps` runs last inside `classifySegments` and is the only
	// stage here that sets `refinedReason`/`refinedKinds` — on exactly the
	// segments it invented from a GPS blackout. A comparison that skipped them
	// would read EXACT on a gap-inference divergence, which is the most
	// interesting thing this op can get wrong.
	it("counts a divergence that is ONLY in refinedReason", () => {
		process.env.LEAN_HEAD = "on";
		served.mockReturnValue({
			segs: [{ ...leanSeg(0, 120, "walking"), refinedReason: "inferred from GPS gap (6.3 km in 10 min)" }],
		} as ReturnType<typeof leanHeadServe>);
		const out = classifySegmentsViaLean(segPts, undefined, () => [tsSeg(0, 120, "walking")]);
		expect(out[0].refinedReason).toBe("inferred from GPS gap (6.3 km in 10 min)");

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanHeadLedger("2026-08-17");
		expect(log.mock.calls[0]?.[0] as string).toContain("DIVERGED");
		expect(verdict?.klass).toBe("diverged");
	});

	it("counts a divergence that is ONLY in refinedKinds", () => {
		process.env.LEAN_HEAD = "on";
		served.mockReturnValue({
			segs: [{ ...leanSeg(0, 120, "walking"), refinedKinds: ["gps-gap-inferred"] }],
		} as ReturnType<typeof leanHeadServe>);
		classifySegmentsViaLean(segPts, undefined, () => [tsSeg(0, 120, "walking")]);

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanHeadLedger("2026-08-17");
		expect(log.mock.calls[0]?.[0] as string).toContain("DIVERGED");
		expect(verdict?.klass).toBe("diverged");
	});
});

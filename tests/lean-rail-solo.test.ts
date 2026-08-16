/**
 * `LEAN_RAIL=solo` — third tenant off the TS arm (#975).
 *
 * The shared contract is documented on `tests/lean-gpsquality-solo.test.ts`.
 * Rail is the tenant where `solo` is NOT measurement-blind, and that is what
 * these pin:
 *
 *  - the REFEREE survives. `railPathCostQ` recomputes the cost of the path Lean
 *    returned and checks it against the distance Lean settled on. That compares
 *    the verified arm to the spec its proof is about, not one implementation to
 *    another, so it needs no TS arm and still fails the gate when it trips.
 *  - `null` is an ANSWER, not a failure. `lean.none === true` means the graph is
 *    disconnected between the endpoints; throwing on it would fail every day
 *    that contains an unroutable leg.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeanBridgeError, leanRailServe } from "../src/lean/lean-core.js";
import {
	leanRailMode,
	logLeanRailLedger,
	RAIL_Q,
	resetLeanRailStats,
	shortestPathViaLean,
} from "../src/lean/lean-rail.js";

vi.mock("../src/lean/lean-core.js", async (orig) => ({
	...(await orig<typeof import("../src/lean/lean-core.js")>()),
	leanRailServe: vi.fn(),
}));

const served = vi.mocked(leanRailServe);

/** 0 →(5)→ 1 →(7)→ 2, weights in graph units; `RAIL_Q` scales them on the wire. */
const graph = {
	vertices: [0, 1, 2],
	adj: [[{ to: 1, w: 5 }], [{ to: 2, w: 7 }], []],
} as unknown as Parameters<typeof shortestPathViaLean>[0];

const boom = () => {
	throw new Error("solo must not evaluate the TS arm");
};

beforeEach(() => {
	resetLeanRailStats();
	served.mockReset();
});

afterEach(() => {
	delete process.env.LEAN_RAIL;
	resetLeanRailStats();
	vi.restoreAllMocks();
});

describe("the rail solo flag", () => {
	it("parses solo and fails safe on anything else", () => {
		process.env.LEAN_RAIL = "solo";
		expect(leanRailMode()).toBe("solo");
		for (const v of ["sol", "SOLO", ""]) {
			process.env.LEAN_RAIL = v;
			expect(leanRailMode()).toBe("off");
		}
	});
});

describe("solo does not run the TS arm", () => {
	it("never calls the thunk", () => {
		process.env.LEAN_RAIL = "solo";
		served.mockReturnValue({ path: [0, 1, 2], dist: 12000 } as unknown as ReturnType<typeof leanRailServe>);
		expect(shortestPathViaLean(graph, 0, 2, boom)).toEqual([0, 1, 2]);
		expect(served).toHaveBeenCalledOnce();
	});

	// ⚠ Not a failure. A disconnected pair is a real answer, and a solo that
	// threw here would fail every day containing an unroutable leg.
	it("returns null for no-route rather than throwing", () => {
		process.env.LEAN_RAIL = "solo";
		served.mockReturnValue({ none: true } as unknown as ReturnType<typeof leanRailServe>);
		expect(shortestPathViaLean(graph, 0, 2, boom)).toBeNull();
	});
});

describe("solo has no fallback", () => {
	it("throws an error response instead of repairing it", () => {
		process.env.LEAN_RAIL = "solo";
		served.mockReturnValue({ error: "bad graph" } as unknown as ReturnType<typeof leanRailServe>);
		expect(() => shortestPathViaLean(graph, 0, 2, boom)).toThrow(LeanBridgeError);
	});

	it("lets a bridge failure propagate", () => {
		process.env.LEAN_RAIL = "solo";
		served.mockImplementation(() => {
			throw new LeanBridgeError("bridge down");
		});
		expect(() => shortestPathViaLean(graph, 0, 2, boom)).toThrow(LeanBridgeError);
	});
});

describe("the referee survives the missing TS arm", () => {
	it("reports a clean solo run as referee-checked, not EXACT", () => {
		process.env.LEAN_RAIL = "solo";
		// Must equal `railPathCostQ` over the QUANTISED graph. Derived from the
		// exported constant rather than written out: a literal here silently
		// becomes a cost mismatch if `RAIL_Q` ever changes, and the test would
		// then fail for a reason that has nothing to do with what it pins.
		// (It did exactly that on first run — RAIL_Q is 1<<20, not 1000.)
		const dist = Math.round(5 * RAIL_Q) + Math.round(7 * RAIL_Q);
		served.mockReturnValue({ path: [0, 1, 2], dist } as unknown as ReturnType<typeof leanRailServe>);
		shortestPathViaLean(graph, 0, 2, boom);

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanRailLedger("2026-08-17");
		const line = log.mock.calls[0]?.[0] as string;
		expect(line).toContain("lean-rail[solo]");
		expect(line).toContain("referee-checked");
		expect(line).not.toContain("EXACT");
		expect(verdict?.klass).toBe("exact");
	});

	// THE POINT OF THIS FILE. With no TS arm there is still something that can be
	// wrong, and it must still fail the gate.
	it("FAILS when Lean's settled distance disagrees with its own path's cost", () => {
		process.env.LEAN_RAIL = "solo";
		served.mockReturnValue({ path: [0, 1, 2], dist: 999 } as unknown as ReturnType<typeof leanRailServe>);
		shortestPathViaLean(graph, 0, 2, boom);

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanRailLedger("2026-08-17");
		expect(log.mock.calls[0]?.[0] as string).toContain("COST MISMATCH");
		expect(verdict?.klass).toBe("diverged");
	});
});

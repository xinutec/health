/**
 * `LEAN_STATIONCHAIN=solo` — eighth tenant off the TS arm (#975).
 *
 * The shared contract is on `tests/lean-gpsquality-solo.test.ts`. Specific here:
 *
 *  - the `namedTrainLegs(opts) === 0` guard is the one in the whole audit that
 *    looked like a SECOND CODE PATH: it returns `resolveStationChain(opts)`, the
 *    entire TS resolver, rather than a trivial value. It is not one —
 *    `station-chain.ts:644` skips every segment on exactly the predicate
 *    `namedTrainLegs` counts, so zero named legs provably yields an empty Map —
 *    but solo must branch BEFORE it or a legless day routes straight into the TS
 *    resolver, which is the single thing this mode exists to prevent.
 *  - `on` catches a bridge failure and serves TS. Solo must not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStationChain } from "../src/hmm/station-chain.js";
import { leanStationChainServe } from "../src/lean/lean-core.js";
import {
	leanStationChainMode,
	logLeanStationChainLedger,
	resetLeanStationChainStats,
	resolveStationsServed,
} from "../src/lean/lean-station-chain.js";

vi.mock("../src/lean/lean-core.js", async (orig) => ({
	...(await orig<typeof import("../src/lean/lean-core.js")>()),
	leanStationChainServe: vi.fn(),
}));
vi.mock("../src/hmm/station-chain.js", async (orig) => ({
	...(await orig<typeof import("../src/hmm/station-chain.js")>()),
	resolveStationChain: vi.fn(() => new Map()),
}));

const served = vi.mocked(leanStationChainServe);
const tsResolver = vi.mocked(resolveStationChain);

const opts = (named: number) =>
	({
		segments: Array.from({ length: named }, (_, i) => ({
			mode: "train",
			lineName: `Line ${i}`,
			startTs: 1000 + i,
			endTs: 2000 + i,
		})),
		observations: [],
		// `encodeGraph` walks BOTH maps, so a fixture with only `edges` throws
		// before the tenant is even reached.
		routeGraph: { edges: new Map(), nodes: new Map() },
		railStopRelations: [],
	}) as unknown as Parameters<typeof resolveStationsServed>[0];

beforeEach(() => {
	resetLeanStationChainStats();
	served.mockReset();
	tsResolver.mockClear();
});

afterEach(() => {
	delete process.env.LEAN_STATIONCHAIN;
	resetLeanStationChainStats();
	vi.restoreAllMocks();
});

describe("the stationchain solo flag", () => {
	it("parses solo and fails safe on anything else", () => {
		process.env.LEAN_STATIONCHAIN = "solo";
		expect(leanStationChainMode()).toBe("solo");
		for (const v of ["sol", "SOLO", ""]) {
			process.env.LEAN_STATIONCHAIN = v;
			expect(leanStationChainMode()).toBe("off");
		}
	});
});

describe("solo does not run the TS resolver", () => {
	it("serves Lean's resolution and never calls the TS one", () => {
		process.env.LEAN_STATIONCHAIN = "solo";
		served.mockReturnValue({ resolved: [[0, "Kings Cross", "Finsbury Park"]] } as unknown as ReturnType<
			typeof leanStationChainServe
		>);
		const out = resolveStationsServed(opts(1), "2026-08-17");
		expect(out.get(0)).toEqual({ board: "Kings Cross", alight: "Finsbury Park" });
		expect(tsResolver).not.toHaveBeenCalled();
	});

	// ⚠ THE ORDERING THAT MATTERS. The legs guard returns the whole TS resolver,
	// so a solo branch placed after it would send every legless day straight
	// into the implementation being deleted — silently, since an empty Map is
	// the correct answer either way.
	it("asks Lean even on a day with no named train legs", () => {
		process.env.LEAN_STATIONCHAIN = "solo";
		served.mockReturnValue({ resolved: [] } as unknown as ReturnType<typeof leanStationChainServe>);
		expect(resolveStationsServed(opts(0), "2026-08-17").size).toBe(0);
		expect(served).toHaveBeenCalledOnce();
		expect(tsResolver).not.toHaveBeenCalled();
	});
});

describe("solo has no fallback", () => {
	// `on` catches this and serves TS with a warning. Solo cannot.
	it("lets a bridge failure propagate instead of serving TS", () => {
		process.env.LEAN_STATIONCHAIN = "solo";
		served.mockImplementation(() => {
			throw new Error("bridge down");
		});
		expect(() => resolveStationsServed(opts(1), "2026-08-17")).toThrow();
		expect(tsResolver).not.toHaveBeenCalled();
	});
});

describe("the ledger claims no comparison it did not make", () => {
	it("says SOLO and keeps the leg count", () => {
		process.env.LEAN_STATIONCHAIN = "solo";
		served.mockReturnValue({ resolved: [[0, "A", "B"]] } as unknown as ReturnType<typeof leanStationChainServe>);
		resolveStationsServed(opts(2), "2026-08-17");

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanStationChainLedger("2026-08-17");
		const line = log.mock.calls[0]?.[0] as string;
		expect(line).toContain("lean-stationchain[solo]");
		expect(line).toContain("SOLO");
		expect(line).not.toContain("EXACT");
		// The leg count is the evidence the day had something to decide — it
		// matters MORE once nothing is being compared.
		expect(line).toContain("2 leg(s)");
		expect(verdict?.mode).toBe("solo");
	});
});

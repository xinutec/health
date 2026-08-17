/**
 * `LEAN_PASSES=solo` — sixth tenant off the TS arm (#975), and the only one
 * where ONE flag governs SIX ops.
 *
 * The shared contract is documented on `tests/lean-gpsquality-solo.test.ts`.
 * What is specific here:
 *
 *  - six ops, so the risk is not that solo is wrong but that it is wrong in ONE
 *    of them. `soloGeo` factors the shared body precisely so the six cannot
 *    drift apart; these pin every op individually anyway, because a helper
 *    shared by six callers is only as good as the six call sites.
 *  - three distinct result shapes: an index list (`simplify`), a subsequence of
 *    the input (`spurs`/`spikes`/`trim`/`despike`), and MATERIALISED vertices
 *    (`splice`, whose output contains points appearing verbatim in neither
 *    input). A solo that treated splice as a subsequence would silently return
 *    fewer vertices on every spliced leg.
 *  - `all accepted` is a false-green here as it is for `match`: it names an
 *    adjudication against the accepted-delta manifest that never happened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeanBridgeError, leanGeo } from "../src/lean/lean-core.js";
import {
	despikeViaLean,
	leanPassMode,
	logLeanPassLedger,
	rejectSpikesViaLean,
	removeSpursViaLean,
	resetLeanPassStats,
	simplifyViaLean,
	spliceViaLean,
	trimViaLean,
} from "../src/lean/lean-passes.js";

vi.mock("../src/lean/lean-core.js", async (orig) => ({
	...(await orig<typeof import("../src/lean/lean-core.js")>()),
	leanGeo: vi.fn(),
}));

const geo = vi.mocked(leanGeo);

type Pt = { lat: number; lon: number; ts: number };
const pts: Pt[] = [
	{ lat: 51.5, lon: -0.1, ts: 1000 },
	{ lat: 51.6, lon: -0.2, ts: 1010 },
	{ lat: 51.7, lon: -0.3, ts: 1020 },
];
/** The quantised row for `pts[i]`, as `rows()` produces and the bridge echoes. */
const q = (i: number) => [Math.round(pts[i].lat * 1e7), Math.round(pts[i].lon * 1e7), pts[i].ts];

const boom = () => {
	throw new Error("solo must not evaluate the TS arm");
};

beforeEach(() => {
	resetLeanPassStats();
	geo.mockReset();
});

afterEach(() => {
	delete process.env.LEAN_PASSES;
	resetLeanPassStats();
	vi.restoreAllMocks();
});

describe("the passes solo flag", () => {
	it("parses solo and fails safe on anything else", () => {
		process.env.LEAN_PASSES = "solo";
		expect(leanPassMode()).toBe("solo");
		for (const v of ["sol", "SOLO", ""]) {
			process.env.LEAN_PASSES = v;
			expect(leanPassMode()).toBe("off");
		}
	});
});

describe("every one of the six ops skips its TS arm", () => {
	// A helper shared by six callers is only as good as the six call sites, so
	// each is exercised rather than trusting `soloGeo` once.
	const cases: Array<[string, () => unknown]> = [
		["simplify", () => simplifyViaLean(pts, 5, boom)],
		["spurs", () => removeSpursViaLean(pts, 2, 4, boom)],
		["spikes", () => rejectSpikesViaLean(pts, boom)],
		["trim", () => trimViaLean(pts, pts, boom)],
		["despike", () => despikeViaLean(pts, pts, boom)],
		["splice", () => spliceViaLean(pts, pts, 3, boom)],
	];

	for (const [op, run] of cases) {
		it(`${op} asks the bridge and never calls the thunk`, () => {
			process.env.LEAN_PASSES = "solo";
			geo.mockReturnValue({ keep: [0, 1, 2], pts: [q(0), q(1), q(2)] } as ReturnType<typeof leanGeo>);
			expect(run).not.toThrow();
			expect(geo).toHaveBeenCalledOnce();
			expect((geo.mock.calls[0][0] as { op: string }).op).toBe(op);
		});

		it(`${op} throws an error response rather than repairing it`, () => {
			process.env.LEAN_PASSES = "solo";
			geo.mockReturnValue({ error: "bad input" } as ReturnType<typeof leanGeo>);
			expect(run).toThrow(LeanBridgeError);
		});
	}
});

describe("the result shapes differ, and solo must respect that", () => {
	it("simplify maps an INDEX list back onto the input objects", () => {
		process.env.LEAN_PASSES = "solo";
		geo.mockReturnValue({ keep: [0, 2] } as ReturnType<typeof leanGeo>);
		const out = simplifyViaLean(pts, 5, boom);
		expect(out).toEqual([pts[0], pts[2]]);
		expect(out[0]).toBe(pts[0]);
	});

	it("spikes returns a SUBSEQUENCE of the input objects", () => {
		process.env.LEAN_PASSES = "solo";
		geo.mockReturnValue({ pts: [q(0), q(2)] } as ReturnType<typeof leanGeo>);
		const out = rejectSpikesViaLean(pts, boom);
		expect(out).toEqual([pts[0], pts[2]]);
		expect(out[0]).toBe(pts[0]);
	});

	// ⚠ THE ONE THAT WOULD BREAK QUIETLY. Splice weaves detail into the coarse
	// line, so its output holds vertices present in neither input verbatim.
	// Treating it as a subsequence would drop exactly those — the spliced detail
	// — and return a shorter line that still looked plausible.
	it("splice MATERIALISES vertices that are in neither input", () => {
		process.env.LEAN_PASSES = "solo";
		const novel = [515500000, -1500000, 1005];
		geo.mockReturnValue({ pts: [q(0), novel, q(2)] } as ReturnType<typeof leanGeo>);
		const out = spliceViaLean(pts, pts, 3, boom);
		expect(out).toHaveLength(3);
		expect(out[1].lat).toBeCloseTo(51.55);
		expect(out[1].lon).toBeCloseTo(-0.15);
		expect(out[1].ts).toBe(1005);
	});
});

describe("the ledger claims no adjudication it did not make", () => {
	it("says SOLO — not EXACT, not 'all accepted'", () => {
		process.env.LEAN_PASSES = "solo";
		geo.mockReturnValue({ keep: [0, 1, 2], pts: [q(0), q(1), q(2)] } as ReturnType<typeof leanGeo>);
		simplifyViaLean(pts, 5, boom);
		rejectSpikesViaLean(pts, boom);

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanPassLedger("2026-08-17");
		const line = log.mock.calls[0]?.[0] as string;
		expect(line).toContain("lean-passes[solo]");
		expect(line).toContain("SOLO");
		expect(line).not.toContain("EXACT");
		expect(line).not.toContain("all accepted");
		// The per-op counts stay meaningful: they are the only way to notice an op
		// that quietly stopped being reached.
		expect(line).toContain("simplify");
		expect(line).toContain("spikes");
		expect(verdict?.mode).toBe("solo");
	});
});

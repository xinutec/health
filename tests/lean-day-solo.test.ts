/**
 * `LEAN_DAY=solo` — the mode that lets the TypeScript day cascade be DELETED
 * (#975).
 *
 * THE TENANT ITSELF — `soloLeanDay`'s own behaviour, with `converge` stubbed
 * underneath it. What it does when the chain fails, what it refuses to serve,
 * and what it is willing to claim in the ledger.
 *
 * The other half of the mode — that `velocity.ts` actually SKIPS the ~1,340-line
 * TS region, which is the thing that lets the TypeScript be deleted — cannot be
 * measured from here and lives in `tests/lean-day-solo-region.test.ts`. That
 * file stubs this module to watch the caller; this one keeps it real to test the
 * caller's callee. Two files rather than one because those two mocks contradict.
 *
 * What this file is FOR: `solo` is the only mode with no arm to fall back to, so
 * every degradation the other three treat as "serve TS instead" has to become a
 * loud failure here. Each test below is one way that could silently not happen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassificationInputs } from "../src/geo/classification-inputs.js";
import type { DayRequestInputs } from "../src/lean/fold-capture.js";
import { LeanBridgeError } from "../src/lean/lean-core.js";
import { assertLeanDaySupported, logLeanDayLedger, resetLeanDayStats, soloLeanDay } from "../src/lean/lean-day.js";

// `converge` is the seam every mode goes through, so stubbing it exercises the
// tenant's OWN failure handling rather than a mock of it. `soloLeanDay` is the
// unit under test in the first half of this file and must stay real.
vi.mock("../src/lean/day-serve.js", async (orig) => ({
	...(await orig<typeof import("../src/lean/day-serve.js")>()),
	converge: vi.fn(),
}));

import { converge } from "../src/lean/day-serve.js";

const conv = vi.mocked(converge);

/** `encodeSeg` writes floats as IEEE bit patterns in decimal, so a stub that
 *  hands back plain numbers dies in `floatFromBits` rather than in the assertion
 *  — the response has to speak the real wire encoding. */
const bits = (v: number): string => {
	const b = new DataView(new ArrayBuffer(8));
	b.setFloat64(0, v);
	return b.getBigUint64(0).toString();
};

/** The minimal segment `decodeSeg` accepts: the nine required fields, no
 *  optionals. Enough to prove a decode happened; the corpus grades the rest. */
const wireSeg = (startTs = 1000) => ({
	startTs,
	endTs: startTs + 600,
	mode: "stationary",
	confidence: bits(1),
	confidenceMargin: bits(0),
	avgSpeed: bits(0),
	maxSpeed: bits(0),
	linearity: bits(0),
	pointCount: 3,
});

/** A converged response carrying the three arrays, in wire shape. */
const ok = (segs: unknown[], states: unknown[] = [], episodes: unknown[] = []) =>
	({ rounds: 3, out: JSON.stringify({ segs, states, episodes }), failure: undefined }) as unknown as Awaited<
		ReturnType<typeof converge>
	>;

/** A request with `n` raw segments — the precondition the empty-cascade guard
 *  keys on, and the only field of the request this half of the file reads. */
const req = (n: number): DayRequestInputs =>
	({
		segsRaw: Array.from({ length: n }, () => ({})),
		modeStats: [],
		obs: { points: [], rawFixes: [], displayFixes: [], steps: [], hr: [], sleep: [] },
		tzAt: [],
		bestPlace: [],
	}) as unknown as DayRequestInputs;

/** `soloLeanDay` passes `inputs` straight to `converge`, which is stubbed, so
 *  nothing in this half reads a field of it. */
const noInputs = {} as ClassificationInputs;

beforeEach(() => {
	resetLeanDayStats();
	conv.mockReset();
});

afterEach(() => {
	// `delete`, not `= undefined`: Node coerces an assigned `undefined` to the
	// STRING "undefined", which the tenant would then parse (to `off`, but by
	// accident). Only `delete` actually unsets it.
	delete process.env.LEAN_DAY;
	resetLeanDayStats();
	vi.restoreAllMocks();
});

describe("the flag no longer selects an arm, and refuses to pretend it does", () => {
	// ⚠ The old test here asserted that an unknown value read as `off`, on the
	// house rule that a typo must not be read as staging. That rule protected a
	// CHOICE between arms. #975 deleted the second arm, so the failure mode
	// inverted: the danger is no longer a typo turning the fold ON, it is someone
	// setting `off` during an incident and believing they turned it OFF.
	it("accepts solo, and unset", () => {
		process.env.LEAN_DAY = "solo";
		expect(() => assertLeanDaySupported()).not.toThrow();
		delete process.env.LEAN_DAY;
		expect(() => assertLeanDaySupported()).not.toThrow();
	});

	it("refuses a value that implies a mode still exists", () => {
		for (const v of ["off", "shadow", "on", "sol", "SOLO", "true"]) {
			process.env.LEAN_DAY = v;
			expect(() => assertLeanDaySupported(), v).toThrow(/not a mode any more/);
		}
	});
});

describe("solo has no fallback, and says so", () => {
	// Every other mode returns `undefined` here and lets `velocity.ts` serve
	// `withBiometrics`. Under solo `withBiometrics` was never computed, so there
	// is nothing to fall back TO — and inventing an empty day would be the
	// masking fallback the house rules forbid.
	it("throws when the round loop does not converge", async () => {
		process.env.LEAN_DAY = "solo";
		conv.mockResolvedValue({ rounds: -1, out: "", failure: "table never filled" } as unknown as Awaited<
			ReturnType<typeof converge>
		>);
		await expect(soloLeanDay(req(3), noInputs, "2026-05-15 pippijn")).rejects.toThrow(LeanBridgeError);
	});

	it("throws on a Lean-side error response", async () => {
		process.env.LEAN_DAY = "solo";
		conv.mockResolvedValue({ rounds: 2, out: JSON.stringify({ error: "bad request" }) } as unknown as Awaited<
			ReturnType<typeof converge>
		>);
		await expect(soloLeanDay(req(3), noInputs, "2026-05-15 pippijn")).rejects.toThrow(/bad request/);
	});

	it("throws when the bridge itself throws", async () => {
		process.env.LEAN_DAY = "solo";
		conv.mockRejectedValue(new Error("spawn ENOENT"));
		await expect(soloLeanDay(req(3), noInputs, "2026-05-15 pippijn")).rejects.toThrow(LeanBridgeError);
	});

	// Each of the three above must also be COUNTED. A tenant that throws without
	// tallying reports `0 failed` on the run that broke, and the ledger is the
	// only place a production failure is visible.
	it("counts each failure in the ledger", async () => {
		process.env.LEAN_DAY = "solo";
		conv.mockRejectedValue(new Error("spawn ENOENT"));
		await expect(soloLeanDay(req(3), noInputs, "d")).rejects.toThrow();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanDayLedger("2026-05-15");
		expect(verdict?.fails).toBe(1);
		expect(log.mock.calls[0]?.[0] as string).toContain("1 failed");
	});
});

describe("the empty-cascade guard replaces the count guard", () => {
	// `serveLeanDay` refuses to serve when Lean's segment count differs from the
	// TS arm's. Under solo there is no TS arm, so that guard cannot be carried
	// over — and dropping it silently would remove the one thing between a broken
	// fold and a day recorded as empty.
	it("refuses a cascade that returned nothing for a day that had segments", async () => {
		process.env.LEAN_DAY = "solo";
		conv.mockResolvedValue(ok([]));
		await expect(soloLeanDay(req(4), noInputs, "2026-05-15 pippijn")).rejects.toThrow(
			/refusing to record an empty day/,
		);
	});

	// ⚠ The precondition is what keeps this honest. A day with no GPS at all
	// legitimately produces no segments, and a guard without this clause would
	// fail exactly the days with the least evidence — the same trap the empty-day
	// arm exists to avoid. Ablating `req.segsRaw.length > 0` fails this test.
	it("allows an empty cascade when the day had no raw segments either", async () => {
		process.env.LEAN_DAY = "solo";
		conv.mockResolvedValue(ok([]));
		await expect(soloLeanDay(req(0), noInputs, "2026-05-15 pippijn")).resolves.toEqual({
			segs: [],
			states: [],
			episodes: [],
		});
	});

	it("counts the refusal as a failure rather than losing it", async () => {
		process.env.LEAN_DAY = "solo";
		conv.mockResolvedValue(ok([]));
		await expect(soloLeanDay(req(4), noInputs, "d")).rejects.toThrow();
		vi.spyOn(console, "log").mockImplementation(() => {});
		// One converged call and one refusal: the chain DID answer, so `calls`
		// counts it, and the answer was refused, so `fails` counts that too.
		expect(logLeanDayLedger("2026-05-15")?.fails).toBe(1);
	});
});

describe("the ledger does not claim an agreement nobody measured", () => {
	// ⚠ `clean` is VACUOUSLY true under solo: `runLeanDay` returns before the diff
	// counters can be touched, so nothing can ever increment them. Printing EXACT
	// would be the same false-green as a gate excusing a field by name — a reader
	// could not tell "agreed everywhere" from "nothing was compared".
	it("says SOLO rather than EXACT", async () => {
		process.env.LEAN_DAY = "solo";
		conv.mockResolvedValue(ok([wireSeg()], [], []));
		await soloLeanDay(req(1), noInputs, "d");

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanDayLedger("2026-05-15");
		const line = log.mock.calls[0]?.[0] as string;

		expect(line).toContain("lean-day[solo]");
		expect(line).toContain("SOLO");
		expect(line).not.toContain("EXACT");
		expect(verdict?.mode).toBe("solo");
	});

	// Zero calls stays a failure under solo, and is the most serious version of
	// it: the tenant is the only arm, so never running means no day was produced.
	it("still reports NOT EXERCISED when it never ran", () => {
		process.env.LEAN_DAY = "solo";
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanDayLedger("2026-05-15");
		expect(log.mock.calls[0]?.[0] as string).toContain("NOT EXERCISED");
		expect(verdict?.klass).toBe("not-exercised");
	});

	// The comparison is skipped, not merely empty. If `runLeanDay` ever stopped
	// returning early for a null arm, `diffSegs` would measure the fold's real
	// segments against an EMPTY TS array and report a total divergence — the
	// ledger would scream on a perfectly good day.
	it("records no divergence when the fold returns segments and there is no TS arm", async () => {
		process.env.LEAN_DAY = "solo";
		conv.mockResolvedValue(ok([wireSeg(1000), wireSeg(2000), wireSeg(3000)]));
		await soloLeanDay(req(3), noInputs, "d");
		vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanDayLedger("2026-05-15");
		expect(verdict?.unexplained).toEqual([]);
		expect(verdict?.klass).toBe("exact");
	});
});

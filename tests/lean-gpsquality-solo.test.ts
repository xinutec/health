/**
 * `LEAN_GPSQUALITY=solo` — the mode that lets the TypeScript filter be DELETED
 * (#975).
 *
 * `off`/`shadow`/`on` all run both arms; that is why every tenant can print a
 * comparison, and why flipping nine of them to `on` removed no TypeScript at
 * all. `solo` is the first mode that does not call the TS thunk, which makes
 * the `() => qualityFilterGps(points)` closure at the call site the last
 * reference to the TS filter.
 *
 * So the property under test is not "the filter works" — the golden corpus
 * covers that. It is that the TS arm is genuinely UNREACHED, that a bridge
 * failure is not quietly repaired, and that the ledger does not claim an
 * agreement nobody measured. Each of those is a way `solo` could look correct
 * while being useless or dishonest.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GpsPoint } from "../src/geo/kalman.js";
import { LeanBridgeError, leanGpsQualityServe } from "../src/lean/lean-core.js";
import {
	leanGpsQualityMode,
	logLeanGpsQualityLedger,
	qualityFilterGpsViaLean,
	resetLeanGpsQualityStats,
} from "../src/lean/lean-gps-quality.js";

vi.mock("../src/lean/lean-core.js", async (orig) => ({
	...(await orig<typeof import("../src/lean/lean-core.js")>()),
	leanGpsQualityServe: vi.fn(),
}));

const served = vi.mocked(leanGpsQualityServe);

/** Three points is above the `<= 2` short-circuit the other modes take. */
const pts = (n: number): GpsPoint[] =>
	Array.from({ length: n }, (_, i) => ({ ts: 1000 + i, lat: 51.5 + i / 1e4, lon: -0.1, accuracy: 10 })) as GpsPoint[];

/** The wire echo of a kept point, in the shape `keptIndices` matches on. */
const wire = (p: GpsPoint) => [p.ts, floatBits(p.lat), floatBits(p.lon), floatBits(p.accuracy as number)];

// The tenant compares on the BIT pattern, so the stub has to speak the same
// encoding the real bridge does or every point reads as dropped.
function floatBits(v: number): string {
	const b = new DataView(new ArrayBuffer(8));
	b.setFloat64(0, v);
	return b.getBigUint64(0).toString();
}

beforeEach(() => {
	resetLeanGpsQualityStats();
	served.mockReset();
});

afterEach(() => {
	// `delete`, not `= undefined`: Node coerces an assigned `undefined` to the
	// STRING "undefined", which the tenant would then parse (to `off`, but by
	// accident). Only `delete` actually unsets it.
	delete process.env.LEAN_GPSQUALITY;
	resetLeanGpsQualityStats();
	vi.restoreAllMocks();
});

describe("the solo flag parses, and fails safe", () => {
	it("recognises solo", () => {
		process.env.LEAN_GPSQUALITY = "solo";
		expect(leanGpsQualityMode()).toBe("solo");
	});

	// The house rule for every tenant flag (#392 lineage): an unknown value must
	// not be read as "some staging is on". A typo'd `sol` that fell through to
	// `solo` would delete the fallback nobody asked to delete.
	it("reads an unknown value as off, not as solo", () => {
		for (const v of ["sol", "SOLO", "solo ", "true", ""]) {
			process.env.LEAN_GPSQUALITY = v;
			expect(leanGpsQualityMode()).toBe("off");
		}
	});
});

describe("solo does not run the TS arm", () => {
	it("never calls the thunk", () => {
		process.env.LEAN_GPSQUALITY = "solo";
		const input = pts(4);
		served.mockReturnValue({ pts: input.map(wire) } as ReturnType<typeof leanGpsQualityServe>);
		// Throwing IS the assertion: any call at all fails the test with a stack
		// pointing at the caller, which a spy's call-count cannot give.
		const ts = () => {
			throw new Error("solo must not evaluate the TS arm");
		};
		expect(() => qualityFilterGpsViaLean(input, ts)).not.toThrow();
		expect(served).toHaveBeenCalledOnce();
	});

	// ⚠ The point of the mode. `on` returns Lean's answer too, but only after
	// computing TS's — so `on` cannot delete a line of TypeScript and `solo`
	// can. If this ever regresses to calling the thunk, the deletion sweep that
	// follows would silently remove code that is still executing.
	it("serves the ORIGINAL input objects, not round-tripped copies", () => {
		process.env.LEAN_GPSQUALITY = "solo";
		const input = pts(4);
		served.mockReturnValue({ pts: [input[0], input[3]].map(wire) } as ReturnType<typeof leanGpsQualityServe>);
		const out = qualityFilterGpsViaLean(input, () => []);
		expect(out).toHaveLength(2);
		expect(out[0]).toBe(input[0]);
		expect(out[1]).toBe(input[3]);
	});

	// The `<= 2` short-circuit in the other modes returns `ts()`, and
	// `qualityFilterGps` is NOT the identity on a short track — it drops fixes
	// the phone disclaims before it counts to two. Carrying that guard into
	// solo would serve points every other mode discards, so solo always asks.
	it("still asks the bridge for a track of two points", () => {
		process.env.LEAN_GPSQUALITY = "solo";
		const input = pts(2);
		served.mockReturnValue({ pts: [] } as unknown as ReturnType<typeof leanGpsQualityServe>);
		expect(qualityFilterGpsViaLean(input, () => input)).toEqual([]);
		expect(served).toHaveBeenCalledOnce();
	});
});

describe("solo has no fallback, and says so", () => {
	// Every other mode swallows this and serves `tsResult`. With no TS arm there
	// is nothing to serve, and inventing something would be the masking fallback
	// the house rules forbid — so it throws and the decode fails loudly.
	it("throws a bridge failure instead of repairing it", () => {
		process.env.LEAN_GPSQUALITY = "solo";
		served.mockImplementation(() => {
			throw new LeanBridgeError("bridge down");
		});
		expect(() => qualityFilterGpsViaLean(pts(4), () => pts(4))).toThrow(LeanBridgeError);
	});

	it("throws on an error response, not just on a thrown bridge", () => {
		process.env.LEAN_GPSQUALITY = "solo";
		served.mockReturnValue({ error: "bad input" } as ReturnType<typeof leanGpsQualityServe>);
		expect(() => qualityFilterGpsViaLean(pts(4), () => pts(4))).toThrow(LeanBridgeError);
	});
});

describe("the ledger does not claim an agreement nobody measured", () => {
	// ⚠ `clean` is VACUOUSLY true under solo: no TS arm runs, so the diff
	// counters can never be incremented. Printing EXACT would be the same
	// false-green as a gate excusing a field by name — a reader could not tell
	// "agreed everywhere" from "nothing was compared".
	it("says SOLO rather than EXACT", () => {
		process.env.LEAN_GPSQUALITY = "solo";
		const input = pts(4);
		served.mockReturnValue({ pts: input.map(wire) } as ReturnType<typeof leanGpsQualityServe>);
		qualityFilterGpsViaLean(input, () => []);

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanGpsQualityLedger("2026-08-16");
		const line = log.mock.calls[0]?.[0] as string;

		expect(line).toContain("lean-gpsquality[solo]");
		expect(line).toContain("SOLO");
		expect(line).not.toContain("EXACT");
		expect(verdict?.mode).toBe("solo");
		expect(verdict?.klass).toBe("exact");
	});

	// Zero calls stays a failure under solo, and is the most serious version of
	// it: the tenant is the only arm, so never running means nothing filtered.
	it("still reports NOT EXERCISED when it never ran", () => {
		process.env.LEAN_GPSQUALITY = "solo";
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanGpsQualityLedger("2026-08-16");
		expect(log.mock.calls[0]?.[0] as string).toContain("NOT EXERCISED");
		expect(verdict?.klass).toBe("not-exercised");
	});
});

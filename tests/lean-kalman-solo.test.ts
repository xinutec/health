/**
 * `LEAN_KALMAN=solo` — the second tenant to get the mode that lets its TS
 * implementation be deleted (#975).
 *
 * The contract and its rationale are documented once, on
 * `tests/lean-gpsquality-solo.test.ts`. What is pinned HERE is what differs:
 *
 *  - the result is the filter's OWN rows, not a selection of the input objects,
 *    so there is no identity to preserve and `fromWire` is the only way back;
 *  - the ledger must not print `ULP` either. That word names the measured
 *    `cos` libm class — a claim that two runtimes agreed to within a bit —
 *    which is precisely the comparison `solo` does not make. `EXACT` is the
 *    obvious false-green; `ULP` is the one specific to this tenant.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GpsPoint } from "../src/geo/kalman.js";
import { LeanBridgeError, leanKalmanServe } from "../src/lean/lean-core.js";
import {
	filterGpsTrackViaLean,
	leanKalmanMode,
	logLeanKalmanLedger,
	resetLeanKalmanStats,
} from "../src/lean/lean-kalman.js";

vi.mock("../src/lean/lean-core.js", async (orig) => ({
	...(await orig<typeof import("../src/lean/lean-core.js")>()),
	leanKalmanServe: vi.fn(),
}));

const served = vi.mocked(leanKalmanServe);

function bits(v: number): string {
	const b = new DataView(new ArrayBuffer(8));
	b.setFloat64(0, v);
	return b.getBigUint64(0).toString();
}

const pts = (n: number): GpsPoint[] =>
	Array.from({ length: n }, (_, i) => ({ ts: 1000 + i, lat: 51.5, lon: -0.1, accuracy: 10 })) as GpsPoint[];

/** `[ts, lat, lon, speed_kmh, bearing]`, all but `ts` as float bits. */
const row = (ts: number) => [ts, bits(51.5), bits(-0.1), bits(4.2), bits(90)];

beforeEach(() => {
	resetLeanKalmanStats();
	served.mockReset();
});

afterEach(() => {
	delete process.env.LEAN_KALMAN;
	resetLeanKalmanStats();
	vi.restoreAllMocks();
});

describe("the kalman solo flag", () => {
	it("parses solo and fails safe on anything else", () => {
		process.env.LEAN_KALMAN = "solo";
		expect(leanKalmanMode()).toBe("solo");
		for (const v of ["sol", "SOLO", "solo ", ""]) {
			process.env.LEAN_KALMAN = v;
			expect(leanKalmanMode()).toBe("off");
		}
	});
});

describe("solo does not run the TS arm", () => {
	it("never calls the thunk", () => {
		process.env.LEAN_KALMAN = "solo";
		served.mockReturnValue({ pts: [row(1000), row(1001)] } as unknown as ReturnType<typeof leanKalmanServe>);
		const ts = () => {
			throw new Error("solo must not evaluate the TS arm");
		};
		expect(() => filterGpsTrackViaLean(pts(2), ts)).not.toThrow();
		expect(served).toHaveBeenCalledOnce();
	});

	// The filter emits its own smoothed rows — it does not pick from the input —
	// so the count is the bridge's, not the caller's, and a solo implementation
	// that echoed the input would look right on a track the filter kept whole.
	it("returns the FILTER's rows, not the input", () => {
		process.env.LEAN_KALMAN = "solo";
		served.mockReturnValue({ pts: [row(7000)] } as unknown as ReturnType<typeof leanKalmanServe>);
		const out = filterGpsTrackViaLean(pts(5), () => []);
		expect(out).toHaveLength(1);
		expect(out[0].ts).toBe(7000);
		expect(out[0].speed_kmh).toBeCloseTo(4.2);
		expect(out[0].bearing).toBeCloseTo(90);
	});
});

describe("solo has no fallback", () => {
	it("throws a bridge failure instead of repairing it", () => {
		process.env.LEAN_KALMAN = "solo";
		served.mockImplementation(() => {
			throw new LeanBridgeError("bridge down");
		});
		expect(() => filterGpsTrackViaLean(pts(3), () => pts(3) as never)).toThrow(LeanBridgeError);
	});

	it("throws on an error response too", () => {
		process.env.LEAN_KALMAN = "solo";
		served.mockReturnValue({ error: "bad input" } as unknown as ReturnType<typeof leanKalmanServe>);
		expect(() => filterGpsTrackViaLean(pts(3), () => pts(3) as never)).toThrow(LeanBridgeError);
	});
});

describe("the ledger claims no comparison it did not make", () => {
	it("says SOLO, and specifically not ULP", () => {
		process.env.LEAN_KALMAN = "solo";
		served.mockReturnValue({ pts: [row(1000)] } as unknown as ReturnType<typeof leanKalmanServe>);
		// A THROWING thunk, not `() => []`. Without the solo branch, `solo` is not
		// `off` either, so it falls through to the comparison path — which serves
		// `tsResult` while the ledger still prints SOLO, because `mode` is what the
		// verdict reads. Measured: with `() => []` this test passed under ablation
		// while four others failed, i.e. it pinned the WORD and not the behaviour.
		filterGpsTrackViaLean(pts(1), () => {
			throw new Error("solo must not evaluate the TS arm");
		});

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanKalmanLedger("2026-08-17");
		const line = log.mock.calls[0]?.[0] as string;

		expect(line).toContain("lean-kalman[solo]");
		expect(line).toContain("SOLO");
		expect(line).not.toContain("EXACT");
		// The tenant-specific false-green: `ULP` asserts the two runtimes agreed
		// to within a bit, which is the comparison solo skips entirely.
		expect(line).not.toContain("ULP");
		expect(verdict?.mode).toBe("solo");
	});

	it("still reports NOT EXERCISED when it never ran", () => {
		process.env.LEAN_KALMAN = "solo";
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanKalmanLedger("2026-08-17");
		expect(log.mock.calls[0]?.[0] as string).toContain("NOT EXERCISED");
		expect(verdict?.klass).toBe("not-exercised");
	});
});

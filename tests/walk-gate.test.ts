import { describe, expect, it } from "vitest";
import {
	gateWalks,
	OFFPATH_EPS_M,
	P90_EPS_M,
	ROUTE_EPS,
	STALL_EPS_M,
	WALK_SPEED_CEIL_KMH,
	type WalkBaseline,
	type WalkBaselineEntry,
} from "../src/eval/walk-gate.js";

function walk(overrides: Partial<WalkBaselineEntry> = {}): WalkBaselineEntry {
	return {
		startTs: 1_000_000,
		p90M: 8,
		stallM: 20,
		speedKmh: 4.5,
		routeCorr: 0.8,
		offPathM: 0,
		...overrides,
	};
}

function day(entries: WalkBaselineEntry[]): WalkBaseline {
	return { "2026-07-01": entries };
}

describe("gateWalks", () => {
	it("passes an identical run: nothing regressed, improved, added, or lost", () => {
		const b = day([walk()]);
		const r = gateWalks(b, day([walk()]));
		expect(r.regressed).toEqual([]);
		expect(r.improved).toEqual([]);
		expect(r.added).toEqual([]);
		expect(r.unmatched).toEqual([]);
		expect(r.unmeasured).toEqual([]);
	});

	it("flags a p90 rise beyond the epsilon as a regression", () => {
		const r = gateWalks(day([walk({ p90M: 8 })]), day([walk({ p90M: 8 + P90_EPS_M + 1 })]));
		expect(r.regressed).toHaveLength(1);
		expect(r.regressed[0]).toMatchObject({ date: "2026-07-01", metric: "p90", base: 8 });
	});

	it("tolerates a p90 rise within the epsilon", () => {
		const r = gateWalks(day([walk({ p90M: 8 })]), day([walk({ p90M: 8 + P90_EPS_M - 0.5 })]));
		expect(r.regressed).toEqual([]);
	});

	it("reports a p90 drop beyond the epsilon as an improvement (re-bless signal)", () => {
		const r = gateWalks(day([walk({ p90M: 12 })]), day([walk({ p90M: 12 - P90_EPS_M - 1 })]));
		expect(r.regressed).toEqual([]);
		expect(r.improved.some((i) => i.metric === "p90")).toBe(true);
	});

	it("flags a stall rise beyond the epsilon; tolerates within", () => {
		expect(
			gateWalks(day([walk({ stallM: 20 })]), day([walk({ stallM: 20 + STALL_EPS_M + 1 })])).regressed,
		).toHaveLength(1);
		expect(gateWalks(day([walk({ stallM: 20 })]), day([walk({ stallM: 20 + STALL_EPS_M - 1 })])).regressed).toEqual([]);
	});

	it("flags a route-correctness drop beyond the epsilon", () => {
		const r = gateWalks(day([walk({ routeCorr: 0.8 })]), day([walk({ routeCorr: 0.8 - ROUTE_EPS - 0.05 })]));
		expect(r.regressed).toHaveLength(1);
		expect(r.regressed[0].metric).toBe("route");
	});

	it("flags a walk crossing the speed ceiling; a standing over-ceiling walk is not re-flagged", () => {
		const crossed = gateWalks(
			day([walk({ speedKmh: 5 })]),
			day([walk({ speedKmh: WALK_SPEED_CEIL_KMH + 1 })]),
		).regressed;
		expect(crossed).toHaveLength(1);
		expect(crossed[0].metric).toBe("speed");
		const standing = gateWalks(
			day([walk({ speedKmh: WALK_SPEED_CEIL_KMH + 1 })]),
			day([walk({ speedKmh: WALK_SPEED_CEIL_KMH + 2 })]),
		).regressed;
		expect(standing).toEqual([]);
	});

	it("flags an off-path building-crossing rise beyond the epsilon", () => {
		const r = gateWalks(day([walk({ offPathM: 0 })]), day([walk({ offPathM: OFFPATH_EPS_M + 5 })]));
		expect(r.regressed).toHaveLength(1);
		expect(r.regressed[0].metric).toBe("offPath");
	});

	it("never compares against a null baseline metric (newly measured ≠ regression)", () => {
		const r = gateWalks(
			day([walk({ p90M: null, routeCorr: null, offPathM: null })]),
			day([walk({ p90M: 50, routeCorr: 0.1, offPathM: 40 })]),
		);
		expect(r.regressed).toEqual([]);
	});

	it("surfaces a lost measurement (number → null) as unmeasured, not a regression", () => {
		const r = gateWalks(day([walk({ offPathM: 10 })]), day([walk({ offPathM: null })]));
		expect(r.regressed).toEqual([]);
		expect(r.unmeasured).toHaveLength(1);
		expect(r.unmeasured[0]).toMatchObject({ date: "2026-07-01", metric: "offPath" });
	});

	it("matches a walk whose startTs shifted within the tolerance", () => {
		const r = gateWalks(day([walk({ startTs: 1_000_000 })]), day([walk({ startTs: 1_000_090 })]));
		expect(r.regressed).toEqual([]);
		expect(r.added).toEqual([]);
		expect(r.unmatched).toEqual([]);
	});

	it("pairs each baseline walk with the nearest current walk, one-to-one", () => {
		// Two baseline walks 100s apart; current walks shifted +30s. Greedy
		// nearest-match must not pair both baselines to the same current walk.
		const b = day([walk({ startTs: 1_000_000, p90M: 5 }), walk({ startTs: 1_000_100, p90M: 20 })]);
		const c = day([walk({ startTs: 1_000_030, p90M: 5 }), walk({ startTs: 1_000_130, p90M: 20 })]);
		const r = gateWalks(b, c);
		expect(r.regressed).toEqual([]);
		expect(r.unmatched).toEqual([]);
		expect(r.added).toEqual([]);
	});

	it("reports a vanished baseline walk as unmatched and a new walk as added — neither fails the gate", () => {
		const r = gateWalks(
			day([walk({ startTs: 1_000_000 })]),
			day([walk({ startTs: 1_000_000 + 10_000 })]), // far outside tolerance
		);
		expect(r.regressed).toEqual([]);
		expect(r.unmatched).toHaveLength(1);
		expect(r.added).toHaveLength(1);
	});

	it("scopes the comparison to dates present in the current run (single-day invocation)", () => {
		const baseline: WalkBaseline = {
			"2026-07-01": [walk()],
			"2026-06-23": [walk({ p90M: 5 })],
		};
		// Current run only re-scored 07-01: 06-23 must not read as unmatched.
		const r = gateWalks(baseline, day([walk()]), { onlyDates: ["2026-07-01"] });
		expect(r.regressed).toEqual([]);
		expect(r.unmatched).toEqual([]);
	});
});

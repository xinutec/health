/**
 * The SHELL half of the biometric-labels tenant.
 *
 * `Verified.Geo.BiometricLabels` is pinned by its own `#guard`s against V8
 * (`lean/experiments/biometric-labels-refs.mts`), so the decisions themselves
 * are covered there. What is NOT covered there is the code in
 * `lean-biometric-labels.ts` that turns a decision into a segment — the reason
 * concatenation, the tag append, the place drop and the merge. That code is
 * mine, not the port's, and a bug in it would make `on` serve something the
 * verified core never decided.
 *
 * These drive `applyDecision` / `rebuildWalkThrough` DIRECTLY, with a plan
 * supplied by hand, rather than through the tenant entry points. Not for
 * convenience: the bridge is a worker thread the caller blocks on, and under
 * vitest it never completes — every call reports `lean-bridge: degraded —
 * falling back to TS (call timed out)` after 20 s. So a test that routed
 * through it would silently measure the TS arm and pass for the wrong reason.
 * That is exactly why the corpus gate (`npm run golden` under
 * `LEAN_BIOLABELS=on`, which is a plain node process) is where the serving path
 * is verified end to end.
 */
import { describe, expect, it } from "vitest";
import {
	applyDecision,
	correctModeFromCadenceViaLean,
	type LabelSeg,
	leanBioLabelsMode,
	logLeanBioLabelsLedger,
	rebuildWalkThrough,
	resetLeanBioLabelsStats,
} from "../src/lean/lean-biometric-labels.js";

const T0 = 1778457600;

function seg(o: Partial<LabelSeg> = {}): LabelSeg {
	return {
		startTs: T0,
		endTs: T0 + 300,
		mode: "walking",
		avgSpeed: 3,
		maxSpeed: 0,
		linearity: 0.8,
		pointCount: 5,
		...o,
	};
}

describe("mode gating", () => {
	// The default has to be off, or merely deploying the code changes behaviour
	// before anyone has decided to measure it.
	it("is off unless the env says otherwise", () => {
		const prior = process.env.LEAN_BIOLABELS;
		process.env.LEAN_BIOLABELS = undefined;
		delete process.env.LEAN_BIOLABELS;
		expect(leanBioLabelsMode()).toBe("off");
		process.env.LEAN_BIOLABELS = "nonsense";
		expect(leanBioLabelsMode()).toBe("off");
		process.env.LEAN_BIOLABELS = "shadow";
		expect(leanBioLabelsMode()).toBe("shadow");
		process.env.LEAN_BIOLABELS = "on";
		expect(leanBioLabelsMode()).toBe("on");
		if (prior === undefined) delete process.env.LEAN_BIOLABELS;
		else process.env.LEAN_BIOLABELS = prior;
	});

	// Off must not touch the bridge at all — not even to fail and fall back,
	// which would cost a process spawn on every request for no measurement.
	it("returns the TS result untouched when off", () => {
		const prior = process.env.LEAN_BIOLABELS;
		delete process.env.LEAN_BIOLABELS;
		const input = [seg()];
		const tsResult = [seg({ refinedMode: "driving" })];
		expect(correctModeFromCadenceViaLean(input, [], () => tsResult)).toBe(tsResult);
		if (prior !== undefined) process.env.LEAN_BIOLABELS = prior;
	});

	// An empty day is not a bridge call. It is also not a divergence.
	it("short-circuits an empty segment list", () => {
		const prior = process.env.LEAN_BIOLABELS;
		process.env.LEAN_BIOLABELS = "shadow";
		resetLeanBioLabelsStats();
		const tsResult: LabelSeg[] = [];
		expect(correctModeFromCadenceViaLean([], [], () => tsResult)).toBe(tsResult);
		if (prior === undefined) delete process.env.LEAN_BIOLABELS;
		else process.env.LEAN_BIOLABELS = prior;
	});
});

describe("the ledger", () => {
	it("says nothing at all when off", () => {
		const prior = process.env.LEAN_BIOLABELS;
		delete process.env.LEAN_BIOLABELS;
		const lines: string[] = [];
		const real = console.log;
		console.log = (m: string) => void lines.push(m);
		try {
			logLeanBioLabelsLedger("2026-07-30");
		} finally {
			console.log = real;
		}
		expect(lines).toEqual([]);
		if (prior !== undefined) process.env.LEAN_BIOLABELS = prior;
	});

	// The point of #387: a run with zero calls must SAY so, because "no
	// divergences" and "never ran" look identical otherwise.
	it("distinguishes a clean run from one that never called the bridge", () => {
		const prior = process.env.LEAN_BIOLABELS;
		process.env.LEAN_BIOLABELS = "shadow";
		resetLeanBioLabelsStats();
		const lines: string[] = [];
		const real = console.log;
		console.log = (m: string) => void lines.push(m);
		try {
			logLeanBioLabelsLedger("2026-07-30");
		} finally {
			console.log = real;
		}
		expect(lines[0]).toContain("(no calls)");
		// The VERDICT has to carry it too, not just the marker. Until #392 this
		// line read `0/0f (no calls) EXACT` — the same word a run that checked 160
		// segments and agreed on all of them prints. A human skimming, and any
		// gate reading the verdict, both take that for a pass. `lean-hsmm[on]
		// golden 0d (no days) EXACT` was that failure in the wild: the corpus
		// replays cached decodes, so the decoder had not run at all.
		expect(lines[0]).toContain("NOT EXERCISED");
		expect(lines[0]).not.toContain("EXACT");
		if (prior === undefined) delete process.env.LEAN_BIOLABELS;
		else process.env.LEAN_BIOLABELS = prior;
	});
});

describe("applyDecision", () => {
	it("leaves a segment alone on a keep, by identity", () => {
		const s = seg();
		expect(applyDecision(s, null)).toBe(s);
	});

	// The reason is a FRAGMENT: the pass appends it to whatever a previous pass
	// already wrote, so a segment can accumulate a chain of them.
	it("appends the reason onto an existing one rather than replacing it", () => {
		const fresh = applyDecision(seg(), ["driving", "low cadence (0/min)", "low-cadence"]);
		expect(fresh.refinedReason).toBe("low cadence (0/min)");

		const chained = applyDecision(seg({ refinedReason: "gps gap inferred" }), [
			"driving",
			"low cadence (0/min)",
			"low-cadence",
		]);
		expect(chained.refinedReason).toBe("gps gap inferred; low cadence (0/min)");
	});

	// An earlier tag must survive a later one — that is the whole reason
	// `addRefinedKind` exists rather than a plain assignment.
	it("adds a tag without dropping one already carried", () => {
		const out = applyDecision(seg({ refinedKinds: ["gps-gap-inferred"] }), [
			"stationary",
			"…sitting, GPS jitter",
			"gps-jitter",
		]);
		expect(out.refinedKinds).toEqual(["gps-gap-inferred", "gps-jitter"]);
	});

	// `revertIsolatedCadenceDrives` adds no tag. Notably it does not REMOVE the
	// `low-cadence` one either, which is why the flip test also requires
	// `refinedMode === "driving"`.
	it("leaves the tags untouched when the decision carries none", () => {
		const s = seg({ refinedMode: "driving", refinedKinds: ["low-cadence"] });
		const out = applyDecision(s, ["walking", "reverted cadence-drive", null]);
		expect(out.refinedMode).toBe("walking");
		expect(out.refinedKinds).toEqual(["low-cadence"]);
	});
});

describe("rebuildWalkThrough", () => {
	const W = 300;
	const flip: [string, string, string | null] = ["walking", "walking burst (95/min) with GPS movement", null];

	// A walk-through is no longer a stop, so its stay label must go. Serving a
	// flipped segment that kept `place` would name a walk after the venue it
	// walked past — the failure `applyStationaryWalkThrough` exists to avoid.
	it("drops place and city on a flip, and only on a flip", () => {
		const before = seg({ startTs: T0, endTs: T0 + W, mode: "stationary", avgSpeed: 0, place: "Work" });
		const stroll = seg({
			startTs: T0 + W,
			endTs: T0 + 2 * W,
			mode: "stationary",
			avgSpeed: 1.4,
			place: "Park U",
			city: "London",
		});
		const after = seg({ startTs: T0 + 2 * W, endTs: T0 + 3 * W, mode: "stationary", avgSpeed: 0, place: "Home" });

		const out = rebuildWalkThrough(
			[before, stroll, after],
			[null, flip, null],
			[
				[0, 1],
				[1, 2],
				[2, 3],
			],
		);

		expect(out).toHaveLength(3);
		expect(out[1].refinedMode).toBe("walking");
		expect(out[1].refinedReason).toBe("walking burst (95/min) with GPS movement");
		expect(out[1].place).toBeUndefined();
		expect(out[1].city).toBeUndefined();
		// The bracketing stays keep theirs.
		expect(out[0].place).toBe("Work");
		expect(out[2].place).toBe("Home");
	});

	// The merge reproduces `mergeAdjacentWalking`: span the time, sum the
	// points, take the max speed, keep a real wayName from any part.
	it("collapses a run the way mergeAdjacentWalking does", () => {
		const walkBefore = seg({ startTs: T0, endTs: T0 + W, pointCount: 4, maxSpeed: 6 });
		const stroll = seg({
			startTs: T0 + W,
			endTs: T0 + 2 * W,
			mode: "stationary",
			avgSpeed: 1.4,
			pointCount: 7,
			maxSpeed: 9,
		});
		const walkAfter = seg({
			startTs: T0 + 2 * W,
			endTs: T0 + 3 * W,
			pointCount: 5,
			maxSpeed: 3,
			wayName: "Argyle Street",
		});

		const out = rebuildWalkThrough([walkBefore, stroll, walkAfter], [null, flip, null], [[0, 3]]);

		expect(out).toHaveLength(1);
		expect(out[0].startTs).toBe(T0);
		expect(out[0].endTs).toBe(T0 + 3 * W);
		expect(out[0].pointCount).toBe(16);
		expect(out[0].maxSpeed).toBe(9);
		// The label came from the third segment, which the merge reached past
		// the flipped middle one to find.
		expect(out[0].wayName).toBe("Argyle Street");
	});

	// The run list covers the input exactly once, so a plan of singletons must
	// leave the sequence alone — no merging, no dropping.
	it("is the identity on a plan of singletons with no flips", () => {
		const segs = [seg({ startTs: T0, endTs: T0 + W }), seg({ startTs: T0 + W, endTs: T0 + 2 * W })];
		const out = rebuildWalkThrough(
			segs,
			[null, null],
			[
				[0, 1],
				[1, 2],
			],
		);
		expect(out).toEqual(segs);
	});
});

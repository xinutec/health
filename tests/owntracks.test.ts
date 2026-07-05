import { describe, expect, it } from "vitest";
import {
	classifyFromHistory,
	classifyMotion,
	computeSignals,
	type DecisionSignals,
	decideRemoteConfig,
	decideTransition,
	demoteAfterStop,
	effectiveSpeedKmh,
	escalateFromSignificant,
	escalateOnHighSpeed,
	type FixRecord,
	type MotionProfile,
	pruneFixHistory,
	refineInMove,
	straightnessRatio,
} from "../src/routes/owntracks.js";

/** Build a DecisionSignals with all fields defaulted to "no signal";
 *  overrides set only what each test cares about. */
function signals(overrides: Partial<DecisionSignals> = {}): DecisionSignals {
	return {
		reportedVelKmh: 0,
		computedVelKmh: 0,
		gapSinceLastFixSec: 0,
		effectiveSpeedKmh: 0,
		straightness: 0,
		historySpanSec: 0,
		trigger: null,
		monitoringMode: null,
		...overrides,
	};
}

/** Build a chain of fixes starting at (lat0, lon0), stepping `dLat`/`dLon`
 *  degrees per fix, with `dtSec` seconds between fixes. The first fix is at
 *  `t0`. Used to construct deterministic walking-shape trajectories. */
function chain(opts: {
	lat0: number;
	lon0: number;
	dLat: number;
	dLon: number;
	t0: number;
	dtSec: number;
	n: number;
}): FixRecord[] {
	const out: FixRecord[] = [];
	for (let i = 0; i < opts.n; i++) {
		out.push({ ts: opts.t0 + i * opts.dtSec, lat: opts.lat0 + i * opts.dLat, lon: opts.lon0 + i * opts.dLon });
	}
	return out;
}

describe("classifyMotion", () => {
	// Coarse motion regimes derived from a single velocity reading.
	// Used to drive Owntracks remote config — each regime maps to a
	// different fix-density / battery trade-off.

	it("returns transit-fast for sustained high speed (> 80 km/h)", () => {
		expect(classifyMotion(120)).toBe("transit-fast");
		expect(classifyMotion(300)).toBe("transit-fast"); // train, plane
	});

	it("returns transit for moderate speed (30 < v <= 80 km/h)", () => {
		expect(classifyMotion(50)).toBe("transit");
		expect(classifyMotion(70)).toBe("transit");
	});

	it("returns stationary for very low speed (< 5 km/h)", () => {
		expect(classifyMotion(0)).toBe("stationary");
		expect(classifyMotion(2)).toBe("stationary");
	});

	it("returns null for ambiguous mid-range (5-30 km/h)", () => {
		// Walking, cycling, slow drives — too many possibilities to make
		// a confident server-side decision. Don't push a profile.
		expect(classifyMotion(7)).toBeNull();
		expect(classifyMotion(20)).toBeNull();
	});

	it("uses strict boundaries (< and >)", () => {
		expect(classifyMotion(5)).toBeNull(); // not stationary
		expect(classifyMotion(30)).toBeNull(); // not transit
		expect(classifyMotion(80)).toBe("transit"); // exactly 80 is still transit, not fast
	});
});

describe("decideRemoteConfig", () => {
	// Every call returns a concrete profile + patch — the proxy pushes
	// the full config on every fix. The phone applies it idempotently,
	// so re-sending the same config is a no-op on the phone side.

	it("returns the config for transit-fast when not yet set", () => {
		const r = decideRemoteConfig(120, null);
		expect(r.profile).toBe("transit-fast");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 10 });
	});

	it("returns the config for transit when transitioning from stationary", () => {
		const r = decideRemoteConfig(50, "stationary");
		expect(r.profile).toBe("transit");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 15 });
	});

	it("does NOT demote from transit to stationary on a single vel=0 fix (bug fix)", () => {
		// Real-world: tube tunnel produces a fix with vel=0 or vel missing.
		// We must not flip the phone back to Significant on a single weird
		// reading — that loses Move-mode tracking for the rest of the run.
		// De-escalation requires history evidence, not a single fix. The
		// pushed config preserves the previous profile.
		const r = decideRemoteConfig(0, "transit");
		expect(r.profile).toBe("transit");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 15 });
	});

	it("re-sends the same config when profile equals lastProfile (idempotent push)", () => {
		// Always-push: every fix gets the current profile's config back,
		// even when the decision is "no change". The phone treats a
		// re-applied identical config as a no-op.
		expect(decideRemoteConfig(120, "transit-fast").patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 10 });
		expect(decideRemoteConfig(50, "transit").patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 15 });
		expect(decideRemoteConfig(0, "stationary").patch).toEqual({ monitoring: 1 });
	});

	it("preserves lastProfile and pushes its config for ambiguous speeds", () => {
		const r = decideRemoteConfig(20, "transit");
		expect(r.profile).toBe("transit");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 15 });
	});

	it("falls back to stationary on the very first fix with no signal", () => {
		// First-ever request for a device: lastProfile is null and the
		// decision cascade says "keep". DEFAULT_PROFILE = stationary
		// matches the phone's factory-default mode, so the pushed config
		// is a no-op on the phone but still arrives.
		const r = decideRemoteConfig(0, null);
		expect(r.profile).toBe("stationary");
		expect(r.patch).toEqual({ monitoring: 1 });
	});

	it("transitions from fast to slow transit pushes the new interval", () => {
		// e.g., train slowing into a station, dropping from 100 to 60 km/h.
		// We want the moveModeLocatorInterval to relax from 10s to 15s.
		const r = decideRemoteConfig(60, "transit-fast");
		expect(r.profile).toBe("transit");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 15 });
	});

	it("type guards: patch is always a concrete OwntracksConfig-like object", () => {
		const r = decideRemoteConfig(120, null);
		expect(typeof r.patch.monitoring).toBe("number");
	});

	it("MotionProfile type narrows to a finite set", () => {
		const p: MotionProfile = "transit";
		expect(["transit-fast", "transit", "walking", "stationary", null]).toContain(p);
	});
});

describe("pruneFixHistory", () => {
	// Drops fixes older than `now - maxAgeSec`. Used per-request to keep the
	// in-memory history bounded and to give the walking heuristic a fresh
	// window (drift fixes from hours ago shouldn't count toward a walk).

	it("returns empty for empty input", () => {
		expect(pruneFixHistory([], 600, 1_000_000)).toEqual([]);
	});

	it("keeps fixes within the window", () => {
		const h: FixRecord[] = [
			{ ts: 1500, lat: 0, lon: 0 }, // age 500s, within 600s window
			{ ts: 1700, lat: 0, lon: 0 },
			{ ts: 1900, lat: 0, lon: 0 },
		];
		expect(pruneFixHistory(h, 600, 2000)).toEqual(h);
	});

	it("drops fixes older than the cutoff", () => {
		const h: FixRecord[] = [
			{ ts: 100, lat: 0, lon: 0 }, // age 1900s, dropped
			{ ts: 1500, lat: 0, lon: 0 }, // age 500s, kept
			{ ts: 1900, lat: 0, lon: 0 }, // age 100s, kept
		];
		expect(pruneFixHistory(h, 600, 2000)).toEqual([
			{ ts: 1500, lat: 0, lon: 0 },
			{ ts: 1900, lat: 0, lon: 0 },
		]);
	});

	it("preserves chronological order", () => {
		const h: FixRecord[] = [
			{ ts: 1000, lat: 1, lon: 1 },
			{ ts: 1100, lat: 2, lon: 2 },
			{ ts: 1200, lat: 3, lon: 3 },
		];
		const out = pruneFixHistory(h, 600, 1300);
		expect(out.map((f) => f.ts)).toEqual([1000, 1100, 1200]);
	});

	it("keeps the boundary (ts === now - maxAgeSec)", () => {
		// Exactly at the cutoff should be kept — we want inclusive lower bound
		// so the heuristic doesn't drop a fix that just barely fits.
		const out = pruneFixHistory([{ ts: 400, lat: 0, lon: 0 }], 600, 1000);
		expect(out).toEqual([{ ts: 400, lat: 0, lon: 0 }]);
	});
});

describe("effectiveSpeedKmh", () => {
	// Total path distance divided by total elapsed time. Distinguishes "GPS
	// jitter while stationary" (low speed) from "actually moving" (real
	// speed). Computed across the whole window, not just the latest segment.

	it("returns 0 for empty / single-fix history", () => {
		expect(effectiveSpeedKmh([])).toBe(0);
		expect(effectiveSpeedKmh([{ ts: 0, lat: 0, lon: 0 }])).toBe(0);
	});

	it("returns 0 when total elapsed time is 0", () => {
		// Two fixes with the same timestamp would yield divide-by-zero
		// otherwise. Real phones can theoretically batch-emit fixes at the
		// same tst — guard against it.
		expect(
			effectiveSpeedKmh([
				{ ts: 1000, lat: 0, lon: 0 },
				{ ts: 1000, lat: 0.001, lon: 0 },
			]),
		).toBe(0);
	});

	it("computes ~6 km/h for 100m over 60s", () => {
		// At the equator, 0.0009 degrees latitude ≈ 100m.
		const h: FixRecord[] = [
			{ ts: 1000, lat: 0, lon: 0 },
			{ ts: 1060, lat: 0.0009, lon: 0 },
		];
		expect(effectiveSpeedKmh(h)).toBeCloseTo(6, 0);
	});

	it("sums path distance across multiple fixes", () => {
		// Three fixes, each 100m apart, 60s apart. Path = 200m, time = 120s.
		// Effective speed = 6 km/h.
		const h: FixRecord[] = [
			{ ts: 1000, lat: 0, lon: 0 },
			{ ts: 1060, lat: 0.0009, lon: 0 },
			{ ts: 1120, lat: 0.0018, lon: 0 },
		];
		expect(effectiveSpeedKmh(h)).toBeCloseTo(6, 0);
	});
});

describe("straightnessRatio", () => {
	// Net displacement (first → last) divided by total path distance. Real
	// walking yields >0.5 because you're heading somewhere; GPS jitter while
	// stationary yields near 0 (path bounces around, net displacement small).

	it("returns 0 for empty / single-fix history", () => {
		expect(straightnessRatio([])).toBe(0);
		expect(straightnessRatio([{ ts: 0, lat: 0, lon: 0 }])).toBe(0);
	});

	it("returns 0 when path distance is 0 (all same point)", () => {
		const h: FixRecord[] = [
			{ ts: 0, lat: 1, lon: 1 },
			{ ts: 60, lat: 1, lon: 1 },
			{ ts: 120, lat: 1, lon: 1 },
		];
		expect(straightnessRatio(h)).toBe(0);
	});

	it("returns ~1 for a perfectly colinear walk", () => {
		const h = chain({ lat0: 0, lon0: 0, dLat: 0.0009, dLon: 0, t0: 0, dtSec: 60, n: 5 });
		expect(straightnessRatio(h)).toBeCloseTo(1, 5);
	});

	it("returns ~0.707 for a 90-degree L-shape with equal legs", () => {
		// 100m east, then 100m north. Net = sqrt(2)*100 ≈ 141m, path = 200m.
		const h: FixRecord[] = [
			{ ts: 0, lat: 0, lon: 0 },
			{ ts: 60, lat: 0, lon: 0.0009 }, // 100m east
			{ ts: 120, lat: 0.0009, lon: 0.0009 }, // 100m north
		];
		expect(straightnessRatio(h)).toBeCloseTo(Math.SQRT1_2, 1);
	});

	it("returns ~0 for a back-and-forth wander (return to start)", () => {
		// Go out 100m, come back. Path = 200m, net ≈ 0.
		const h: FixRecord[] = [
			{ ts: 0, lat: 0, lon: 0 },
			{ ts: 60, lat: 0.0009, lon: 0 },
			{ ts: 120, lat: 0, lon: 0 },
		];
		expect(straightnessRatio(h)).toBeLessThan(0.05);
	});

	it("stays high for a slightly noisy walk (real-world tolerance)", () => {
		// Mostly heading north with small east/west wobble. Still clearly
		// directional — the heuristic must not punish realistic GPS noise.
		const h: FixRecord[] = [
			{ ts: 0, lat: 0, lon: 0 },
			{ ts: 60, lat: 0.0009, lon: 0.00005 },
			{ ts: 120, lat: 0.0018, lon: -0.00005 },
			{ ts: 180, lat: 0.0027, lon: 0.00003 },
			{ ts: 240, lat: 0.0036, lon: 0 },
		];
		expect(straightnessRatio(h)).toBeGreaterThan(0.9);
	});
});

describe("classifyFromHistory", () => {
	// Returns "walking" when the recent fix history shows directional motion
	// in the walking-speed band, null otherwise. Caller is responsible for
	// pruning the history to the desired time window first.

	it("returns null when fewer than 3 fixes are available", () => {
		expect(classifyFromHistory([])).toBeNull();
		expect(classifyFromHistory([{ ts: 0, lat: 0, lon: 0 }])).toBeNull();
		expect(
			classifyFromHistory([
				{ ts: 0, lat: 0, lon: 0 },
				{ ts: 60, lat: 0.0009, lon: 0 },
			]),
		).toBeNull();
	});

	it("returns 'walking' for a straight 4 km/h trajectory over 4 fixes", () => {
		// 100m every 90s → 4 km/h, perfectly colinear.
		const h = chain({ lat0: 0, lon0: 0, dLat: 0.0009, dLon: 0, t0: 0, dtSec: 90, n: 4 });
		expect(classifyFromHistory(h)).toBe("walking");
	});

	it("returns 'walking' for a slightly bent walk (straightness ~0.7)", () => {
		// L-shape walk at ~4 km/h. Straightness ~0.707, above the 0.5 cutoff.
		const h: FixRecord[] = [
			{ ts: 0, lat: 0, lon: 0 },
			{ ts: 90, lat: 0, lon: 0.0009 },
			{ ts: 180, lat: 0, lon: 0.0018 },
			{ ts: 270, lat: 0.0009, lon: 0.0018 },
			{ ts: 360, lat: 0.0018, lon: 0.0018 },
		];
		expect(classifyFromHistory(h)).toBe("walking");
	});

	it("returns null for a wandering walk (low straightness)", () => {
		// 4 km/h effective speed but circling around — no clear direction.
		const h: FixRecord[] = [
			{ ts: 0, lat: 0, lon: 0 },
			{ ts: 90, lat: 0.0009, lon: 0 },
			{ ts: 180, lat: 0.0009, lon: 0.0009 },
			{ ts: 270, lat: 0, lon: 0.0009 },
			{ ts: 360, lat: 0, lon: 0 }, // back to start
		];
		expect(classifyFromHistory(h)).toBeNull();
	});

	it("returns null for slow drift (under walking-speed lower bound)", () => {
		// 0.5 km/h — GPS noise while standing still, even if "straight".
		// Net ~50m over 6 minutes. Walking band starts at 2 km/h.
		const h: FixRecord[] = [
			{ ts: 0, lat: 0, lon: 0 },
			{ ts: 120, lat: 0.0001, lon: 0 },
			{ ts: 240, lat: 0.0002, lon: 0 },
			{ ts: 360, lat: 0.0003, lon: 0 },
		];
		expect(classifyFromHistory(h)).toBeNull();
	});

	it("returns null when speed exceeds the walking band (let single-fix path handle it)", () => {
		// 18 km/h over a straight line — cycling or slow driving. The
		// single-fix classifier already covers transit speeds well; the
		// history heuristic only fills in the walking gap, so return null
		// here and let the caller's transit/transit-fast path decide.
		const h = chain({ lat0: 0, lon0: 0, dLat: 0.0045, dLon: 0, t0: 0, dtSec: 90, n: 4 });
		expect(classifyFromHistory(h)).toBeNull();
	});
});

describe("decideRemoteConfig with history", () => {
	// History is the multi-fix walking signal; single-fix speed is the
	// transit / stationary signal. High single-fix speed wins (faster to
	// react when boarding a train); otherwise history overrides the
	// stationary fallback so a 4 km/h "walk" doesn't read as stationary.

	const walkingHistory = chain({ lat0: 0, lon0: 0, dLat: 0.0009, dLon: 0, t0: 0, dtSec: 90, n: 4 });

	it("pushes 'walking' patch when history is walking and speed is sub-stationary", () => {
		// Owntracks `vel` can be unreported or zero on the first walking
		// fix — but the historical fixes already show a walk in progress.
		const r = decideRemoteConfig(0, null, walkingHistory);
		expect(r.profile).toBe("walking");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 30 });
	});

	it("pushes 'walking' patch when last profile was stationary", () => {
		const r = decideRemoteConfig(0, "stationary", walkingHistory);
		expect(r.profile).toBe("walking");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 30 });
	});

	it("re-pushes walking patch even when already walking (always-push)", () => {
		// History still says walking; the proxy re-sends the walking
		// config on every fix and the phone applies it idempotently.
		const r = decideRemoteConfig(0, "walking", walkingHistory);
		expect(r.profile).toBe("walking");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 30 });
	});

	it("prefers high single-fix speed over walking history (board train)", () => {
		// History says walking, but the latest fix is a 120 km/h train.
		// The new code reads vel from the latest fix in history; the
		// route handler builds the history with the incoming vel.
		const boardingHistory: FixRecord[] = [...walkingHistory, { ts: 450, lat: 0.0045, lon: 0, vel: 120 }];
		const r = decideRemoteConfig(0, "walking", boardingHistory);
		expect(r.profile).toBe("transit-fast");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 10 });
	});

	it("resolves to factory-default stationary without history evidence", () => {
		// vel=0 with no history and no prior profile: the always-push
		// proxy still has to send a config. We resolve to the
		// factory-default Significant mode, which is a no-op on the
		// phone when it's already in Significant.
		const r = decideRemoteConfig(0, null, []);
		expect(r.profile).toBe("stationary");
		expect(r.patch).toEqual({ monitoring: 1 });
	});

	it("keeps transit mode under a single weird-zero fix when history shows transit speed", () => {
		// Bug fix: tube tunnel produces a fix with vel=0 mid-run; the
		// surrounding history is all 100 km/h. Must keep transit-fast,
		// not demote to stationary. The transit-fast config is re-sent.
		const transitHistory = chain({ lat0: 0, lon0: 0, dLat: 0.018, dLon: 0, t0: 0, dtSec: 60, n: 5 }); // ~120 km/h
		const r = decideRemoteConfig(0, "transit-fast", transitHistory);
		expect(r.profile).toBe("transit-fast");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 10 });
	});

	it("demotes to stationary only after >= 10 minutes at a long-stay location", () => {
		// 11 fixes spanning 600s, all near the same point. Real evidence
		// of stopping. Demote also requires the location gate
		// (atLongStayLocation: true) — see tests/long-stay-gate.test.ts
		// for the gate's coverage. At a non-long-stay location (e.g. a
		// supermarket) we deliberately don't demote.
		const stationaryHistory: FixRecord[] = Array.from({ length: 11 }, (_, i) => ({
			ts: i * 60,
			lat: 51.5 + (i % 2) * 0.00001,
			lon: -0.1 - (i % 2) * 0.00001,
		}));
		const r = decideRemoteConfig(0, "transit", stationaryHistory, { atLongStayLocation: true });
		expect(r.profile).toBe("stationary");
		expect(r.patch).toEqual({ monitoring: 1 });
	});

	it("does NOT demote at a transient location even with long stationary history", () => {
		// 30-min Lidl visit equivalent — long stationary history but no
		// long-stay focus place. Stay in Move mode so the walking
		// detector can refire as soon as the user starts walking.
		const stationaryHistory: FixRecord[] = Array.from({ length: 11 }, (_, i) => ({
			ts: i * 60,
			lat: 51.5,
			lon: -0.1,
		}));
		const r = decideRemoteConfig(0, "transit", stationaryHistory /* default: atLongStayLocation false */);
		expect(r.profile).toBe("transit");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 15 });
	});

	it("does not demote to stationary on a short low-speed run", () => {
		// 5 fixes, low speed, but only a 4-minute span — too short to
		// be confident the user actually stopped. Tube tunnels and stop
		// lights look like this. Keep the previous profile; its config
		// gets re-sent.
		const briefLowSpeed: FixRecord[] = [
			{ ts: 0, lat: 51.5, lon: -0.1 },
			{ ts: 60, lat: 51.5, lon: -0.1 },
			{ ts: 120, lat: 51.50001, lon: -0.1 },
			{ ts: 180, lat: 51.5, lon: -0.10001 },
			{ ts: 240, lat: 51.5, lon: -0.1 },
		];
		const r = decideRemoteConfig(0, "transit", briefLowSpeed);
		expect(r.profile).toBe("transit");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 15 });
	});

	it("history with wander does not push walking nor demote prematurely", () => {
		const wanderHistory: FixRecord[] = [
			{ ts: 0, lat: 0, lon: 0 },
			{ ts: 90, lat: 0.0009, lon: 0 },
			{ ts: 180, lat: 0.0009, lon: 0.0009 },
			{ ts: 270, lat: 0, lon: 0.0009 },
			{ ts: 360, lat: 0, lon: 0 },
		];
		// effective ~4 km/h but straightness 0 → no walking signal, but
		// also not below 2 km/h so not stationary either. Keep lastProfile,
		// re-push its config.
		const r = decideRemoteConfig(0, "transit", wanderHistory);
		expect(r.profile).toBe("transit");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 15 });
	});
});

describe("computeSignals", () => {
	// Reduces a fix history into the named signals consumed by the
	// decision predicates. Each numeric signal is well-defined for sparse
	// histories — predicates check historySpanSec / fix count to know
	// when a signal is meaningful.

	it("returns empty signals for empty history", () => {
		const s = computeSignals([]);
		expect(s.reportedVelKmh).toBe(0);
		expect(s.computedVelKmh).toBe(0);
		expect(s.gapSinceLastFixSec).toBe(0);
		expect(s.historySpanSec).toBe(0);
		expect(s.trigger).toBeNull();
		expect(s.monitoringMode).toBeNull();
	});

	it("reads reported vel / trigger / monitoring from the latest fix", () => {
		const s = computeSignals([{ ts: 1000, lat: 0, lon: 0, vel: 42, trigger: "u", monitoringMode: 1 }]);
		expect(s.reportedVelKmh).toBe(42);
		expect(s.trigger).toBe("u");
		expect(s.monitoringMode).toBe(1);
		expect(s.computedVelKmh).toBe(0); // no previous fix
	});

	it("computes velocity from displacement between the last two fixes", () => {
		// 100m in 60s → 6 km/h
		const s = computeSignals([
			{ ts: 0, lat: 0, lon: 0 },
			{ ts: 60, lat: 0.0009, lon: 0 },
		]);
		expect(s.computedVelKmh).toBeCloseTo(6, 0);
		expect(s.gapSinceLastFixSec).toBe(60);
	});

	it("treats vel=null in the latest fix as 0", () => {
		// Real-world: PhoneTrack-stored fixes routinely have speed: null.
		// computeSignals must not propagate null arithmetic.
		const s = computeSignals([
			{ ts: 0, lat: 51.5, lon: -0.1, vel: null },
			{ ts: 60, lat: 51.5, lon: -0.1, vel: null },
		]);
		expect(s.reportedVelKmh).toBe(0);
		expect(Number.isNaN(s.reportedVelKmh)).toBe(false);
	});
});

describe("escalateOnHighSpeed", () => {
	// Predicate 1: single-fix or computed velocity above the transit
	// threshold instantly escalates, regardless of history.

	it("escalates to transit-fast when reported vel is high", () => {
		expect(escalateOnHighSpeed(signals({ reportedVelKmh: 100 }))).toBe("transit-fast");
	});

	it("escalates to transit-fast when computed vel is high (vel missing)", () => {
		// Bug fix: previously we relied on reported vel only, so a fast
		// train fix with vel=null/0 was missed. Computed-from-displacement
		// catches it.
		expect(escalateOnHighSpeed(signals({ reportedVelKmh: 0, computedVelKmh: 100 }))).toBe("transit-fast");
	});

	it("uses the max of reported and computed", () => {
		expect(escalateOnHighSpeed(signals({ reportedVelKmh: 50, computedVelKmh: 100 }))).toBe("transit-fast");
		expect(escalateOnHighSpeed(signals({ reportedVelKmh: 100, computedVelKmh: 50 }))).toBe("transit-fast");
	});

	it("escalates to transit at moderate speed", () => {
		expect(escalateOnHighSpeed(signals({ reportedVelKmh: 50 }))).toBe("transit");
	});

	it("returns null below the transit threshold", () => {
		expect(escalateOnHighSpeed(signals({ reportedVelKmh: 25 }))).toBeNull();
		expect(escalateOnHighSpeed(signals({ reportedVelKmh: 0 }))).toBeNull();
	});
});

describe("escalateFromSignificant", () => {
	// Predicate 2: when the phone is in Significant mode, motion evidence
	// pushes us into a Move-mode profile. Three sources of motion
	// evidence; any one is sufficient.

	it("returns null without any motion evidence", () => {
		expect(escalateFromSignificant(signals())).toBeNull();
	});

	it("escalates on userAction trigger (t='u')", () => {
		// User manually fired "Report Location Now" — engagement signal.
		expect(escalateFromSignificant(signals({ trigger: "u" }))).toBe("transit");
	});

	it("returns null when monitoringMode says phone is in Move (gate is now internal)", () => {
		// Bug: the function is exported with a name that promises a
		// Significant→Move transition, but the actual gate happens at
		// the caller. Direct callers (and tests) can pass any
		// monitoringMode value. Fix: the function should also gate on
		// `signals.monitoringMode` and return null when the phone
		// reports it is already in Move mode.
		const s = signals({ monitoringMode: 2, gapSinceLastFixSec: 60, trigger: "u", computedVelKmh: 5 });
		expect(escalateFromSignificant(s)).toBeNull();
	});

	it("still escalates when monitoringMode is null (unknown) and motion evidence is present", () => {
		// Older Owntracks builds may not include the `m` field. Without
		// evidence to the contrary, treat the phone as in Significant
		// (status quo behaviour preserved). Catches over-strict gating
		// that would regress for users on older clients.
		const s = signals({ monitoringMode: null, gapSinceLastFixSec: 60 });
		expect(escalateFromSignificant(s)).toBe("transit");
	});

	it("escalates on a closely-spaced fix (< 5 min gap)", () => {
		// Significant mode normally schedules a fix every ~15 min;
		// extras come from the phone's motion sensor. Treat short gap
		// as evidence the user is moving.
		expect(escalateFromSignificant(signals({ gapSinceLastFixSec: 120 }))).toBe("transit");
	});

	it("does not escalate on a normal scheduled-cadence gap", () => {
		// 15 min apart = scheduled tick, no motion evidence.
		expect(escalateFromSignificant(signals({ gapSinceLastFixSec: 900 }))).toBeNull();
	});

	it("escalates on displacement-based velocity above walking floor", () => {
		// Phone reported vel=0 but it moved 200m in 5 min → 2.4 km/h.
		// That's real walking-band motion. Escalate.
		expect(escalateFromSignificant(signals({ computedVelKmh: 2.4, gapSinceLastFixSec: 300 }))).toBe("transit");
	});

	it("refines to walking when history supports it", () => {
		// Motion evidence present (gap=120) AND history shows a walk
		// (effective ~4 km/h, straightness 0.9, span > 2 min). Push
		// walking directly rather than transit-then-walking-on-next-fix.
		const s = signals({
			gapSinceLastFixSec: 120,
			effectiveSpeedKmh: 4,
			straightness: 0.9,
			historySpanSec: 270,
		});
		expect(escalateFromSignificant(s)).toBe("walking");
	});

	it("falls back to transit when motion evidence is present but history is too thin", () => {
		// First Significant-mode escape — gap signal triggered but we
		// don't yet have a full 2 min of history to refine.
		const s = signals({ gapSinceLastFixSec: 120, historySpanSec: 60 });
		expect(escalateFromSignificant(s)).toBe("transit");
	});
});

describe("refineInMove", () => {
	// Predicate 3: in Move mode, pick the precise profile from
	// effective speed + straightness.

	it("returns null when history span is too short", () => {
		expect(refineInMove(signals({ effectiveSpeedKmh: 100, historySpanSec: 60 }))).toBeNull();
	});

	it("picks transit-fast for sustained high effective speed", () => {
		expect(refineInMove(signals({ effectiveSpeedKmh: 100, historySpanSec: 200 }))).toBe("transit-fast");
	});

	it("picks transit for moderate effective speed", () => {
		expect(refineInMove(signals({ effectiveSpeedKmh: 50, historySpanSec: 200 }))).toBe("transit");
	});

	it("picks walking for walking-band speed + directional straightness", () => {
		expect(refineInMove(signals({ effectiveSpeedKmh: 4, straightness: 0.9, historySpanSec: 200 }))).toBe("walking");
	});

	it("returns null for walking-band speed with low straightness (wander)", () => {
		expect(refineInMove(signals({ effectiveSpeedKmh: 4, straightness: 0.2, historySpanSec: 200 }))).toBeNull();
	});
});

describe("demoteAfterStop", () => {
	// Predicate 4: after enough sustained low-speed history AT A
	// LONG-STAY LOCATION we push the phone back to Significant. See
	// tests/long-stay-gate.test.ts for the location-gate coverage;
	// these tests assume the gate has already said "yes, long-stay"
	// and verify the time/speed thresholds.
	const atHome = { atLongStayLocation: true };

	it("returns null on a short history (just escalated, nothing to act on yet)", () => {
		expect(demoteAfterStop(signals({ effectiveSpeedKmh: 0, historySpanSec: 60 }), atHome)).toBeNull();
	});

	it("returns null when effective speed is still in the walking band", () => {
		expect(demoteAfterStop(signals({ effectiveSpeedKmh: 3, historySpanSec: 580 }), atHome)).toBeNull();
	});

	it("returns null without an explicit long-stay context (conservative default)", () => {
		// Callers that don't pass the location context get the safe
		// "don't demote anywhere" behaviour.
		expect(demoteAfterStop(signals({ effectiveSpeedKmh: 0.5, historySpanSec: 580 }))).toBeNull();
	});

	// Realistic scenario: phone is in Move mode, sitting at home, and
	// over time the proxy accumulates a full HISTORY_MAX_AGE_SEC of
	// effectively-zero-speed fixes. The cascade should demote back to
	// Significant. This is the spec-level behaviour the user asked
	// about: "after a few minutes, we should get out of Move again."
	//
	// Implementation gotcha: the history is BOUNDED by
	// HISTORY_MAX_AGE_SEC=600 via pruneFixHistory, so any threshold
	// MIN_STATIONARY_DEMOTE_SEC >= 600 is unreachable in practice.
	// Tests below construct a realistic pruned history that achieves
	// the maximum possible span (slightly under 600s) and assert
	// demotion fires.
	describe("realistic pruned-history scenarios", () => {
		// Build 60 stationary fixes spaced 10s apart, then prune as
		// the route would on every POST. Mirrors steady-state Move
		// mode at home.
		function makeStationaryHistory(): FixRecord[] {
			const fixes: FixRecord[] = [];
			const baseTs = 1_700_000_000;
			for (let i = 0; i < 60; i++) {
				fixes.push({ ts: baseTs + i * 10, lat: 51.5, lon: -0.1, vel: 0 });
			}
			// nowSec = ts of the latest fix. Pruning keeps fixes
			// whose ts >= nowSec - HISTORY_MAX_AGE_SEC.
			const nowSec = fixes[fixes.length - 1].ts;
			return pruneFixHistory(fixes, 600, nowSec);
		}

		it("demotes after ~10 minutes of stationary fixes at home", () => {
			const history = makeStationaryHistory();
			const sigs = computeSignals(history);
			// Sanity check the test setup itself: history span should
			// be close to (but bounded by) the 600s pruning window.
			expect(sigs.historySpanSec).toBeGreaterThan(540);
			expect(sigs.historySpanSec).toBeLessThanOrEqual(600);
			expect(sigs.effectiveSpeedKmh).toBeLessThan(2);
			// The predicate-level assertion. Fails on current code
			// because MIN_STATIONARY_DEMOTE_SEC = HISTORY_MAX_AGE_SEC
			// makes the threshold unreachable.
			expect(demoteAfterStop(sigs, atHome)).toBe("stationary");
		});

		it("end-to-end cascade: Move→Significant fires for the steady-at-home case", () => {
			const history = makeStationaryHistory();
			const sigs = computeSignals(history);
			// Phone is in Move mode (monitoringMode: 2) and previously
			// the proxy decided 'transit'. With sustained slow speed
			// at home, decideTransition should drop to 'stationary'.
			expect(decideTransition({ ...sigs, monitoringMode: 2 }, "transit", atHome)).toBe("stationary");
		});
	});
});

describe("decideTransition (cascade)", () => {
	// Top-level predicate ordering: high-speed escalation > Significant
	// escalation > Move refinement > demote.

	it("high speed wins even from Move state", () => {
		const s = signals({ reportedVelKmh: 100, monitoringMode: 2, historySpanSec: 700 });
		expect(decideTransition(s, "walking")).toBe("transit-fast");
	});

	it("Significant escalation runs only when monitoringMode = 1 (or unknown + last was stationary)", () => {
		const s = signals({ gapSinceLastFixSec: 120, monitoringMode: 1 });
		expect(decideTransition(s, "stationary")).toBe("transit");

		// Same signal but phone is in Move — escalation skipped, refinement
		// path takes over (no history → keep).
		const s2 = signals({ gapSinceLastFixSec: 120, monitoringMode: 2 });
		expect(decideTransition(s2, "transit")).toBe("keep");
	});

	it("trusts the m field over prevProfile", () => {
		// prevProfile says "walking" (Move) but phone reports m=1 (Significant)
		// — phone is authoritative. Significant path applies.
		const s = signals({ monitoringMode: 1, gapSinceLastFixSec: 120 });
		expect(decideTransition(s, "walking")).toBe("transit");
	});

	it("returns 'keep' when no predicate fires", () => {
		expect(decideTransition(signals(), null)).toBe("keep");
	});
});

describe("decideRemoteConfig (always-push)", () => {
	// The proxy pushes a config command on every fix. There is no
	// anti-flap window and no "did this change from last time" dedup —
	// what would have been a "no-op" instead resolves to the
	// current/last-decided profile's config and goes out anyway. The
	// phone applies it idempotently.

	const walkingHistory: FixRecord[] = [
		{ ts: 0, lat: 0, lon: 0 },
		{ ts: 90, lat: 0.0009, lon: 0 },
		{ ts: 180, lat: 0.0018, lon: 0 },
		{ ts: 270, lat: 0.0027, lon: 0 },
	];

	it("pushes the new profile's config when history says walking", () => {
		const r = decideRemoteConfig(0, "transit", walkingHistory);
		expect(r.profile).toBe("walking");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 30 });
	});

	it("pushes transit-fast config on a high-speed escalation", () => {
		const trainHistory: FixRecord[] = [...walkingHistory, { ts: 300, lat: 0.0036, lon: 0, vel: 120 }];
		const r = decideRemoteConfig(0, "walking", trainHistory);
		expect(r.profile).toBe("transit-fast");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 10 });
	});

	it("preserves and re-pushes lastProfile when the cascade says 'keep'", () => {
		// History too thin to decide; lastProfile is transit. The proxy
		// still has to send something — and it sends transit's config so
		// the phone's mode is reaffirmed.
		const r = decideRemoteConfig(0, "transit", [{ ts: 0, lat: 0, lon: 0 }]);
		expect(r.profile).toBe("transit");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 15 });
	});

	it("first-ever fix with null lastProfile resolves to stationary (factory default)", () => {
		const r = decideRemoteConfig(0, null, []);
		expect(r.profile).toBe("stationary");
		expect(r.patch).toEqual({ monitoring: 1 });
	});
});

describe("decideRemoteConfig from Significant mode (office-walk case)", () => {
	// The "walking from Significant" gap we identified — phone in
	// Significant mode, user starts walking, motion sensor fires extra
	// fixes. Should escalate from a single fast-gap signal.

	it("escalates on first closely-spaced Significant fix (too thin to refine)", () => {
		// Phone in Significant; new fix arrives 1 min later (much faster
		// than the 15-min scheduled cadence). History span < 2 min so we
		// can't yet refine to walking — fall back to generic transit so
		// the phone enters Move mode and subsequent fixes can refine.
		const history: FixRecord[] = [
			{ ts: 0, lat: 51.5, lon: -0.1, monitoringMode: 1 },
			{ ts: 60, lat: 51.501, lon: -0.1, monitoringMode: 1 }, // 110m in 1 min
		];
		const r = decideRemoteConfig(0, "stationary", history);
		expect(r.profile).toBe("transit");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 15 });
	});

	it("does not escalate on a scheduled-cadence Significant fix that didn't move", () => {
		// 15-min scheduled tick, same location → not motion. Stay
		// stationary; re-push the Significant config.
		const history: FixRecord[] = [
			{ ts: 0, lat: 51.5, lon: -0.1, monitoringMode: 1 },
			{ ts: 900, lat: 51.5, lon: -0.1, monitoringMode: 1 },
		];
		const r = decideRemoteConfig(0, "stationary", history);
		expect(r.profile).toBe("stationary");
		expect(r.patch).toEqual({ monitoring: 1 });
	});

	it("treats trigger='u' (user action) as motion intent from Significant", () => {
		const history: FixRecord[] = [
			{ ts: 0, lat: 51.5, lon: -0.1, monitoringMode: 1 },
			{ ts: 900, lat: 51.5, lon: -0.1, monitoringMode: 1, trigger: "u" },
		];
		const r = decideRemoteConfig(0, "stationary", history);
		expect(r.profile).toBe("transit");
	});
});

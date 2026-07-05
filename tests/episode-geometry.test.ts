import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { type CapturedDay, inputsFromFixture, parseCapturedDay } from "../src/cli/fixture-day.js";
import { buildEpisodes, type RawFix } from "../src/geo/episode-geometry.js";
import type { FilteredPoint } from "../src/geo/kalman.js";
import { pathLength } from "../src/geo/map-match-core.js";
import { computeVelocityFromInputs, type EnrichedSegment, type VelocityResult } from "../src/geo/velocity.js";
import type { DayState, DayStateMode } from "../src/sleep/day-state.js";
import { describeWithFixture } from "./helpers/describe-with-fixture.js";

// Minimal factories — buildEpisodes reads only a handful of fields, so we
// construct partial objects and cast. Keeping them minimal documents
// exactly what the geometry layer depends on.
function fix(ts: number, lat: number, lon: number, speed_kmh: number): FilteredPoint {
	return { ts, lat, lon, speed_kmh, bearing: 0 };
}
function raw(ts: number, lat: number, lon: number, accuracy = 25): RawFix {
	return { ts, lat, lon, accuracy };
}
function state(startTs: number, endTs: number, mode: DayStateMode): DayState {
	return { startTs, endTs, mode };
}
function seg(partial: Partial<EnrichedSegment> & { startTs: number; endTs: number; mode: string }): EnrichedSegment {
	return partial as EnrichedSegment;
}

describe("buildEpisodes — per-mode speed-plausibility filter", () => {
	it("drops walking fixes above the 12 km/h ceiling, keeps the slow walk", () => {
		const fixes = [
			fix(1000, 51.5, -0.27, 60), // train bleed — drop
			fix(1020, 51.51, -0.275, 55), // train bleed — drop
			fix(1040, 51.0, -0.1, 8), // genuine walk — keep
			fix(1060, 51.001, -0.1, 4),
			fix(1080, 51.002, -0.1, 3),
		];
		const [ep] = buildEpisodes([state(1000, 1100, "walking")], [], fixes);
		expect(ep.kind).toBe("raw");
		expect(ep.points).toHaveLength(3);
		// None of the dropped fast fixes survive.
		expect(ep.points.some((p) => p.lat === 51.5 || p.lat === 51.51)).toBe(false);
		expect(ep.points.every((p) => p.lat >= 51.0 && p.lat < 51.01)).toBe(true);
	});

	it("uses the cycling ceiling (35), not the walking one", () => {
		const fixes = [fix(0, 51, -0.1, 50), fix(20, 51.001, -0.1, 30), fix(40, 51.002, -0.1, 28)];
		const [ep] = buildEpisodes([state(0, 100, "cycling")], [], fixes);
		expect(ep.points.some((p) => p.lat === 51)).toBe(false); // 50 km/h dropped
		expect(ep.points).toHaveLength(2); // the two ≤35 kept
	});

	it("never filters a vehicle mode — a 90 km/h drive is kept", () => {
		const fixes = [fix(0, 51, -0.1, 90), fix(20, 51.01, -0.1, 95), fix(40, 51.02, -0.1, 88)];
		const [ep] = buildEpisodes([state(0, 100, "driving")], [], fixes);
		expect(ep.kind).toBe("raw");
		expect(ep.points).toHaveLength(3); // none dropped
	});

	// The RAW-fixes fallback (rawFixes present) is what draws a walk when the
	// matcher bails. Its fixes carry no `speed_kmh`, so the km/h ceiling above —
	// which reads `speed_kmh` off the Kalman points — never applied here, and an
	// underground teleport run (good self-reported accuracy, 28–54 km/h) was drawn
	// as a real walk (2026-06-16 15:48). The kinematic HOLD collapses it.
	it("holds an underground teleport run in the raw-fixes walk fallback", () => {
		// Slow real cluster near Deepwell, then jumps west — each > 12 km/h from the
		// last kept fix, all reporting good accuracy (the phone lies underground).
		const rawFixes = [
			raw(0, 51.53, -0.124, 26),
			raw(30, 51.53, -0.124, 23),
			raw(60, 51.5298, -0.1242, 28), // ~25 m, ~3 km/h — kept
			raw(240, 51.5239, -0.1434, 30), // +1490 m / 180 s ≈ 30 km/h — hold
			raw(320, 51.5226, -0.1563, 28), // further jump — hold
			raw(600, 51.5363, -0.176, 27), // further jump — hold
		];
		const [ep] = buildEpisodes([state(0, 700, "walking")], [], [], rawFixes);
		expect(ep.kind).toBe("raw");
		// Only the slow start cluster survives; no teleport vertex is drawn.
		expect(ep.points).toHaveLength(3);
		expect(ep.points.every((p) => p.lon > -0.125)).toBe(true);
	});

	it("drops a LEADING straggler and keeps the real cluster (today's Carfax green-jump)", () => {
		// First fix is a stray underground tube-tail fix at Carfax; the rest are
		// the real walk at Deepwell (~1.4 km east). The hold must not anchor on the
		// straggler and hold away every good fix — it must drop the straggler.
		const rawFixes = [
			raw(0, 51.5235, -0.1573, 26), // Carfax straggler
			raw(103, 51.525, -0.1369, 19), // real walk at Deepwell (+1.4 km = 49 km/h)
			raw(118, 51.5248, -0.1371, 17),
			raw(178, 51.5247, -0.1374, 7),
			raw(300, 51.5247, -0.1374, 13),
		];
		const [ep] = buildEpisodes([state(0, 700, "walking")], [], [], rawFixes);
		expect(ep.kind).toBe("raw");
		expect(ep.points.length).toBeGreaterThanOrEqual(2);
		expect(ep.points.every((p) => p.lon > -0.14)).toBe(true); // no Carfax point drawn
	});

	it("keeps a genuine brisk walk with mild GPS jitter in the raw-fixes fallback", () => {
		// ~6 km/h walk (each ~50 m / 30 s) with one 14 km/h jitter step — the run
		// stays; only the lone spike beyond ceiling is held, not the whole walk.
		const rawFixes = [
			raw(0, 51.5, -0.1),
			raw(30, 51.50045, -0.1), // ~50 m, 6 km/h
			raw(60, 51.5009, -0.1),
			raw(90, 51.50155, -0.1), // ~72 m, ~8.7 km/h — still under 12
			raw(120, 51.5014, -0.1),
		];
		const [ep] = buildEpisodes([state(0, 200, "walking")], [], [], rawFixes);
		expect(ep.points.length).toBeGreaterThanOrEqual(4);
	});
});

describe("buildEpisodes — per-mode geometry resolution", () => {
	it("draws a cached train as snapped, clipped to the state window", () => {
		const segs = [
			seg({
				startTs: 0,
				endTs: 100,
				mode: "train",
				snappedPath: [
					{ ts: 0, lat: 51.0, lon: -0.1 },
					{ ts: 50, lat: 51.05, lon: -0.15 },
					{ ts: 100, lat: 51.1, lon: -0.2 },
				],
			}),
		];
		const [ep] = buildEpisodes([state(0, 100, "train")], segs, []);
		expect(ep.kind).toBe("snapped");
		expect(ep.points).toHaveLength(3);
		expect(ep.points[0]).toEqual({ lat: 51.0, lon: -0.1, ts: 0 });
	});

	it("draws an uncached train raw from its own fixes (no speed filter)", () => {
		const segs = [seg({ startTs: 0, endTs: 100, mode: "train" })];
		const fixes = [fix(0, 51, -0.1, 90), fix(50, 51.05, -0.15, 95), fix(100, 51.1, -0.2, 80)];
		const [ep] = buildEpisodes([state(0, 100, "train")], segs, fixes);
		expect(ep.kind).toBe("raw");
		expect(ep.points).toHaveLength(3); // fast train fixes kept — train has no ceiling
	});

	it("draws a reconstructed underground leg as a station-to-station connector, not its teleport garbage", () => {
		// pointCount 0 = an underground leg synthesised with no real GPS. Its
		// window holds only teleporting cell-network garbage; drawing that would
		// leave the leg near the boarding end and let the next walk bridge green
		// across the gap. Instead it must connect boarding → alighting.
		const segs = [seg({ startTs: 100, endTs: 300, mode: "train", pointCount: 0 })];
		const fixes = [
			fix(50, 51.523, -0.157, 4), // boarding walk @ Carfax
			fix(150, 51.515, -0.149, 200), // teleport garbage mid-tube (Bond St jump)
			fix(200, 51.523, -0.157, 0), // garbage snapped back to Carfax
			fix(350, 51.507, -0.143, 4), // alighting walk @ Farvale
		];
		const states = [state(0, 100, "walking"), state(100, 300, "train"), state(300, 400, "walking")];
		const train = buildEpisodes(states, segs, fixes)[1];
		expect(train.kind).toBe("tentative");
		expect(train.points).toHaveLength(2);
		expect(train.points[0].lat).toBeCloseTo(51.523, 2); // boards Carfax
		expect(train.points[1].lat).toBeCloseTo(51.507, 2); // alights Farvale
	});

	it("anchors a raw train leg to its station join points so a neighbour walk does not bridge green", () => {
		// Real Met-leg shape: the train's GPS starts well after boarding and
		// stops well before alighting, so without stitching the next walk would
		// bridge green across the missing tail. The surrounding walks supply the
		// station ends (Ashvale boarding, Carfax alighting).
		const segs = [seg({ startTs: 100, endTs: 300, mode: "train", pointCount: 1 })];
		const fixes = [
			fix(50, 51.563, -0.279, 4), // boarding walk @ Ashvale
			fix(200, 51.545, -0.21, 80), // one mid-route train fix
			fix(350, 51.523, -0.157, 4), // alighting walk @ Carfax
		];
		const states = [state(0, 100, "walking"), state(100, 300, "train"), state(300, 400, "walking")];
		const train = buildEpisodes(states, segs, fixes)[1];
		expect(train.kind).toBe("raw");
		expect(train.points).toHaveLength(3); // boarding + the fix + alighting
		expect(train.points[0].lat).toBeCloseTo(51.563, 2); // stitched to Ashvale
		expect(train.points.at(-1)?.lat).toBeCloseTo(51.523, 2); // stitched to Carfax
	});

	it("collapses a stay to a single anchor at the segment centroid", () => {
		const segs = [seg({ startTs: 0, endTs: 100, mode: "stationary", centroidLat: 51.5, centroidLon: -0.12 })];
		const [ep] = buildEpisodes([state(0, 100, "stationary")], segs, [fix(10, 51.6, -0.2, 0)]);
		expect(ep.kind).toBe("anchor");
		expect(ep.points).toEqual([{ lat: 51.5, lon: -0.12 }]); // centroid wins over the fix
	});

	it("emits an empty episode for a synthesized pre-fix sleep (no segment, no fixes)", () => {
		const [ep] = buildEpisodes([state(0, 100, "sleeping")], [], []);
		expect(ep.kind).toBe("anchor");
		expect(ep.points).toHaveLength(0);
	});

	it("bridges a short unknown gap, but not a cross-city one", () => {
		const a = seg({ startTs: 0, endTs: 100, mode: "stationary", centroidLat: 51.5, centroidLon: -0.12 });
		const near = seg({ startTs: 200, endTs: 300, mode: "stationary", centroidLat: 51.505, centroidLon: -0.12 });
		const states = [state(0, 100, "stationary"), state(100, 200, "unknown"), state(200, 300, "stationary")];
		const [, gap] = buildEpisodes(states, [a, near], []);
		expect(gap.kind).toBe("tentative");
		expect(gap.points).toHaveLength(2); // ~560 m apart, under the 2 km cap

		const far = seg({ startTs: 200, endTs: 300, mode: "stationary", centroidLat: 51.6, centroidLon: -0.12 });
		const [, gap2] = buildEpisodes(states, [a, far], []);
		expect(gap2.points).toHaveLength(0); // ~11 km apart, over the cap → draw nothing
	});

	it("rejects a teleport spike from a raw moving episode", () => {
		const fixes = [
			fix(0, 51.0, -0.1, 5),
			fix(20, 60.0, 10.0, 5), // teleport spike
			fix(40, 51.0005, -0.1, 5),
		];
		const [ep] = buildEpisodes([state(0, 100, "walking")], [], fixes);
		expect(ep.points.some((p) => p.lat === 60)).toBe(false);
	});
});

// Real-data grounding (gitignored fixture; skipped in CI). A captured
// day in which a train's overground deceleration into its alighting
// station is mis-segmented into the following walking episode — the
// walk's leading fixes carry vehicle speed (≫12 km/h). The speed filter
// drops them; the genuine slow walk survives. Cache-independent: the
// filter never consults snappedPath.
function loadCaptured(): CapturedDay | null {
	try {
		return parseCapturedDay(readFileSync("tests/golden/days/2026-06-09-pippijn.json", "utf8"));
	} catch {
		return null;
	}
}

describeWithFixture("buildEpisodes — train-tail bleed into a walk (real data)", loadCaptured(), (captured) => {
	let result: VelocityResult;
	let inputs: ReturnType<typeof inputsFromFixture>;

	beforeAll(async () => {
		inputs = inputsFromFixture(captured);
		result = await computeVelocityFromInputs(inputs);
	}, 30_000); // full-day fixture replay (walkMatch et al.) runs 3-8s; 10s is flaky under load

	function speedOf(p: { lat: number; lon: number }): number | undefined {
		return result.points.find((f) => f.lat === p.lat && f.lon === p.lon)?.speed_kmh;
	}

	it("draws no walking/cycling point above its mode's ceiling", () => {
		const caps: Record<string, number> = { walking: 12, cycling: 35 };
		for (const ep of buildEpisodes(result.states, result.segments, result.points)) {
			const cap = caps[ep.mode];
			if (cap === undefined) continue;
			for (const p of ep.points) {
				const s = speedOf(p);
				if (s !== undefined) expect(s).toBeLessThanOrEqual(cap);
			}
		}
	});

	it("removes a walking episode's vehicle-speed lead-in fixes but keeps the slow walk", () => {
		const episodes = buildEpisodes(result.states, result.segments, result.points);
		// The affected walk: a walking episode whose raw window holds
		// vehicle-speed fixes (>40 km/h) — a faster mode bled across the
		// boundary.
		const windowFixes = (e: { startTs: number; endTs: number }) =>
			result.points.filter((f) => f.ts >= e.startTs && f.ts <= e.endTs);
		const walk = episodes.find((e) => e.mode === "walking" && windowFixes(e).some((f) => f.speed_kmh > 40));
		expect(walk, "expected a walking episode with bled-in fast fixes").toBeDefined();
		if (!walk) return;

		const win = windowFixes(walk);
		expect(win.some((f) => f.speed_kmh > 40)).toBe(true); // the bleed is in the raw data…
		expect(walk.points.length).toBeGreaterThan(0); // …but the genuine slow walk survives…
		// …and the bleed is NOT drawn, whichever arm drew the line (the raw
		// fallback filters fast fixes; the matcher/corrector never routes the
		// vehicle leg): the drawn line's implied speed must be walk-plausible,
		// not the 40+ km/h the bled fixes would force.
		const lenM = pathLength(walk.points);
		const drawnKmh = (3.6 * lenM) / Math.max(1, walk.endTs - walk.startTs);
		expect(drawnKmh).toBeLessThanOrEqual(12);
		// Every drawn point that coincides with a source fix is plausibly walking.
		for (const p of walk.points) {
			const s = speedOf(p);
			if (s !== undefined) expect(s).toBeLessThanOrEqual(12);
		}
	});

	it("is identical with the rail-route cache emptied (no snappedPath dependence)", async () => {
		const withCache = buildEpisodes(result.states, result.segments, result.points).filter((e) => e.mode === "walking");
		const noCacheResult = await computeVelocityFromInputs({ ...inputs, railRouteCache: [] });
		const withoutCache = buildEpisodes(noCacheResult.states, noCacheResult.segments, noCacheResult.points).filter(
			(e) => e.mode === "walking",
		);
		expect(withoutCache).toEqual(withCache);
	});
});

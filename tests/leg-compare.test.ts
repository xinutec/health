/**
 * The float↔quant leg classifier shared by the `compare-match` gate and the
 * production matcher ledger (#396).
 *
 * The classifier used to return `DIFF` the instant the two arms' vertex counts
 * differed, without ever asking how far apart the LINES were. That collapsed
 * two things a reader has to tell apart:
 *
 *   - leg 5acb9ecb0d6ea26f — two polylines 0.01 m apart, one arm carrying a
 *     redundant collinear vertex. Same route, same drawn pixels.
 *   - leg 71e5544efa614a06 — a 120 m corridor change that flipped
 *     `matchImprovesDisplay` from use=true to use=false and made production
 *     draw raw GPS instead of a matched line (#398).
 *
 * Both read `DIFF`. So the manifest recorded both under one label and the
 * ledger could not say which kind of divergence had just been served. These
 * pin the graded behaviour: a length mismatch is judged on DISTANCE between the
 * lines, and only a line that actually moves is a `DIFF`.
 */

import { describe, expect, it } from "vitest";
import { legClasses } from "../src/geo/leg-compare.js";
import { type QPt, quantPt } from "../src/geo/quant-twin.js";

/** A float-arm vertex. Latitudes near London so the cos(lat) scaling is real. */
const p = (lat: number, lon: number, ts = 1000): { lat: number; lon: number; ts: number } => ({ lat, lon, ts });
/** The same point as the quant arm sees it. */
const q = (lat: number, lon: number, ts = 1000): QPt => quantPt({ lat, lon, ts });

/** Metres → degrees of latitude, for building a deviation of a known size. */
const mLat = (m: number): number => m / 111_320;

const arm = (pts: ReadonlyArray<{ lat: number; lon: number; ts: number }>) => ({ coarsePath: pts, path: pts });
const qArm = (pts: readonly QPt[]) => ({ coarsePath: pts, path: pts });

describe("legClasses", () => {
	it("calls bit-identical arms EXACT", () => {
		const f = [p(51.53, -0.125), p(51.531, -0.126)];
		expect(legClasses(arm(f), qArm(f.map(quantPt)))).toEqual({ coarse: "EXACT", path: "EXACT" });
	});

	it("calls a sub-tolerance per-vertex wobble NEAR at equal vertex counts", () => {
		const f = [p(51.53, -0.125), p(51.531, -0.126)];
		// Move one vertex by ~22 cm — inside the 30-unit (~33 cm) bar.
		const shifted = [q(51.53, -0.125), q(51.531 + mLat(0.22), -0.126)];
		expect(legClasses(arm(f), qArm(shifted)).coarse).toBe("NEAR");
	});

	it("calls a beyond-tolerance vertex DIFF at equal vertex counts", () => {
		const f = [p(51.53, -0.125), p(51.531, -0.126)];
		// 120 m — the King's Cross case (#398). Equal counts, real route change.
		const moved = [q(51.53, -0.125), q(51.531 + mLat(120), -0.126)];
		expect(legClasses(arm(f), qArm(moved)).coarse).toBe("DIFF");
	});

	// THE #396 CASE. A redundant collinear vertex is a different SAMPLING of the
	// same line, not a different line. Judged structurally it read DIFF; judged
	// on distance it is what it is — the same route.
	it("calls a redundant collinear vertex NEAR, not DIFF", () => {
		const f = [p(51.53, -0.125), p(51.532, -0.125)];
		// Quant carries a midpoint the float arm simplified away. Same line.
		const withExtra = [q(51.53, -0.125), q(51.531, -0.125), q(51.532, -0.125)];
		expect(legClasses(arm(f), qArm(withExtra)).path).toBe("NEAR");
	});

	// The guard on the above: a vertex count that differs AND a line that moves
	// must stay DIFF. Otherwise #396 would have quietly downgraded the very
	// divergence class it exists to expose.
	it("keeps a length mismatch DIFF when the line actually moves", () => {
		const f = [p(51.53, -0.125), p(51.532, -0.125)];
		// An inserted vertex 40 m off the chord — a detour, not a resampling.
		const detour = [
			q(51.53, -0.125),
			q(51.531, -0.125 + mLat(40) / Math.cos((51.531 * Math.PI) / 180)),
			q(51.532, -0.125),
		];
		expect(legClasses(arm(f), qArm(detour)).path).toBe("DIFF");
	});

	// Deviation is measured BOTH ways. A short line lying on top of a long one
	// is close in one direction only; taking the min would call a truncated arm
	// identical to a complete one.
	it("is symmetric — a truncated arm is DIFF even though its vertices sit on the other line", () => {
		const f = [p(51.53, -0.125), p(51.531, -0.125), p(51.532, -0.125)];
		// Quant stops a third of the way along. Every quant vertex lies exactly
		// on the float line, so the one-way deviation quant→float is 0.
		const truncated = [q(51.53, -0.125), q(51.5303, -0.125)];
		expect(legClasses(arm(f), qArm(truncated)).path).toBe("DIFF");
	});

	// THE #400 CASE. Equal vertex counts used to be graded per-COORDINATE, so a
	// vertex that slid ALONG an otherwise identical line read DIFF while the line
	// itself had barely moved. Measured on leg 64c24f8ad38e6fbf (2026-05-15
	// 20:47): one vertex 78.7 cm from its counterpart, the two coarse polylines
	// 0.04 m apart, display path bit-identical.
	//
	// The class must answer the question the manifest says it answers — "did the
	// line move?" — and must not depend on whether the two arms happened to emit
	// the same number of vertices, which is what decided it before.
	it("grades a slid-along-the-line vertex by how far the LINE moved, not the vertex", () => {
		const f = [p(51.53, -0.125), p(51.531, -0.125), p(51.532, -0.125)];
		// Middle vertex pushed 0.8 m NORTH — along the straight N-S line. Well over
		// the 33 cm per-coordinate bar, but it stays on the same drawn line.
		const slid = [q(51.53, -0.125), q(51.531 + mLat(0.8), -0.125), q(51.532, -0.125)];
		expect(legClasses(arm(f), qArm(slid)).coarse).toBe("NEAR");
	});

	// The guard on the above, and the reason this is not "making the alert
	// quieter": the SAME 0.8 m, moved ACROSS the line instead of along it, is a
	// line that actually moved and stays DIFF.
	it("keeps an equal-count vertex that moved AWAY from the line DIFF", () => {
		const f = [p(51.53, -0.125), p(51.531, -0.125), p(51.532, -0.125)];
		const across = [
			q(51.53, -0.125),
			q(51.531, -0.125 + mLat(0.8) / Math.cos((51.531 * Math.PI) / 180)),
			q(51.532, -0.125),
		];
		expect(legClasses(arm(f), qArm(across)).coarse).toBe("DIFF");
	});

	// Equal counts give a vertex CORRESPONDENCE, so unlike the length-mismatch
	// branch this one can compare timestamps — and still must. Grading the
	// spatial verdict by polyline deviation must not quietly drop the `ts` check
	// along with the per-coordinate one.
	it("still fails a timestamp shift even when the geometry is identical", () => {
		const f = [p(51.53, -0.125, 1000), p(51.531, -0.125, 1060)];
		const shifted = [q(51.53, -0.125, 1000), q(51.531, -0.125, 1062)];
		expect(legClasses(arm(f), qArm(shifted)).coarse).toBe("DIFF");
	});

	it("tolerates a one-second timestamp difference, as before", () => {
		const f = [p(51.53, -0.125, 1000), p(51.531, -0.125, 1060)];
		const off = [q(51.53, -0.125, 1000), q(51.531, -0.125, 1061)];
		expect(legClasses(arm(f), qArm(off)).coarse).toBe("NEAR");
	});

	it("treats one arm matching and the other null as DIFF", () => {
		const f = [p(51.53, -0.125)];
		expect(legClasses(arm(f), null)).toEqual({ coarse: "DIFF", path: "DIFF" });
		expect(legClasses(null, null)).toEqual({ coarse: "EXACT", path: "EXACT" });
	});

	// coarse is the decision layer, path the display splice (#369). A leg can
	// diverge on one and not the other, and the manifest keys on both.
	it("grades coarse and path independently", () => {
		const same = [p(51.53, -0.125), p(51.531, -0.126)];
		const moved = [p(51.53, -0.125), p(51.531 + mLat(120), -0.126)];
		const cls = legClasses(
			{ coarsePath: same, path: moved },
			{ coarsePath: same.map(quantPt), path: same.map(quantPt) },
		);
		expect(cls).toEqual({ coarse: "EXACT", path: "DIFF" });
	});
});

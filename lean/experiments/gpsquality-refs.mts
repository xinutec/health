#!/usr/bin/env -S npx tsx
/**
 * Derive `#guard` expectations for `Verified.Geo.GpsQuality` from V8.
 *
 * `GpsQuality.lean` shipped with two guards for a filter with five thresholds
 * and three branch paths (#388 flagged this: the corpus shadow was doing the
 * verification, not the in-build pinning). The corpus is real but it only
 * covers the branches real days happen to take — a null accuracy, a duplicate
 * timestamp, or a bridge scan that runs past its 30-minute horizon may never
 * appear in 32 days of London, and a port could get any of them wrong while
 * staying 32/32 green.
 *
 * So this constructs one minimal track per uncovered branch and prints the
 * kept-set that the REAL `src/geo/gps-quality.ts` produces under Node. The
 * printed lines are pasted into `GpsQuality.lean` verbatim. The point is that
 * no expectation in that file is a number I reasoned my way to: each one is
 * what V8 actually did, which is the only thing the Lean port is obliged to
 * match.
 *
 * Re-run after any change to the TS filter — a guard that disagrees with this
 * output means the port and the original have diverged, which is the whole
 * question.
 *
 * Run: npx tsx lean/experiments/gpsquality-refs.mts
 */
import { qualityFilterGps } from "../../src/geo/gps-quality.js";

interface GpsPoint {
	ts: number;
	lat: number;
	lon: number;
	accuracy: number | null;
}

const gp = (ts: number, lat: number, lon: number, accuracy: number | null): GpsPoint => ({
	ts,
	lat,
	lon,
	accuracy,
});

/** A branch of the filter, the track that reaches it, and why it matters. */
interface Case {
	/** Lean-side name, used for the guard comment. */
	name: string;
	/** The branch this track is here to reach. */
	branch: string;
	track: GpsPoint[];
}

const cases: Case[] = [
	{
		name: "nullAccuracy",
		branch: "inaccurateMotion → none ⇒ false; trustworthy → none ⇒ true",
		// No fix carries an accuracy, so the poor-accuracy path is unreachable
		// and only the speed ceiling can condemn anything. The t=20 teleport
		// must still be dropped, and the bridge (t=30) must be trusted despite
		// having no accuracy to judge it by.
		track: [
			gp(0, 51.5, -0.1, null),
			gp(10, 51.501, -0.1, null),
			gp(20, 51.6, -0.1, null),
			gp(30, 51.502, -0.1, null),
			gp(40, 51.503, -0.1, null),
		],
	},
	{
		name: "duplicateTs",
		branch: "impliedSpeedKmh → dt ≤ 0 ⇒ 0 (treated reachable)",
		// Two fixes share a timestamp, and a later pair goes backwards in time.
		// Both give dt ≤ 0, where a naive port divides by zero and gets Infinity
		// — which reads as unreachable and would drop a fix that must be kept.
		track: [
			gp(0, 51.5, -0.1, 20),
			gp(0, 51.6, -0.1, 20),
			gp(10, 51.501, -0.1, 20),
			gp(5, 51.7, -0.1, 20),
			gp(20, 51.502, -0.1, 20),
		],
	},
	{
		name: "bridgeHorizon",
		branch: "findBridge → none (past BRIDGE_WINDOW_S) ⇒ keep the candidate",
		// The garbage fix at t=100 has no surfacing fix within 1800 s: the next
		// good fix is at t=2000. The scan must give up at the horizon and KEEP
		// the candidate rather than search on and bridge to it.
		track: [
			gp(0, 51.5, -0.1, 20),
			gp(10, 51.501, -0.1, 20),
			gp(100, 51.52, -0.1, 100),
			gp(2000, 51.53, -0.1, 20),
			gp(2010, 51.531, -0.1, 20),
		],
	},
	{
		name: "incoherentSuccessor",
		branch: "findBridge → coherentSuccessor false ⇒ skip this candidate",
		// t=60 is itself reachable and trustworthy, so it looks like a bridge —
		// but its own successor at t=70 is a teleport, so it is the head of
		// another garbage run and must be skipped in favour of a later one.
		track: [
			gp(0, 51.5, -0.1, 20),
			gp(10, 51.501, -0.1, 20),
			gp(20, 51.7, -0.1, 100),
			gp(60, 51.502, -0.1, 20),
			gp(70, 51.9, -0.1, 20),
			gp(120, 51.503, -0.1, 20),
			gp(130, 51.504, -0.1, 20),
		],
	},
	{
		name: "unreachableNotTravelled",
		branch: "walk → speedUnreachable ∨ travelled: the LEFT disjunct alone",
		// A teleport that returns: net displacement across the run is far under
		// MIN_TRANSIT_DISPLACEMENT_M, so `travelled` is false. The run must
		// still be bridged, on speedUnreachable alone. A port that tested only
		// displacement would keep the teleport.
		track: [
			gp(0, 51.5, -0.1, 20),
			gp(10, 51.5005, -0.1, 20),
			gp(20, 51.9, -0.1, 20),
			gp(30, 51.501, -0.1, 20),
			gp(40, 51.5015, -0.1, 20),
		],
	},
	{
		name: "accuracyAtCeiling",
		branch: "ACCURACY_CEILING_M boundary: 80 is trustworthy, 80.001 is not",
		// Straddles the accuracy threshold at speed. `>` vs `>=` is the classic
		// port slip and no real day is guaranteed to land on it.
		track: [
			gp(0, 51.5, -0.1, 20),
			gp(10, 51.501, -0.1, 20),
			gp(100, 51.52, -0.1, 80),
			gp(160, 51.53, -0.1, 20),
			gp(170, 51.531, -0.1, 20),
		],
	},
	{
		name: "accuracyOverCeiling",
		branch: "ACCURACY_CEILING_M boundary: the same track one thousandth over",
		// Identical to accuracyAtCeiling but for 80 → 80.001. If these two
		// cases produce the same kept-set, the boundary is not where the
		// comment says it is.
		track: [
			gp(0, 51.5, -0.1, 20),
			gp(10, 51.501, -0.1, 20),
			gp(100, 51.52, -0.1, 80.001),
			gp(160, 51.53, -0.1, 20),
			gp(170, 51.531, -0.1, 20),
		],
	},
];

const lit = (p: GpsPoint): string =>
	p.accuracy === null
		? `gpn ${p.ts} ${p.lat} (${p.lon})`
		: `gp ${p.ts} ${p.lat} (${p.lon}) ${p.accuracy}`;

for (const c of cases) {
	const kept = qualityFilterGps(structuredClone(c.track)) as GpsPoint[];
	const keptTs = kept.map((p) => p.ts);
	console.log(`-- ${c.branch}`);
	console.log(`private def ${c.name} : Array GpsPoint := #[`);
	console.log(`  ${c.track.map(lit).join(", ")}]`);
	console.log(`#guard (qualityFilterGps ${c.name}).map (·.ts) == #[${keptTs.join(", ")}]`);
	console.log();
}

// A branch that no track can reach through the public entry point is worth
// saying out loud rather than leaving as a silent gap.
console.log(`-- ${cases.length} branch cases above; expectations produced by src/geo/gps-quality.ts under Node ${process.version}`);

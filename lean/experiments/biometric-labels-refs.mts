#!/usr/bin/env -S npx tsx
/**
 * Derive `#guard` expectations for `Verified.Geo.BiometricLabels` from V8.
 *
 * The four label-rewrite passes are a decision over a small discrete set, so
 * the Lean port can be pinned EXACTLY rather than to a tolerance — but only
 * against what the original actually does. A guard I reasoned my way to proves
 * the port is self-consistent, which is not the question. So this imports the
 * REAL `src/geo/biometrics.ts`, runs the same fixtures the Lean file uses, and
 * prints the decisions Node produced. Those lines go into the Lean verbatim.
 *
 * It matters most for the branch guards. The corpus shadow only exercises the
 * branches real days happen to take; the freshness guard, the extent veto and
 * the same-place bracket can all be wrong in the port while 32 days of London
 * stay green, because London does not reach them.
 *
 * The reason strings are the sharpest part of the comparison. They embed
 * `cadence.toFixed(0)` and `linearity.toFixed(2)`, and `toFixed` rounds against
 * the double's exact binary value — a rule `round(x * 10^f) / 10^f` gets wrong.
 * If `Verified.JsNum.toFixed` were even slightly off, these strings would
 * disagree here and nowhere else.
 *
 * Re-run after any change to the TS passes. A Lean guard that disagrees with
 * this output means the port and the original have diverged, which is the only
 * thing either file is claiming.
 *
 * Run: npx tsx lean/experiments/biometric-labels-refs.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const T0 = 1778457600;

interface StepPoint {
	ts: number;
	steps: number;
}
interface Fix {
	ts: number;
	lat: number;
	lon: number;
	speed_kmh: number;
	bearing: number;
	accuracy: number | null;
}

// biome-ignore lint/suspicious/noExplicitAny: fixtures are structural, not the real TrackSegment
type Seg = any;

/** Mirrors `LabelSeg` in the Lean, with the fields `TrackSegment` also needs. */
function seg(o: Partial<Seg> = {}): Seg {
	return {
		startTs: T0,
		endTs: T0 + 5 * 60,
		mode: "walking",
		confidence: 1,
		confidenceMargin: 100,
		avgSpeed: 3,
		maxSpeed: 0,
		linearity: 0.8,
		pointCount: 0,
		...o,
	};
}

const sp = (ts: number, steps: number): StepPoint => ({ ts, steps });

/** Step rows across the window at `perMin`, plus the freshness row at the end. */
function steady(perMin: number, mins = 5): StepPoint[] {
	const out: StepPoint[] = [];
	for (let k = 0; k < mins; k++) out.push(sp(T0 + k * 60, perMin));
	out.push(sp(T0 + mins * 60, perMin));
	return out;
}

const fix = (ts: number, lat: number, lon: number): Fix => ({
	ts,
	lat,
	lon,
	speed_kmh: 0,
	bearing: 0,
	accuracy: 10,
});

/**
 * The Lean `Decision` for one TS call, recovered by diffing output against
 * input. `keep` is the TS returning the segment unchanged; a flip is the new
 * mode, the reason FRAGMENT it appended, and any tag it added.
 */
import {
	applyStationaryWalkThrough,
	correctModeFromCadence,
	correctStationaryWalkThrough,
	demoteJitterWalkToStationary,
	revertIsolatedCadenceDrives,
} from "../../src/geo/biometrics.js";
function decision(before: Seg, after: Seg): string {
	if (after === before) return ".keep";
	const mode = after.refinedMode ?? after.mode;
	const prior = before.refinedReason;
	const full = after.refinedReason ?? "";
	// The passes append with "; " onto any existing reason.
	const reason = prior && full.startsWith(`${prior}; `) ? full.slice(prior.length + 2) : full;
	const priorKinds = new Set<string>(before.refinedKinds ?? []);
	const added = (after.refinedKinds ?? []).filter((k: string) => !priorKinds.has(k));
	const kind = added.length === 0 ? "none" : `(some ${JSON.stringify(added[0])})`;
	return `.flip ${JSON.stringify(mode)} ${JSON.stringify(reason)} ${kind}`;
}

function show(label: string, value: string): void {
	console.log(`${label.padEnd(58)} ${value}`);
}

console.log("=== correctModeFromCadence ===");
{
	const cases: [string, Seg, StepPoint[]][] = [
		["no Fitbit rows at all", seg(), []],
		["under the 3-min floor", seg({ endTs: T0 + 2 * 60 }), steady(0, 2)],
		["not walking", seg({ mode: "driving" }), steady(0)],
		["above the walking speed ceiling", seg({ avgSpeed: 20 }), steady(0)],
		["stale: no step row at/after the end", seg(), [sp(T0, 0)]],
		["cadence exactly at the threshold", seg(), steady(5)],
		["the correction itself", seg(), steady(0)],
	];
	for (const [name, s, steps] of cases) show(name, decision(s, correctModeFromCadence(s, steps)));
}

console.log("\n=== revertIsolatedCadenceDrives ===");
{
	const flipped = (avgSpeed = 3): Seg =>
		seg({ refinedMode: "driving", refinedKinds: ["low-cadence"], avgSpeed });
	const realDrive = seg({ mode: "driving", avgSpeed: 40 });
	const plainWalk = seg();
	const stay = seg({ mode: "stationary", avgSpeed: 0 });
	const cases: [string, Seg[]][] = [
		["isolated between walks", [plainWalk, flipped(), plainWalk]],
		["stationary stops are transparent", [plainWalk, stay, flipped(), stay, plainWalk]],
		["real drive before", [realDrive, flipped(), plainWalk]],
		["real drive after", [plainWalk, flipped(), realDrive]],
		["real drive visible through a stop", [realDrive, stay, flipped(), plainWalk]],
		["two flips do not vouch for each other", [plainWalk, flipped(), flipped(), plainWalk]],
		["fast enough to leave to the cadence call", [plainWalk, flipped(12), plainWalk]],
		["a GPS drive is not a flip", [plainWalk, realDrive, plainWalk]],
		["alone at the day's edge", [flipped()]],
	];
	for (const [name, segs] of cases) {
		const out = revertIsolatedCadenceDrives(segs);
		show(name, `[${segs.map((s, i) => decision(s, out[i])).join(", ")}]`);
	}
}

console.log("\n=== demoteJitterWalkToStationary ===");
{
	const jitter = seg({ linearity: 0.15 });
	const cases: [string, Seg, StepPoint[]][] = [
		["no Fitbit rows at all", jitter, []],
		["directed path", seg({ linearity: 0.5 }), steady(0)],
		["not walking", seg({ linearity: 0.15, mode: "driving" }), steady(0)],
		["stale step data", jitter, [sp(T0, 0)]],
		["one clear walking minute vetoes it", jitter, [sp(T0 + 120, 60), ...steady(0)]],
		["linearity exactly at the ceiling", seg({ linearity: 0.35 }), steady(0)],
		["the demotion itself", jitter, steady(0)],
	];
	for (const [name, s, steps] of cases) show(name, decision(s, demoteJitterWalkToStationary(s, steps)));
}

console.log("\n=== correctStationaryWalkThrough ===");
{
	const stroll = seg({ mode: "stationary", avgSpeed: 1.4, linearity: 0 });
	const burst = [sp(T0 + 120, 95), ...steady(0)];
	const dwell = seg({ mode: "stationary", avgSpeed: 1.4, linearity: 0, endTs: T0 + 12 * 60 });
	const burst12 = [sp(T0 + 120, 95), ...steady(0, 12)];
	const tight = [fix(T0, 51.52, -0.13), fix(T0 + 300, 51.5202, -0.1301), fix(T0 + 700, 51.5201, -0.1299)];
	const spread = [fix(T0, 51.52, -0.13), fix(T0 + 300, 51.524, -0.136), fix(T0 + 700, 51.528, -0.142)];
	const cases: [string, Seg, StepPoint[], Fix[]][] = [
		["no Fitbit rows at all", stroll, [], []],
		["not stationary", seg({ avgSpeed: 1.4 }), burst, []],
		["pacing in place — no translation", seg({ mode: "stationary", avgSpeed: 0.2 }), burst, []],
		["a multi-hour dwell is never wholesale-flipped", seg({ mode: "stationary", avgSpeed: 1.4, endTs: T0 + 60 * 60 }), burst, []],
		["no unmistakable walking minute", stroll, steady(40), []],
		["the flip itself", stroll, burst, []],
		["extent veto: 12 min inside ~50 m", dwell, burst12, tight],
		["…but a spread-out 12 min flips", dwell, burst12, spread],
		["no fixes: the veto is skipped", dwell, burst12, []],
		["under the duration floor the veto does not apply", stroll, burst, tight],
	];
	for (const [name, s, steps, pts] of cases) {
		show(name, decision(s, correctStationaryWalkThrough(s, steps, pts)));
	}
}

console.log("\n=== applyStationaryWalkThrough (decisions + merge runs) ===");
{
	// This pass is a SEQUENCE pass, so its fixtures must be a real timeline —
	// three consecutive five-minute windows, not three segments sharing one.
	// With a shared window the merge plan is unrecoverable from the output
	// (a merged run and an unmerged one end at the same instant), which is
	// exactly what a first pass at this script got wrong.
	const W = 300;
	const stroll = seg({ startTs: T0 + W, endTs: T0 + 2 * W, mode: "stationary", avgSpeed: 1.4, linearity: 0 });
	const at = (place: string | undefined, k: number): Seg =>
		seg({ startTs: T0 + k * W, endTs: T0 + (k + 1) * W, mode: "stationary", avgSpeed: 0, place });
	const walkAt = (k: number): Seg => seg({ startTs: T0 + k * W, endTs: T0 + (k + 1) * W });
	// Zero throughout, with the one unmistakable walking minute inside the
	// stroll's window. Also supplies the freshness rows the other passes need.
	const burst = Array.from({ length: 16 }, (_, k) => sp(T0 + k * 60, k === 7 ? 95 : 0));

	/** Recover the merge plan: which input indices each output segment covers. */
	function runs(input: Seg[], output: Seg[]): string {
		const spans: string[] = [];
		let i = 0;
		for (const o of output) {
			let j = i;
			// An output segment covers inputs until its endTs is reached.
			while (j < input.length && input[j].endTs < o.endTs) j++;
			spans.push(`(${i}, ${j + 1})`);
			i = j + 1;
		}
		return `[${spans.join(", ")}]`;
	}

	const cases: [string, Seg[]][] = [
		["bracketed by the same place — intra-place pacing", [at("Work", 0), stroll, at("Work", 2)]],
		["transitioning between two different places", [at("Work", 0), stroll, at("Home", 2)]],
		["a bracket with no place is not the same place", [at(undefined, 0), stroll, at(undefined, 2)]],
		["the flipped stop coalesces with the walks", [walkAt(0), stroll, walkAt(2)]],
	];
	for (const [name, segs] of cases) {
		const out = applyStationaryWalkThrough(segs, burst);
		// Decisions are per-INPUT, taken before the merge collapses them, so
		// re-derive them from the per-segment pass plus the bracket guard.
		const decisions = segs.map((s: Seg, i: number) => {
			const prev = segs[i - 1];
			const next = segs[i + 1];
			const bracketed =
				prev !== undefined &&
				next !== undefined &&
				(prev.refinedMode ?? prev.mode) === "stationary" &&
				(next.refinedMode ?? next.mode) === "stationary" &&
				prev.place != null &&
				prev.place === next.place;
			if ((s.refinedMode ?? s.mode) !== "stationary" || bracketed) return ".keep";
			return decision(s, correctStationaryWalkThrough(s, burst, []));
		});
		show(name, `[${decisions.join(", ")}]  runs=${runs(segs, out)}`);
	}
}

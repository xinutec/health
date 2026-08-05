/**
 * Request-path adoption of the verified biometric label rewrites.
 *
 * `Verified.Geo.BiometricLabels` ports the four `computeVelocity` passes that
 * let the step counter overrule what GPS decided about a segment's mode —
 * `cadenceCorrect`, `revertIsolatedCadence`, `jitterWalkToStay`, `walkThrough`.
 * Four of the thirteen velocity passes that had no verified caller (#390).
 *
 *   off    (default) — pure TS, zero behaviour change. The bridge is never
 *            touched; no measurement.
 *   shadow — run BOTH, SERVE the TS track, compare, record.
 *   on     — run BOTH, SERVE the verified track, still compare and record.
 *            Fall back to TS on any bridge failure.
 *
 * **Why this gate is EXACT, like `lean-gpsquality` and unlike `lean-kalman`.**
 * Every output is a discrete label, an index, or a `toFixed` rendering — never
 * a fresh real. The inputs cross as IEEE bit patterns, so both arms compare the
 * same doubles against the same constants. A divergence is therefore a DECISION
 * flip, not a rounding difference, and should be adjudicated rather than filed
 * as noise.
 *
 * The one place a libm difference could reach a decision is the stay-extent
 * veto inside `correctStationaryWalkThrough`, which takes a `haversineMeters`
 * max against an 80 m threshold — and only for a segment whose extent sits
 * within 1 ULP of exactly 80 m.
 *
 * **What is compared.** Decisions, not records. The Lean returns a verdict per
 * segment and the shell rewrites the record, so the comparison asks the one
 * question the port is answering: did both arms decide the same thing about
 * this segment? The TS decision is recovered by diffing its output against its
 * input, which is also how `lean/experiments/biometric-labels-refs.mts` derives
 * the in-build guards.
 */

import { addRefinedKind } from "../geo/segment-util.js";
import type { TransportMode } from "../geo/segments.js";
import { armPair, formatArmPair, resetArmPair, timeTsArm } from "./arm-timing.js";
import { floatToBits } from "./float-bits.js";
import { type LeanBioLabelsResp, LeanBridgeError, type LeanLabelDecision, leanBioLabelsServe } from "./lean-core.js";
import { type LedgerVerdict, servedNote } from "./ledger-verdict.js";
import { type LeanRunScope, leanRunScope } from "./run-scope.js";
import { verifiedCoreOverride } from "./runtime-mode.js";

export type LeanBioLabelsMode = "off" | "shadow" | "on";

/** The four passes, named as the wire protocol names them. */
export type LeanLabelPass = "cadence" | "revert" | "jitter" | "walkthrough";

export function leanBioLabelsMode(): LeanBioLabelsMode {
	// The settings-UI master override wins over the env default when set.
	const o = verifiedCoreOverride();
	if (o !== null) return o ? "on" : "off";
	const v = process.env.LEAN_BIOLABELS;
	return v === "on" || v === "shadow" ? v : "off";
}

/** The segment shape these passes read and rewrite. Structural, matching the
 *  generic constraints on the TS passes rather than naming `TrackSegment`. */
export interface LabelSeg {
	startTs: number;
	endTs: number;
	mode: TransportMode;
	refinedMode?: TransportMode;
	refinedReason?: string;
	refinedKinds?: readonly string[];
	avgSpeed: number;
	maxSpeed: number;
	linearity: number;
	pointCount: number;
	place?: string;
	city?: string;
	wayName?: string;
}

/** A fix, as much of one as the extent veto reads. */
export interface LabelFix {
	ts: number;
	lat: number;
	lon: number;
}

export interface StepRow {
	ts: number;
	steps: number;
}

interface BioLabelsStat {
	/** Successful bridge calls (the verified pass ran and returned). */
	calls: number;
	/** Bridge failures caught and fallen back to TS (LeanBridgeError). */
	fails: number;
	/** Calls where the two arms produced a different NUMBER of segments. */
	lenDiffs: number;
	/** Segments whose decision differed, across all calls. */
	segs: number;
}

const empty = (): BioLabelsStat => ({ calls: 0, fails: 0, lenDiffs: 0, segs: 0 });

let stats: BioLabelsStat = empty();

export interface BioLabelsDivergence {
	pass: LeanLabelPass;
	/** Segment index within the day — identifies it without logging places. */
	i: number;
	ts: string;
	lean: string;
	scope: LeanRunScope;
}

const MAX_DIVERGENCES = 20;
let divergences: BioLabelsDivergence[] = [];

export function resetLeanBioLabelsStats(): void {
	stats = empty();
	divergences = [];
}

const effective = (s: LabelSeg): TransportMode => s.refinedMode ?? s.mode;

/** A segment on the wire. Floats cross as bit patterns so both arms land the
 *  same side of the same threshold; ints and strings cross as themselves. */
function wireSeg(s: LabelSeg): Record<string, unknown> {
	return {
		startTs: s.startTs,
		endTs: s.endTs,
		mode: s.mode,
		refinedMode: s.refinedMode ?? null,
		kinds: s.refinedKinds ?? [],
		avgSpeed: floatToBits(s.avgSpeed),
		maxSpeed: floatToBits(s.maxSpeed),
		linearity: floatToBits(s.linearity),
		pointCount: s.pointCount,
		place: s.place ?? null,
		wayName: s.wayName ?? null,
	};
}

/**
 * The decision the TS arm made about one segment, recovered by diffing its
 * output against its input — `null` for unchanged, else the new mode, the
 * reason FRAGMENT it appended, and any tag it added.
 *
 * Recovering rather than instrumenting keeps the TS passes untouched: the
 * shadow observes the real production code path, not a parallel one written
 * to be observed.
 */
function tsDecision(before: LabelSeg, after: LabelSeg): LeanLabelDecision {
	if (after === before) return null;
	const prior = before.refinedReason;
	const full = after.refinedReason ?? "";
	const reason = prior && full.startsWith(`${prior}; `) ? full.slice(prior.length + 2) : full;
	const priorKinds = new Set(before.refinedKinds ?? []);
	const added = (after.refinedKinds ?? []).filter((k) => !priorKinds.has(k));
	return [effective(after), reason, added[0] ?? null];
}

/** Apply a verdict to a segment, the way the TS passes write it.
 *
 *  Exported for tests: this and {@link rebuildWalkThrough} are the only code
 *  here that CONSTRUCTS a segment, so a bug in them would make `on` serve
 *  something the verified core never decided. They are also the only part the
 *  Lean `#guard`s cannot cover, since the port stops at the decision. */
export function applyDecision<T extends LabelSeg>(seg: T, d: LeanLabelDecision): T {
	if (d === null) return seg;
	const [mode, reason, kind] = d;
	const out: T = {
		...seg,
		refinedMode: mode as TransportMode,
		refinedReason: seg.refinedReason ? `${seg.refinedReason}; ${reason}` : reason,
	};
	if (kind !== null) out.refinedKinds = addRefinedKind(seg.refinedKinds as never, kind as never);
	return out;
}

/**
 * Rebuild the walk-through sequence from a plan: apply each decision, drop the
 * stay label off anything flipped, then collapse each `[start, end)` run into
 * one segment the way `mergeAdjacentWalking` does — the run's first segment
 * takes the last's `endTs`, the summed `pointCount`, the max `maxSpeed` and the
 * first real `wayName`.
 */
export function rebuildWalkThrough<T extends LabelSeg>(
	segments: readonly T[],
	decisions: readonly LeanLabelDecision[],
	runs: ReadonlyArray<readonly [number, number]>,
): T[] {
	const decided = segments.map((s, i) => {
		const d = decisions[i] ?? null;
		if (d === null) return s;
		// A walk-through is no longer a stop, so the stay label goes with it.
		return { ...applyDecision(s, d), place: undefined, city: undefined };
	});
	return runs.map(([start, end]) => {
		const first = { ...decided[start] };
		for (let i = start + 1; i < end; i++) {
			const seg = decided[i];
			first.endTs = seg.endTs;
			first.pointCount += seg.pointCount;
			first.maxSpeed = Math.max(first.maxSpeed, seg.maxSpeed);
			if (!first.wayName && seg.wayName) first.wayName = seg.wayName;
		}
		return first;
	});
}

/** Two verdicts agree when both are `keep`, or both flip the same way. Written
 *  as an explicit both-null test rather than `a === b`: past the guard at least
 *  one side is null, so the comparison is a null check — but spelled `a === b`
 *  it reads as comparing two decision TUPLES by reference, which would be
 *  wrong for any pair that reached it with contents to compare. */
function sameDecision(a: LeanLabelDecision, b: LeanLabelDecision): boolean {
	if (a === null || b === null) return a === null && b === null;
	return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

const showDecision = (d: LeanLabelDecision): string => (d === null ? "keep" : `${d[0]}:${d[1]}`);

/**
 * Compare the two arms' decisions and record the difference. Returns whether
 * they agreed, so the caller can log a per-call warning in shadow.
 */
function record(pass: LeanLabelPass, ts: LeanLabelDecision[], lean: LeanLabelDecision[]): boolean {
	if (ts.length !== lean.length) {
		stats.lenDiffs += 1;
		return false;
	}
	let same = true;
	for (let i = 0; i < ts.length; i++) {
		if (sameDecision(ts[i], lean[i])) continue;
		same = false;
		stats.segs += 1;
		if (divergences.length < MAX_DIVERGENCES) {
			divergences.push({
				pass,
				i,
				ts: showDecision(ts[i]),
				lean: showDecision(lean[i]),
				scope: leanRunScope(),
			});
		}
	}
	return same;
}

/** Run one pass through the bridge, or `null` if it could not be served. */
function serve(
	pass: LeanLabelPass,
	segments: readonly LabelSeg[],
	steps: readonly StepRow[],
	points: readonly LabelFix[],
): LeanBioLabelsResp | null {
	let lean: LeanBioLabelsResp;
	try {
		lean = leanBioLabelsServe({
			pass,
			segs: segments.map(wireSeg),
			steps: steps.map((s) => [s.ts, floatToBits(s.steps)]),
			pts: pass === "walkthrough" ? points.map((p) => [p.ts, floatToBits(p.lat), floatToBits(p.lon)]) : [],
		});
	} catch (e) {
		if (!(e instanceof LeanBridgeError)) throw e;
		stats.fails += 1;
		return null;
	}
	if (lean.error !== undefined || lean.decisions === undefined) {
		stats.fails += 1;
		return null;
	}
	stats.calls += 1;
	return lean;
}

/**
 * The shared body of the three passes that rewrite labels without touching the
 * sequence. `ts` computes the TS arm; it is a thunk so both arms can be timed
 * over the same calls (`arm-timing.ts`).
 */
function viaLean<T extends LabelSeg>(
	pass: Exclude<LeanLabelPass, "walkthrough">,
	segments: readonly T[],
	steps: readonly StepRow[],
	ts: () => T[],
): T[] {
	const mode = leanBioLabelsMode();
	if (mode === "off" || segments.length === 0) return ts();
	const tsResult = timeTsArm("biolabels", ts);

	const lean = serve(pass, segments, steps, []);
	if (lean?.decisions === undefined) return tsResult;

	const tsDecisions = segments.map((s, i) => tsDecision(s, tsResult[i]));
	if (!record(pass, tsDecisions, lean.decisions) && mode === "shadow") {
		console.warn(`[lean-biolabels] ${pass} divergence (n=${segments.length})`);
	}
	return mode === "on" ? segments.map((s, i) => applyDecision(s, lean.decisions?.[i] ?? null)) : tsResult;
}

/** `cadenceCorrect` — walking → driving on near-zero cadence. */
export function correctModeFromCadenceViaLean<T extends LabelSeg>(
	segments: readonly T[],
	steps: readonly StepRow[],
	ts: () => T[],
): T[] {
	return viaLean("cadence", segments, steps, ts);
}

/** `revertIsolatedCadence` — undo a flip with no vehicular context. */
export function revertIsolatedCadenceDrivesViaLean<T extends LabelSeg>(segments: readonly T[], ts: () => T[]): T[] {
	return viaLean("revert", segments, [], ts);
}

/** `jitterWalkToStay` — walking → stationary on a jittered zero-step path. */
export function demoteJitterWalkToStationaryViaLean<T extends LabelSeg>(
	segments: readonly T[],
	steps: readonly StepRow[],
	ts: () => T[],
): T[] {
	return viaLean("jitter", segments, steps, ts);
}

/**
 * `walkThrough` — stationary → walking, then coalesce adjacent walking.
 *
 * The only pass that changes the segment COUNT, so it carries a merge plan as
 * well as decisions. Applying the plan reproduces `mergeAdjacentWalking`: the
 * run's first segment takes the last's `endTs`, the summed `pointCount`, the
 * max `maxSpeed` and the first real `wayName`.
 */
export function applyStationaryWalkThroughViaLean<T extends LabelSeg>(
	segments: readonly T[],
	steps: readonly StepRow[],
	points: readonly LabelFix[],
	ts: () => T[],
): T[] {
	const mode = leanBioLabelsMode();
	if (mode === "off" || segments.length === 0) return ts();
	const tsResult = timeTsArm("biolabels", ts);

	const lean = serve("walkthrough", segments, steps, points);
	if (lean?.decisions === undefined || lean.runs === undefined) return tsResult;

	// The TS output is post-merge, so its per-segment decisions cannot be read
	// off it positionally. Compare what IS positional and comparable: the
	// decided-then-merged sequence both arms produced.
	const merged = rebuildWalkThrough(segments, lean.decisions, lean.runs);

	if (merged.length !== tsResult.length) {
		stats.lenDiffs += 1;
		if (mode === "shadow") {
			console.warn(`[lean-biolabels] walkthrough length divergence: ts=${tsResult.length} lean=${merged.length}`);
		}
	} else {
		// Compare the mode and reason the flip decided AND the fields the MERGE
		// decided. Mode alone is not enough: two different merge plans of the
		// same length — [0,2],[2,3] against [0,1],[1,3] — agree on every label
		// and disagree about where the boundary is, so without `endTs` and
		// `pointCount` the whole merge plan would be outside the gate.
		const shape = (s: T): LeanLabelDecision => [
			effective(s),
			s.refinedReason ?? "",
			`${s.startTs}-${s.endTs}:${s.pointCount}:${s.place ?? ""}`,
		];
		if (!record("walkthrough", tsResult.map(shape), merged.map(shape)) && mode === "shadow") {
			console.warn(`[lean-biolabels] walkthrough divergence (n=${segments.length})`);
		}
	}
	return mode === "on" ? merged : tsResult;
}

/**
 * Print the label-rewrite ledger and reset it. Called per day from `decode-day`.
 *
 * Two levels, not three: there is no expected divergence class here, so
 * anything other than EXACT is a decision flip and reads loud. If one appears,
 * adjudicate which arm is right rather than widening the verdict.
 */
export function logLeanBioLabelsLedger(label: string): LedgerVerdict | null {
	const mode = leanBioLabelsMode();
	if (mode === "off") return null;
	const s = stats;
	const clean = s.lenDiffs === 0 && s.segs === 0;
	// Zero calls is not a pass — see the note in lean-kalman.ts (#392).
	const verdict = s.calls === 0 ? "NOT EXERCISED" : clean ? "EXACT" : `${s.lenDiffs + s.segs} DIVERGED`;
	const detail = clean ? "" : ` — len=${s.lenDiffs} segs=${s.segs}`;
	const served = divergences.filter((d) => d.scope === "decode").length;
	const servedTag = servedNote(mode, served);
	const calls =
		divergences.length === 0
			? ""
			: ` — ${divergences.map((d) => `[${d.scope}] ${d.pass}#${d.i} ts=${d.ts} lean=${d.lean}`).join("; ")}`;
	// Both arms' wall cost this run — read before the reset below.
	const armMs = formatArmPair(armPair("biolabels"));
	console.log(
		`lean-biolabels[${mode}] ${label} ${s.calls}/${s.fails}f${s.calls === 0 ? " (no calls)" : ""}${detail} ${verdict}${servedTag}${calls}${armMs}`,
	);
	const out: LedgerVerdict = {
		tenant: "biolabels",
		mode,
		calls: s.calls,
		fails: s.fails,
		// No per-item fingerprint: this tenant compares whole outputs, so a
		// divergence of its own cannot be recorded in the ceiling and always fails.
		unexplained: [],
		klass: s.calls === 0 ? "not-exercised" : clean ? "exact" : "diverged",
	};
	resetLeanBioLabelsStats();
	resetArmPair("biolabels");
	return out;
}

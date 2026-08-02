/**
 * Request-path adoption of the verified walk map-matcher (the decision
 * engine, not just the geometry passes).
 *
 * This is the matcher analogue of `lean-passes.ts`: it lets production run
 * the *proved* Lean Viterbi walk-matcher (`MatchViterbi.decodeFast`, whose
 * `decodeFast_argmax` proves the returned chain is the maximum-`pathScore`
 * candidate) via the synchronous bridge (`lean-core.ts`) in place of the TS
 * `matchWalkSegment`, staged behind its OWN env flag:
 *
 *   off    (default) — pure TS, zero behaviour change. The bridge is never
 *            touched; no measurement.
 *   shadow — run BOTH, SERVE the TS output, compare, log divergence. The
 *            request-path shadow (the cron already shadows via spawnSync;
 *            this measures the SERVE path, over the persistent worker).
 *   on     — run BOTH, SERVE the verified Lean output, still compare and
 *            record. Fall back to TS on any bridge failure.
 *
 * Why a SEPARATE flag from `LEAN_PASSES` (rather than reusing it): the five
 * geometry passes are already served `on` in production, but the matcher is
 * only days into its quant↔Lean soak (`walk-shadow` in decode-day). Coupling
 * the two flags would flip an un-soaked matcher the instant anyone touched
 * the passes flag. `LEAN_MATCH` keeps the matcher flip an independent,
 * separately-gated decision — the plumbing lands now, the flip waits for the
 * soak.
 *
 * Inputs are quantised to the pinned 1e-7° integers on the way in — exactly
 * what the `compare-match` referee (173/173 quant↔Lean) sees — so that gate
 * is the judge of what `on` serves. `on` adopts quantised geometry as truth,
 * which differs from the TS floats on the corpus's known near-tie legs (the
 * route near-ties + the one building-penalty in/out flip); those are the
 * matcher's accepted-delta class, surfaced in the ledger so the flip is never
 * blind.
 */

import { type LegMetres, legClasses, legDeviations, legFingerprint, legNote } from "../geo/leg-compare.js";
import type { BuildingRing, RoadFix, RoadGeometry } from "../geo/map-match-core.js";
import type { WalkMatchResult } from "../geo/pedestrian-match.js";
import { type QPt, quantPt } from "../geo/quant-twin.js";
import { isAcceptedMatchDelta, type MatchLegClass, matchDeltaTag } from "./accepted-match-deltas.js";
import { armPair, formatArmPair, resetArmPair, timeTsArm } from "./arm-timing.js";
import { LeanBridgeError, type LeanMatchResp, leanMatchServe } from "./lean-core.js";
import { type LedgerVerdict, servedNote } from "./ledger-verdict.js";
import { type LeanRunScope, leanRunScope, resetLeanRunScope, setLeanLeg } from "./run-scope.js";
import { verifiedCoreOverride } from "./runtime-mode.js";

export type LeanMatchMode = "off" | "shadow" | "on";

export function leanMatchMode(): LeanMatchMode {
	// The settings-UI master override wins over the env default when set.
	const o = verifiedCoreOverride();
	if (o !== null) return o ? "on" : "off";
	const v = process.env.LEAN_MATCH;
	return v === "on" || v === "shadow" ? v : "off";
}

interface MatchStat {
	/** Successful bridge calls (the verified matcher ran and returned). */
	calls: number;
	/** Bridge failures caught and fallen back to TS (LeanBridgeError). */
	fails: number;
	/** Calls where the Lean decision (coarse layer) differed from TS. */
	coarseDiffs: number;
	/** Calls where only the display path (splice detail) differed. */
	pathDiffs: number;
	/** Calls where one arm matched and the other returned null. */
	nullFlips: number;
}

const empty = (): MatchStat => ({ calls: 0, fails: 0, coarseDiffs: 0, pathDiffs: 0, nullFlips: 0 });

/** Tallies per run scope. Pooled into one counter, the observational
 *  `runWalkShadow` velocity run's legs were summed with the persisted decode's,
 *  so the ledger reported roughly double the served call count and could not say
 *  whether a divergence reached served output. */
const stats = new Map<LeanRunScope, MatchStat>();

function stat(): MatchStat {
	const s = stats.get(leanRunScope()) ?? empty();
	stats.set(leanRunScope(), s);
	return s;
}

/** Matcher tallies since the last reset, summed across scopes. */
export function leanMatchStats(): Readonly<MatchStat> {
	const out = empty();
	for (const s of stats.values()) {
		out.calls += s.calls;
		out.fails += s.fails;
		out.coarseDiffs += s.coarseDiffs;
		out.pathDiffs += s.pathDiffs;
		out.nullFlips += s.nullFlips;
	}
	return out;
}

/** Per-scope matcher tallies — what separates served output from measurement. */
export function leanMatchScopeTotals(): Readonly<Partial<Record<LeanRunScope, Readonly<MatchStat>>>> {
	return Object.fromEntries(stats);
}

/** A measured per-leg divergence, fingerprinted so the ledger can adjudicate it
 *  against `accepted-match-deltas.ts` — the same call the gate makes. */
export interface MatchDivergence {
	leg: string;
	coarse: MatchLegClass;
	path: MatchLegClass;
	note: string;
	/** How far the two arms' LINES are, per layer, in metres — the same
	 *  `legDeviations` figure `compare-match --gate` prints and the manifest
	 *  records. Carried because the manifest enforces it as a ceiling: without it
	 *  the ledger could only check vertex counts, and a leg that held its counts
	 *  while moving 120 m would read `accepted` here (#395, the #398 shape). */
	devM: LegMetres;
	scope: LeanRunScope;
}

const divergences: MatchDivergence[] = [];
const MAX_DIVERGENCES = 500;

/** Structured matcher divergences (bounded) since the last reset. */
export function leanMatchDivergences(): readonly MatchDivergence[] {
	return divergences;
}

export function resetLeanMatchStats(): void {
	stats.clear();
	divergences.length = 0;
	resetLeanRunScope();
}

const row = (p: QPt): number[] => [Number(p.la), Number(p.lo), Number(p.ts)];
const coord = (p: QPt): number[] => [Number(p.la), Number(p.lo)];

/** Quantise a leg's matcher input exactly as `compare-match` / the shadow do
 *  (`walk-shadow-core.shadowWalkLeg`): fixes with ts, ways as lat/lon coord
 *  pairs + name, buildings as coord rings — all pinned 1e-7° integers. */
function quantReq(fixes: readonly RoadFix[], geo: RoadGeometry): Record<string, unknown> {
	const buildings: readonly BuildingRing[] = geo.buildings ?? [];
	return {
		fixes: fixes.map((f) => row(quantPt(f))),
		ways: geo.ways.map((w) => ({
			coords: w.coords.map(([lat, lon]) => coord(quantPt({ lat, lon }))),
			name: w.name ?? null,
		})),
		buildings: buildings.map((r) => r.map((p) => coord(quantPt(p)))),
	};
}

const eqNum = (a: readonly number[], b: readonly number[]): boolean =>
	a.length === b.length && a.every((x, i) => x === b[i]);
const eqRows = (a: readonly number[][], b: readonly number[][]): boolean =>
	a.length === b.length && a.every((r, i) => eqNum(r, b[i]));

/** Quantise a TS matched line to comparison rows (ts carried — matched points
 *  always have an interpolated timestamp). */
const qRows = (pts: readonly { lat: number; lon: number; ts: number }[]): number[][] => pts.map((p) => row(quantPt(p)));

/** Dequantise a verified `match` response back to a `WalkMatchResult`.
 *  `on` mode serves this: the 1e-7° integers become floats (a ≤ 5e-8° /
 *  ~5 mm shift — the "quantised geometry as truth" the doc note describes). */
/** A verified response row as the quantised point the classifier compares. */
const toQPt = (r: readonly number[]): QPt => ({ la: BigInt(r[0]), lo: BigInt(r[1]), ts: BigInt(r[2]) });

const deq = (r: readonly number[]): { lat: number; lon: number; ts: number } => ({
	lat: r[0] / 1e7,
	lon: r[1] / 1e7,
	ts: r[2],
});

function leanToResult(lean: LeanMatchResp): WalkMatchResult | null {
	if (lean.none === true || lean.path === undefined || lean.coarse === undefined) return null;
	return { path: lean.path.map(deq), coarsePath: lean.coarse.map(deq) };
}

/**
 * Map-match a walking leg through the verified core, staged behind
 * `LEAN_MATCH`. `ts` computes the TS output (`matchWalkSegment(...)`). Both
 * `shadow` and `on` run the Lean matcher and compare against it; `shadow`
 * serves the TS result, `on` serves the dequantised verified one. Any bridge
 * failure is recorded and falls back to TS (swallow-over-wrong, execution
 * edition). *
 * The TS arm arrives as a THUNK so both arms can be timed over the same calls
 * (`arm-timing.ts`) — the RATIO is what a flip decision turns on, and an
 * eagerly-evaluated argument had already finished before this was entered. This is the tenant whose cost the ratio
 * most needs to state: it is the only one where consulting Lean is a real
 * computation rather than a sub-millisecond pass.
 */
export function matchWalkSegmentViaLean(
	fixes: readonly RoadFix[],
	geo: RoadGeometry,
	ts: () => WalkMatchResult | null,
): WalkMatchResult | null {
	// Name the leg for everything below, INCLUDING the `off` and too-short early
	// returns and the TS arm itself. `ts()` is `matchWalkSegment`, and the
	// geometry passes (simplify and spurs inside `matchTrajectory`, trim and
	// despike after it) run as hooks underneath — with no way of their own to
	// know which leg they are on. `LEAN_PASSES` is an independent flag, so the
	// passes are ledgered on runs where the matcher tenant is off entirely;
	// attributing only on the non-`off` path would blind exactly those runs.
	const restoreLeg = setLeanLeg(legFingerprint(fixes));
	try {
		return matchWalkSegmentInner(fixes, geo, ts);
	} finally {
		restoreLeg();
	}
}

function matchWalkSegmentInner(
	fixes: readonly RoadFix[],
	geo: RoadGeometry,
	ts: () => WalkMatchResult | null,
): WalkMatchResult | null {
	const mode = leanMatchMode();
	if (mode === "off" || fixes.length < 3) return ts();
	const tsResult = timeTsArm("match", ts);
	let lean: LeanMatchResp;
	try {
		lean = leanMatchServe(quantReq(fixes, geo));
	} catch (e) {
		if (!(e instanceof LeanBridgeError)) throw e;
		stat().fails += 1;
		return tsResult;
	}
	stat().calls += 1;

	// Compare quantised-TS against the verified rows, splitting the DECISION
	// layer (coarse) from the display splice (path): a coarse flip is a real
	// matcher-decision divergence; a path-only flip is the known splice near-tie
	// class. A null-vs-matched flip is its own (loudest) bucket.
	const leanResult = leanToResult(lean);
	if ((tsResult === null) !== (leanResult === null)) {
		stat().nullFlips += 1;
		if (mode === "shadow") {
			console.warn(`[lean-match] null-flip (ts=${tsResult === null ? "null" : "match"} n=${fixes.length})`);
		}
	} else if (tsResult !== null && leanResult !== null) {
		const coarseDiff = !eqRows(qRows(tsResult.coarsePath), lean.coarse ?? []);
		const pathDiff = !eqRows(qRows(tsResult.path), lean.path ?? []);
		if (coarseDiff) stat().coarseDiffs += 1;
		else if (pathDiff) stat().pathDiffs += 1;
		if (coarseDiff || pathDiff) {
			// Classify and fingerprint EXACTLY as the gate does, so the ledger can
			// adjudicate this leg against the same manifest the gate enforces. The
			// quant arm here is Lean's own rows; quant↔Lean is gated bit-exact, so
			// this is the gate's float↔quant comparison on the served leg.
			const quantArm = { coarsePath: (lean.coarse ?? []).map(toQPt), path: (lean.path ?? []).map(toQPt) };
			const cls = legClasses(tsResult, quantArm);
			if (divergences.length < MAX_DIVERGENCES) {
				divergences.push({
					leg: legFingerprint(fixes),
					coarse: cls.coarse,
					path: cls.path,
					note: legNote(tsResult, quantArm),
					devM: legDeviations(tsResult, quantArm),
					scope: leanRunScope(),
				});
			}
			if (mode === "shadow") {
				console.warn(
					`[lean-match] divergence (n=${fixes.length}) coarse=${coarseDiff} path=${pathDiff} ` +
						`ts=${tsResult.coarsePath.length} lean=${(lean.coarse ?? []).length}`,
				);
			}
		}
	}

	return mode === "on" ? leanResult : tsResult;
}

/**
 * Request-path MATCHER ledger — the serve-path analogue of the always-on
 * `walk-shadow` (which spawns `verified_cli match` per leg). When `LEAN_MATCH`
 * is `shadow` or `on`, the walk matcher runs the proved Lean Viterbi over the
 * persistent bridge during the day's velocity runs; log the accumulated
 * serve-path ledger (calls/failures/decision-divergences) and reset. No-op with
 * the flag off (the default) — the plumbing is dormant until the matcher flip,
 * independent of `LEAN_PASSES`.
 *
 * Lives here rather than in `decode-day` (where it was until #392) so it sits
 * beside the tenant it measures and can be called by the corpus gate.
 */
export function logLeanMatchLedger(label: string): LedgerVerdict | null {
	const mode = leanMatchMode();
	if (mode === "off") return null;
	const s = leanMatchStats();
	// Counts breakdown only when there is something to break down; the verdict
	// below already says EXACT, and printing both read "EXACT EXACT".
	const clean = s.coarseDiffs === 0 && s.pathDiffs === 0 && s.nullFlips === 0;
	const detail = clean ? "" : ` — coarse=${s.coarseDiffs} path=${s.pathDiffs} null=${s.nullFlips}`;
	// Which run each divergence came from. `decode` is the persisted, served
	// output; `shadow` is `runWalkShadow`'s extra velocity run over the same
	// legs. Pooled, the served count read roughly double and a shadow-only
	// divergence was indistinguishable from one a reader would actually see.
	const scopes = leanMatchScopeTotals();
	const byScope = Object.entries(scopes)
		.map(([sc, t]) => `${sc} ${t.calls}/${t.fails}f/${t.coarseDiffs}c/${t.pathDiffs}p/${t.nullFlips}n`)
		.join(" · ");
	const servedDiffs =
		(scopes.decode?.coarseDiffs ?? 0) + (scopes.decode?.pathDiffs ?? 0) + (scopes.decode?.nullFlips ?? 0);
	const servedTag = servedNote(mode, servedDiffs);
	// Adjudicate each measured leg against the accepted manifest — the same
	// `isAcceptedMatchDelta` the gate enforces, now reachable because the
	// manifest is keyed on the leg's own fingerprint rather than on a golden
	// date the cron's live days can never match.
	const divs = leanMatchDivergences();
	const unexplained = divs.filter((d) => !isAcceptedMatchDelta(d.leg, d.coarse, d.path, d.note, d.devM));
	// Zero calls is not a pass — see the note in lean-kalman.ts (#392).
	const verdict =
		s.calls === 0
			? "NOT EXERCISED"
			: divs.length === 0
				? "EXACT"
				: unexplained.length === 0
					? "all accepted"
					: `${unexplained.length} UNEXPLAINED`;
	// The deviation is printed, not just used: the manifest now ACCEPTS on this
	// number, so a reader adjudicating a production line has to be able to see
	// what it was adjudicated against. Same reason the gate prints it (#400).
	const m = (x: number | null): string => (x === null ? "n/a" : `${x.toFixed(2)} m`);
	const legDetail =
		divs.length === 0
			? ""
			: ` — ${divs
					.map(
						(d) =>
							`[${matchDeltaTag(d.leg, d.coarse, d.path, d.note, d.devM)}][${d.scope}] leg=${d.leg} ` +
							`coarse=${d.coarse}/path=${d.path} ${d.note} ` +
							`dev coarse=${m(d.devM.coarse)} path=${m(d.devM.path)}`,
					)
					.join("; ")}`;
	// Both arms' wall cost this run — read before the reset below.
	const armMs = formatArmPair(armPair("match"));
	console.log(
		`lean-match[${mode}] ${label} ${s.calls}/${s.fails}f${s.calls === 0 ? " (no calls)" : ""}` +
			`${byScope === "" ? "" : ` [by run: ${byScope}]`}${detail} ${verdict}${servedTag}${legDetail}${armMs}`,
	);
	const out: LedgerVerdict = {
		tenant: "match",
		mode,
		calls: s.calls,
		fails: s.fails,
		// The leg hash alone — it is already a fingerprint of the quantised
		// input, so it names the leg without naming where the user was, which
		// is what makes the ceiling file safe to commit.
		unexplained: unexplained.map((d) => d.leg).sort(),
		klass:
			s.calls === 0
				? "not-exercised"
				: divs.length === 0
					? "exact"
					: unexplained.length === 0
						? "accepted"
						: "diverged",
	};
	resetLeanMatchStats();
	resetArmPair("match");
	return out;
}

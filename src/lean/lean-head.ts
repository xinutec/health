/**
 * Request-path adoption of the verified pipeline HEAD (#975).
 *
 * `snapToPlace` and `classifySegments` are the two TS algorithm steps between
 * the raw fixes and `segsRaw`, which is the day fold's only input:
 *
 *     raw fixes → gpsquality (Lean) → snapToPlace (HERE) → kalman (Lean)
 *               → classifySegments (HERE) → segsRaw → day
 *
 * This is what `LEAN_DAY=solo` was blocked on. With the head in TS, the fold's
 * own request is built out of TS intermediates — so retiring the day's TS arm
 * would have removed the thing computing the fold's inputs. Both twins had been
 * complete and `#guard`-pinned for months with NOTHING CALLING THEM; the `head`
 * verb (`861692b`) made them reachable and this makes them served.
 *
 *   off    (default) — pure TS, zero behaviour change. Bridge never touched.
 *   shadow — run BOTH, SERVE the TS answer, compare, record.
 *   on     — run BOTH, SERVE the verified answer, still compare and record.
 *            Fall back to TS on any bridge failure.
 *   solo   — Lean alone. No TS arm, no comparison, NO FALLBACK.
 *
 * **ONE flag for two ops**, the way `LEAN_PASSES` governs six. They are one
 * stage of the pipeline and they get staged together; splitting them would mean
 * a state where the head is half-ported, which is a state nobody wants to debug.
 * The ledger keeps per-op counts so a silent op is still visible.
 *
 * **Why the comparison here is EXACT, with no ULP class.** Every float crosses
 * as its IEEE bit pattern (`float-bits.ts`), so both arms start from identical
 * inputs. `snapToPlace` returns either the input coordinates unchanged or a
 * centroid copied from the place list — no arithmetic reaches the output, so a
 * divergence is a DECISION flip about whether to snap. `classifySegments` does
 * compute (`exp` through `rangeScore`), but its outputs are pinned bit-for-bit
 * by `Segments.lean`'s guards against the production TS, re-verified 2026-08-17.
 * Anything other than EXACT here is a finding to adjudicate, not noise.
 */

import type { KnownPlace } from "../geo/place-snap.js";
import type { TrackSegment } from "../geo/segments.js";
import { floatFromBits, floatToBits } from "./float-bits.js";
import { LeanBridgeError, type LeanHeadResp, leanHeadServe } from "./lean-core.js";
import { type LedgerVerdict, servedNote } from "./ledger-verdict.js";
import { verifiedCoreOverride } from "./runtime-mode.js";

export type LeanHeadMode = "off" | "shadow" | "on" | "solo";

export function leanHeadMode(): LeanHeadMode {
	// Same precedence as every other tenant: the settings-UI master override
	// beats the env default, and it cannot select `solo` — deleting the fallback
	// is a deployment decision, not a UI preference.
	const o = verifiedCoreOverride();
	if (o !== null) return o ? "on" : "off";
	const v = process.env.LEAN_HEAD;
	return v === "on" || v === "shadow" || v === "solo" ? v : "off";
}

interface HeadStat {
	calls: number;
	fails: number;
	/** Calls where the two arms produced a different NUMBER of results. */
	lenDiffs: number;
	/** Calls where the counts matched but some element differed. */
	valueDiffs: number;
	/** Total elements that differed, across all calls of this op. */
	items: number;
}

const empty = (): HeadStat => ({ calls: 0, fails: 0, lenDiffs: 0, valueDiffs: 0, items: 0 });
const stats = new Map<string, HeadStat>();

function stat(op: string): HeadStat {
	let s = stats.get(op);
	if (s === undefined) {
		s = empty();
		stats.set(op, s);
	}
	return s;
}

interface HeadDivergence {
	op: string;
	/** Input size — identifies the call without logging coordinates. */
	n: number;
	note: string;
}
const MAX_DIVERGENCES = 20;
let divergences: HeadDivergence[] = [];

export function resetLeanHeadStats(): void {
	stats.clear();
	divergences = [];
}

export function leanHeadStats(): Record<string, HeadStat> {
	return Object.fromEntries([...stats.entries()].map(([k, v]) => [k, { ...v }]));
}

function record(op: string, n: number, note: string): void {
	if (divergences.length < MAX_DIVERGENCES) divergences.push({ op, n, note });
}

/** A place as its wire row. `id` is metadata — it never reaches the snap
 *  decision — but it is stringified rather than dropped so that a future
 *  response carrying `snappedTo` does not need the shape changed. */
const placeRow = (p: KnownPlace): [string, string, string | null, string | null] => [
	floatToBits(p.centroidLat),
	floatToBits(p.centroidLon),
	p.radiusM === undefined ? null : floatToBits(p.radiusM),
	p.id === undefined ? null : String(p.id),
];

type Fix = { lat: number; lon: number; accuracy: number | null };

const fixRow = (p: Fix): [string, string, string | null] => [
	floatToBits(p.lat),
	floatToBits(p.lon),
	p.accuracy === null ? null : floatToBits(p.accuracy),
];

/** Call the bridge for one op, or throw. Shared so the two ops cannot drift in
 *  how they treat an error response — a `{error}` body is a FAILURE, not an
 *  empty result, and reading it as the latter is how a tenant silently serves
 *  nothing. */
function callHead(op: string, req: Record<string, unknown>): LeanHeadResp {
	const resp = leanHeadServe({ op, ...req });
	if (resp.error !== undefined) {
		stat(op).fails += 1;
		throw new LeanBridgeError(`lean-head[${op}]: ${resp.error}`);
	}
	return resp;
}

/**
 * Apply the verified place-snap to a whole day's fixes.
 *
 * ⚠ **BATCHED, and that is not an optimisation.** The TS calls `snapToPlace`
 * once per fix inside a `.map` (`velocity.ts:687`). A bridge round trip per fix
 * would be thousands of calls for one day where every other tenant makes one,
 * and the persistent core is not free per call. So the whole day crosses once
 * and the response is positional — one row per input fix, in input order.
 *
 * Returns the INPUT objects unchanged where no snap happened, so identity is
 * preserved downstream exactly as the TS `.map` preserves it.
 */
export function snapAllViaLean<T extends Fix>(fixes: readonly T[], places: readonly KnownPlace[], ts: () => T[]): T[] {
	const mode = leanHeadMode();
	if (mode === "off") return ts();

	// The TS itself skips the whole map when there are no places, and Lean agrees
	// (`places.isEmpty` returns the fix unchanged). Not worth a bridge call, and
	// unlike the gpsquality guard this one IS the identity on both sides.
	if (places.length === 0) return ts();

	const req = { fixes: fixes.map(fixRow), places: places.map(placeRow) };

	if (mode === "solo") {
		const resp = callHead("snap", req);
		if (resp.snapped === undefined) {
			stat("snap").fails += 1;
			throw new LeanBridgeError("lean-head[snap]: no snapped rows in response");
		}
		stat("snap").calls += 1;
		return applySnap(fixes, resp.snapped);
	}

	const tsResult = ts();
	let lean: T[];
	try {
		const resp = callHead("snap", req);
		if (resp.snapped === undefined) throw new LeanBridgeError("lean-head[snap]: no snapped rows");
		lean = applySnap(fixes, resp.snapped);
		stat("snap").calls += 1;
	} catch (e) {
		if (!(e instanceof LeanBridgeError)) throw e;
		return tsResult;
	}

	compareFixes("snap", tsResult, lean);
	return mode === "on" ? lean : tsResult;
}

/** Zip a positional snap response back onto the input fixes. */
function applySnap<T extends Fix>(fixes: readonly T[], rows: NonNullable<LeanHeadResp["snapped"]>): T[] {
	if (rows.length !== fixes.length) {
		throw new LeanBridgeError(`lean-head[snap]: ${rows.length} rows for ${fixes.length} fixes`);
	}
	return fixes.map((p, i) => {
		const [la, lo, acc, snapped] = rows[i];
		// Not snapped ⇒ the very same object, never a copy. The TS returns `p`
		// unchanged in that branch and downstream code compares by identity in
		// places; a copy here would be a behaviour change disguised as a port.
		if (!snapped) return p;
		return { ...p, lat: floatFromBits(la), lon: floatFromBits(lo), accuracy: acc === null ? null : floatFromBits(acc) };
	});
}

function compareFixes<T extends Fix>(op: string, ts: readonly T[], lean: readonly T[]): void {
	const s = stat(op);
	if (ts.length !== lean.length) {
		s.lenDiffs += 1;
		record(op, ts.length, `len ts=${ts.length} lean=${lean.length}`);
		return;
	}
	const bad: number[] = [];
	for (let i = 0; i < ts.length; i++) {
		const a = ts[i];
		const b = lean[i];
		if (floatToBits(a.lat) !== floatToBits(b.lat) || floatToBits(a.lon) !== floatToBits(b.lon)) bad.push(i);
		else if ((a.accuracy === null) !== (b.accuracy === null)) bad.push(i);
		else if (a.accuracy !== null && b.accuracy !== null && floatToBits(a.accuracy) !== floatToBits(b.accuracy)) {
			bad.push(i);
		}
	}
	if (bad.length > 0) {
		s.valueDiffs += 1;
		s.items += bad.length;
		record(op, ts.length, `${bad.length} fix(es) differ at [${bad.slice(0, 10)}]`);
	}
}

type StayPt = { ts: number; lat: number; lon: number };
type SegPt = { ts: number; lat: number; lon: number; speed_kmh: number; bearing: number };

/**
 * Cut a Kalman-filtered track into transport-mode segments via the verified
 * classifier — the step whose output IS the day fold's `segsRaw`.
 *
 * `stayPoints` absent and an EMPTY ARRAY are different requests and must stay
 * different: absent means "no separate stay set, double the movement fixes up as
 * stay evidence", which is `classifySegments`' own default, while empty means
 * "there is genuinely no stay evidence". Passing `[]` for `undefined` would
 * silently disable stay detection for the day.
 */
export function classifySegmentsViaLean(
	points: readonly SegPt[],
	stayPoints: readonly StayPt[] | undefined,
	ts: () => TrackSegment[],
): TrackSegment[] {
	const mode = leanHeadMode();
	if (mode === "off") return ts();

	const req = {
		pts: points.map((p) => [
			p.ts,
			floatToBits(p.lat),
			floatToBits(p.lon),
			floatToBits(p.speed_kmh),
			floatToBits(p.bearing),
		]),
		stayPts: stayPoints === undefined ? null : stayPoints.map((p) => [p.ts, floatToBits(p.lat), floatToBits(p.lon)]),
	};

	if (mode === "solo") {
		const resp = callHead("segments", req);
		if (resp.segs === undefined) {
			stat("segments").fails += 1;
			throw new LeanBridgeError("lean-head[segments]: no segs in response");
		}
		stat("segments").calls += 1;
		return resp.segs.map(decodeSeg);
	}

	const tsResult = ts();
	let lean: TrackSegment[];
	try {
		const resp = callHead("segments", req);
		if (resp.segs === undefined) throw new LeanBridgeError("lean-head[segments]: no segs");
		lean = resp.segs.map(decodeSeg);
		stat("segments").calls += 1;
	} catch (e) {
		if (!(e instanceof LeanBridgeError)) throw e;
		return tsResult;
	}

	compareSegs(tsResult, lean);
	return mode === "on" ? lean : tsResult;
}

function decodeSeg(s: NonNullable<LeanHeadResp["segs"]>[number]): TrackSegment {
	return {
		startTs: s.startTs,
		endTs: s.endTs,
		mode: s.mode,
		confidence: floatFromBits(s.confidence),
		confidenceMargin: floatFromBits(s.confidenceMargin),
		avgSpeed: floatFromBits(s.avgSpeed),
		maxSpeed: floatFromBits(s.maxSpeed),
		linearity: floatFromBits(s.linearity),
		pointCount: s.pointCount,
		...(s.refinedReason === null ? {} : { refinedReason: s.refinedReason }),
		...(s.refinedKinds.length === 0 ? {} : { refinedKinds: s.refinedKinds }),
	} as TrackSegment;
}

function compareSegs(ts: readonly TrackSegment[], lean: readonly TrackSegment[]): void {
	const s = stat("segments");
	if (ts.length !== lean.length) {
		s.lenDiffs += 1;
		record("segments", ts.length, `len ts=${ts.length} lean=${lean.length}`);
		return;
	}
	const bad: number[] = [];
	for (let i = 0; i < ts.length; i++) {
		const a = ts[i];
		const b = lean[i];
		const same =
			a.startTs === b.startTs &&
			a.endTs === b.endTs &&
			a.mode === b.mode &&
			a.pointCount === b.pointCount &&
			floatToBits(a.confidence) === floatToBits(b.confidence) &&
			floatToBits(a.confidenceMargin) === floatToBits(b.confidenceMargin) &&
			floatToBits(a.avgSpeed) === floatToBits(b.avgSpeed) &&
			floatToBits(a.maxSpeed) === floatToBits(b.maxSpeed) &&
			floatToBits(a.linearity) === floatToBits(b.linearity) &&
			// ⚠ The REFINED fields are compared too. `inferTransitGaps` — which
			// `classifySegments` runs last — is the one stage here that sets them,
			// and it sets them on exactly the segments it invented from a GPS
			// blackout. Leaving them out compared only the fields the easy
			// stationary/walking cases populate, so a gap-inference divergence, the
			// most interesting thing this op can get wrong, would have read EXACT.
			(a.refinedReason ?? null) === (b.refinedReason ?? null) &&
			(a.refinedKinds ?? []).join(" ") === (b.refinedKinds ?? []).join(" ");
		if (!same) bad.push(i);
	}
	if (bad.length > 0) {
		s.valueDiffs += 1;
		s.items += bad.length;
		record("segments", ts.length, `${bad.length} seg(s) differ at [${bad.slice(0, 10)}]`);
	}
}

/**
 * Print the head ledger and reset it. Called per day from `decode-day`.
 *
 * Per-op counts are kept and printed even when clean: one flag governs two
 * stages, so "the tenant ran" is not the same claim as "both ops ran", and an op
 * that quietly stopped being reached is invisible in a total.
 */
export function logLeanHeadLedger(label: string): LedgerVerdict | null {
	const mode = leanHeadMode();
	if (mode === "off") return null;

	const ops = [...stats.entries()].sort(([a], [b]) => a.localeCompare(b));
	const calls = ops.reduce((n, [, s]) => n + s.calls, 0);
	const fails = ops.reduce((n, [, s]) => n + s.fails, 0);
	const lenDiffs = ops.reduce((n, [, s]) => n + s.lenDiffs, 0);
	const valueDiffs = ops.reduce((n, [, s]) => n + s.valueDiffs, 0);
	const clean = lenDiffs === 0 && valueDiffs === 0;

	// ⚠ `solo` must not print EXACT. `clean` is vacuously true with no TS arm —
	// nothing can increment the diff counters — and EXACT would claim an
	// agreement that was never tested. A reader cannot tell "agreed everywhere"
	// from "nothing was compared"; SOLO says which.
	const verdict =
		calls === 0
			? "NOT EXERCISED"
			: mode === "solo"
				? "SOLO (no TS arm, nothing compared)"
				: clean
					? "EXACT"
					: `${lenDiffs + valueDiffs} DIVERGED`;

	const perOp = ops.map(([op, s]) => `${op} ${s.calls}/${s.fails}f`).join(" ");
	const detail = clean ? "" : ` — len=${lenDiffs} value=${valueDiffs}`;
	const notes =
		divergences.length === 0 ? "" : ` — ${divergences.map((d) => `[${d.op}] n=${d.n} ${d.note}`).join("; ")}`;
	console.log(
		`lean-head[${mode}] ${label} ${calls}/${fails}f${calls === 0 ? " (no calls)" : ""} {${perOp}}${detail} ${verdict}${servedNote(mode, 0)}${notes}`,
	);

	const out: LedgerVerdict = {
		tenant: "head",
		mode,
		calls,
		fails,
		// Whole-output comparison, so a divergence here has no per-item
		// fingerprint the ceiling could grade — it always fails, deliberately.
		unexplained: [],
		klass: calls === 0 ? "not-exercised" : clean ? "exact" : "diverged",
	};
	resetLeanHeadStats();
	return out;
}

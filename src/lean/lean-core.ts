/**
 * Synchronous, in-process bridge to the verified Lean core (`verified_cli`).
 *
 * This is the request-path execution substrate: it lets synchronous TS call
 * sites (the geometry passes deep inside `computeVelocity`) run the *proved*
 * Lean implementation without a per-call process spawn, and without turning
 * the whole pipeline async.
 *
 * Mechanism: a `worker_thread` owns one long-lived `verified_cli serve`
 * child and does the async pipe I/O; the caller (this thread) posts a
 * request and blocks on `Atomics.wait` over a `SharedArrayBuffer` until the
 * worker writes the response back and flips the control word. The bridge
 * contract is byte-for-byte the `compare-geo` / `compare-match` referee
 * contract: inputs are the pinned 1e-7° integers, the worker never sees a
 * float, so the 173/173 gates are the exact judge of what production runs.
 *
 * Failure is always recoverable: a missing binary, worker crash, child
 * exit, oversized response, or timeout throws `LeanBridgeError`, and every
 * caller is expected to fall back to the TS implementation (swallow-over-
 * wrong, execution edition). The bridge is a process-wide singleton
 * (`leanCore`); the first call pays the child-spawn cost, the rest are IPC.
 */

import path from "node:path";
import { Worker } from "node:worker_threads";
import { timeLeanArm } from "./arm-timing.js";

const CTRL_PENDING = 0;
const CTRL_READY = 1;
const HEADER_BYTES = 8;
/** Response cap: a walking leg's passes emit ≤ a few hundred points; 8 MiB
 *  is comfortably beyond any real payload. Oversize → fall back to TS. */
const SAB_BYTES = 8 * 1024 * 1024;
/** Timeout for a WARM call (child already running). The geometry passes answer
 *  in well under a millisecond, but the walk matcher (`LEAN_MATCH`) is a real
 *  computation — ~0.4 s per leg unthrottled, several seconds on the heaviest
 *  legs when the pod is CPU-throttled — so this is a genuine compute ceiling,
 *  not just a liveness one. A leg that exceeds it falls back to TS
 *  (swallow-over-wrong), which costs verified coverage on exactly the biggest
 *  legs, so the batch decode path (no user waiting) raises it via
 *  `LEAN_CALL_TIMEOUT_MS`; the interactive `/api/velocity` path leaves it tight
 *  so a slow leg never stalls a request. */
/** Read LAZILY, per call, not once at module load. A CLI that wants a different
 *  ceiling than the request path (`compare-match --gate`, whose legs are the
 *  heaviest in the corpus) can then set `LEAN_CALL_TIMEOUT_MS` during its own
 *  startup — after this module is imported, which ESM hoisting makes
 *  unavoidable — and still be honoured. As a module-load const the assignment
 *  was simply ignored, so the caller silently got 5 s. */
export function callTimeoutMs(): number {
	return Number(process.env.LEAN_CALL_TIMEOUT_MS) || 5000;
}
/** Timeout for the FIRST call over a freshly (re)built worker: it must absorb
 *  the cold `verified_cli serve` spawn — ~1.5 s idle, but several times that on
 *  a CPU-throttled pod under load. A tight 5 s here risks tripping the breaker
 *  on a cold start and dropping to TS-only for the whole process lifetime; the
 *  headroom only ever applies to the one cold call (warm calls stay at 5 s). */
const FIRST_CALL_TIMEOUT_MS = 20000;

/** The cold ceiling is a FLOOR added to the warm one, never a cap on it. A
 *  caller that raised `LEAN_CALL_TIMEOUT_MS` did so because its own calls are
 *  known to take longer than the default — the HSMM decode is 7–8 s per day in
 *  production — and the cold call is that same work PLUS the child spawn, so
 *  handing it a smaller budget than the warm calls it precedes is backwards. As
 *  a bare 20 s constant it was latent (the matcher's heaviest leg is 4.8 s, so
 *  nothing had yet asked for more than 20 s); the HSMM tenant is the first
 *  caller for which the cold call is the most expensive one it will make. */
export function firstCallTimeoutMs(): number {
	return Math.max(FIRST_CALL_TIMEOUT_MS, callTimeoutMs());
}

export class LeanBridgeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LeanBridgeError";
	}
}

function defaultBin(): string {
	return process.env.LEAN_CLI ?? path.join(process.cwd(), "lean", ".lake", "build", "bin", "verified_cli");
}

/** After this many CONSECUTIVE failures (with no success between), stop
 *  rebuilding and fall back to TS permanently — bounds rebuild thrash when the
 *  binary is genuinely missing/broken, while a lone transient blip (a cold
 *  first-call timeout) stays recoverable. */
const MAX_CONSECUTIVE_FAILS = 3;

class LeanCore {
	private worker: Worker | null = null;
	private control: Int32Array | null = null;
	private lenView: Int32Array | null = null;
	private body: Uint8Array | null = null;
	/** Permanent give-up (only after MAX_CONSECUTIVE_FAILS). */
	private dead = false;
	private fails = 0;
	/** False until this worker has answered once — gates the cold vs warm
	 *  call timeout. A fresh (re)built worker is cold; reset in `teardown`. */
	private warm = false;
	/** Last health state announced, so we log serve↔degrade TRANSITIONS (a
	 *  transient blip that recovers should not leave a stale "falling back"). */
	private lastServing: boolean | null = null;

	/** Wire-format request counter. Lives HERE rather than in the worker because
	 *  the caller now serialises the request line (see `callUncounted`); calls are
	 *  strictly serial — the caller blocks in `Atomics.wait` — so a plain counter
	 *  is enough and nothing correlates on it. It survives worker rebuilds, which
	 *  is what we want: an id must never be reused against a live child. */
	private reqId = 0;

	private readonly decoder = new TextDecoder();

	/** Log serve↔fallback transitions so a long-lived server (which keeps no
	 *  per-call ledger) makes it observable whether the verified core is
	 *  serving or has fallen back to TS — and, crucially, whether it recovered. */
	private announce(serving: boolean, detail: string): void {
		if (this.lastServing === serving) return;
		this.lastServing = serving;
		if (serving) console.error(`lean-bridge: serving verified core (${detail})`);
		else console.error(`lean-bridge: degraded — falling back to TS (${detail})`);
	}

	/** Tear down the current worker (terminating its child) so the NEXT call
	 *  rebuilds a fresh worker over a fresh SharedArrayBuffer. Guarded by
	 *  identity so a late error/exit event from an already-replaced worker is a
	 *  no-op. A fresh SAB per rebuild is what makes recovery safe: a terminated
	 *  worker can never flip a control word the new call is waiting on. */
	private teardown(w: Worker | null): void {
		if (w !== null && this.worker !== w) return;
		if (this.worker) void this.worker.terminate();
		this.worker = null;
		this.control = null;
		this.lenView = null;
		this.body = null;
		this.warm = false;
	}

	/** Record a failure: tear down for rebuild, announce degraded, and trip the
	 *  permanent breaker only after MAX_CONSECUTIVE_FAILS in a row. Throws. */
	private fail(detail: string): never {
		this.fails += 1;
		this.teardown(null);
		if (this.fails >= MAX_CONSECUTIVE_FAILS) this.dead = true;
		this.announce(false, detail);
		throw new LeanBridgeError(detail);
	}

	/** Lazily start the worker + child. Returns false if the bridge has
	 *  permanently given up or the worker cannot be created. */
	private ensure(): boolean {
		if (this.dead) return false;
		if (this.worker) return true;
		try {
			const sab = new SharedArrayBuffer(SAB_BYTES);
			const workerUrl = new URL("./lean-core-worker.js", import.meta.url);
			const worker = new Worker(workerUrl, { workerData: { bin: defaultBin(), sab } });
			// A worker crash/exit tears down for rebuild (not permanent death) —
			// identity-guarded so it only affects THIS worker.
			worker.on("error", () => this.teardown(worker));
			worker.on("exit", () => this.teardown(worker));
			// Don't let the idle bridge keep the process (a CLI) alive; during a
			// call the main thread is blocked in Atomics.wait so it can't exit.
			worker.unref();
			this.worker = worker;
			this.control = new Int32Array(sab, 0, 1);
			this.lenView = new Int32Array(sab, 4, 1);
			this.body = new Uint8Array(sab, HEADER_BYTES);
			return true;
		} catch {
			this.worker = null;
			return false;
		}
	}

	/** True if the bridge can (currently) serve calls. */
	available(): boolean {
		return this.ensure();
	}

	/**
	 * Run one verified-core request synchronously. `mode` selects the
	 * handler (`"geo" | "match" | "rail" | "hsmm"`); `payload` is the
	 * mode-specific body (already quantised to 1e-7° integers). Returns the
	 * parsed `result` object, or throws `LeanBridgeError` on any failure. A
	 * single failure is recoverable: the worker is rebuilt on the next call.
	 */
	call(mode: string, payload: Record<string, unknown>): unknown {
		// The Lean half of the arm accounting (`arm-timing.ts`), measured here
		// because this is the one point every tenant already funnels through and
		// the request carries the mode that names it. A wrapper-by-wrapper version
		// would have needed ten edits and — the reason that matters — a new tenant
		// would arrive silently untimed.
		return timeLeanArm(mode, () => this.callUncounted(mode, payload));
	}

	private callUncounted(mode: string, payload: Record<string, unknown>): unknown {
		if (!this.ensure() || !this.worker || !this.control || !this.lenView || !this.body) {
			this.fail("worker unavailable");
		}
		// Capture as locals: the guard narrowed these non-null, but the
		// intermediate `this.fail()` calls below are method calls that would
		// otherwise invalidate the property narrowing.
		const worker = this.worker;
		const control = this.control;
		const lenView = this.lenView;
		const body = this.body;
		Atomics.store(control, 0, CTRL_PENDING);
		// Serialise HERE, and post the finished line. Posting `{mode, payload}`
		// instead would structured-clone the whole payload object graph into the
		// worker and stringify it there, materialising the request twice — 187 MB
		// of peak RSS on the HSMM tenant's 33–40 MiB payload (#410). A string
		// clone is one copy, and the worker then only writes it.
		this.reqId += 1;
		worker.postMessage(JSON.stringify({ id: this.reqId, mode, ...payload }));
		const timeout = this.warm ? callTimeoutMs() : firstCallTimeoutMs();
		const woke = Atomics.wait(control, 0, CTRL_PENDING, timeout);
		if (woke === "timed-out") this.fail("call timed out");
		const status = Atomics.load(control, 0);
		if (status !== CTRL_READY) this.fail(`error status ${status}`);
		const len = Atomics.load(lenView, 0);
		// Copy out of the shared buffer before decoding (TextDecoder refuses
		// SharedArrayBuffer-backed views).
		const copy = body.slice(0, len);
		const result = JSON.parse(this.decoder.decode(copy));
		this.fails = 0;
		this.warm = true;
		this.announce(true, `bin=${defaultBin()}`);
		return result;
	}
}

/** Process-wide singleton: one persistent worker + `verified_cli serve`
 *  child per process. */
export const leanCore = new LeanCore();

/** Result shape of a `geo` display pass (mirrors `verified_cli geo`). */
export interface LeanGeoResp {
	keep?: number[];
	pts?: number[][];
	error?: string;
}

/**
 * Run one geometry display pass through the verified core, synchronously.
 * `req` is the same object `compare-geo` sends (e.g.
 * `{ op: "simplify", tol, pts }`) — a drop-in for the spawn-based
 * `leanGeo` there, but over the persistent worker. Points must already be
 * the pinned 1e-7° integer rows.
 */
export function leanGeo(req: Record<string, unknown>): LeanGeoResp {
	return leanCore.call("geo", req) as LeanGeoResp;
}

/** Result shape of a `match` walk-matcher pass (mirrors `verified_cli match`
 *  and the `serveLoop` `matchResult` handler): quantised path + coarse vertex
 *  rows, or `none` when the leg cannot be matched. */
export interface LeanMatchResp {
	path?: number[][];
	coarse?: number[][];
	none?: boolean;
	error?: string;
}

/**
 * Run one verified walk-match through the persistent core, synchronously.
 * `req` is the same object `compare-match` sends
 * (`{ fixes, ways, buildings }`, all quantised 1e-7° integer rows) — a
 * drop-in for the spawn-based `verified_cli match`, but over the long-lived
 * worker so the request path pays no per-call process spawn. Throws
 * `LeanBridgeError` on any bridge failure; the caller falls back to TS.
 */
export function leanMatchServe(req: Record<string, unknown>): LeanMatchResp {
	return leanCore.call("match", req) as LeanMatchResp;
}

/** Result shape of a `rail` shortest path (mirrors `verified_cli rail` and the
 *  `serveLoop` `railResult` handler): the settled vertex sequence and its
 *  distance, or `none` when the two vertices are disconnected.
 *
 *  Unlike `geo` and `match`, nothing here is a coordinate — `path` is a list of
 *  vertex indices into the caller's own graph, so an `on`-mode flip serves an
 *  EXACT sequence with no dequantisation step and no sub-millimetre drift. The
 *  only thing quantisation can change is WHICH path wins a near-tie on weight. */
export interface LeanRailResp {
	path?: number[];
	dist?: number;
	none?: boolean;
	error?: string;
}

/**
 * Run one verified rail shortest path through the persistent core,
 * synchronously. `req` is the same object `compare-rail` sends
 * (`{ adj, src, dst }`, adjacency already quantised to ×2²⁰ integers, in the
 * TS builder's per-vertex insertion order). Throws `LeanBridgeError` on any
 * bridge failure; the caller falls back to TS.
 */
export function leanRailServe(req: Record<string, unknown>): LeanRailResp {
	return leanCore.call("rail", req) as LeanRailResp;
}

/** Result shape of an `hsmm` decode (mirrors `verified_cli`'s one-shot decode
 *  and the `serveLoop` `hsmmResult` handler): the decoded state-index path and
 *  its integer score, or `degenerate` when no path has finite score.
 *
 *  Nothing here is a coordinate or a real — `path` indexes the caller's own
 *  state list and `best` is the quantised score in the same integer units the
 *  request carried — so the comparison is EXACT with no near-tie class to
 *  grade. The near-ties this tenant does have live one layer up, between the
 *  quantised decode and the FLOAT decode production ships, and the shadow
 *  measures that separately. */
export interface LeanHsmmResp {
	path?: number[];
	best?: number;
	degenerate?: boolean;
	error?: string;
}

/**
 * Run one verified HSMM decode through the persistent core, synchronously.
 * `req` is the quantised trellis (`{ T, S, maxD, emit, trans, dur, init,
 * entry, … }`) — the same object the spawn path wrote to `verified_cli`'s
 * stdin. Throws `LeanBridgeError` on any bridge failure; the caller falls back
 * to TS.
 *
 * BY FAR the heaviest request any tenant sends: 33–40 MiB per day against the
 * matcher's kilobytes (measured over the 11 decode fixtures, 2026-08-02),
 * because the whole quantised model crosses the wire to decode 1440 minutes.
 * The reply is the opposite — ~1440 integers — so it is nowhere near the 8 MiB
 * response cap. That asymmetry is the tenant's defining cost, and deleting it
 * is what `verified_cli assembledecode` (Lean builds the model from raw inputs)
 * exists for; this wrapper still ships the marshalled tensors.
 */
export function leanHsmmServe(req: Record<string, unknown>): LeanHsmmResp {
	return leanCore.call("hsmm", req) as LeanHsmmResp;
}

/** Result shape of a `stationchain` resolve (mirrors `verified_cli stationchain`
 *  and the `serveLoop` `stationChainResult` handler): one
 *  `[segIndex, board, alight]` row per train leg the resolver could name a side
 *  of, with `null` for a side that stayed below the confidence gate.
 *
 *  Legs with NEITHER side resolved are absent rather than present-with-nulls,
 *  exactly as the TS `Map` omits them — so the row count is not the leg count,
 *  and comparing lengths alone would call two different resolutions equal. */
export interface LeanStationChainResp {
	resolved?: Array<[number, string | null, string | null]>;
	error?: string;
}

/**
 * Run one verified station-chain resolve through the persistent core,
 * synchronously. `req` is what `encodeStationChainRequest` builds — the route
 * graph, the day's observation tensor, its segments and the rail-stop
 * relations. Throws `LeanBridgeError` on any bridge failure; the caller falls
 * back to TS.
 *
 * The second-heaviest request any tenant sends: 2.87 MiB per day mean over the
 * eleven decode fixtures (3.31 max, measured 2026-08-10), against the HSMM
 * tenant's 33–40 (#411) and the day fold's 0.35 (#424). 81% of it is the route
 * graph, and `lean-station-chain.ts` records why that part cannot be pruned
 * without moving results. The reply is a handful of rows, so the asymmetry is
 * the same one #411 is about — just an order of magnitude smaller.
 */
export function leanStationChainServe(req: Record<string, unknown>): LeanStationChainResp {
	return leanCore.call("stationchain", req) as LeanStationChainResp;
}

/** Result shape of a `kalman` GPS filter (mirrors `verified_cli kalman` and the
 *  `serveLoop` `kalmanResult` handler): `[ts, latBits, lonBits, speedBits,
 *  bearingBits]` rows.
 *
 *  The only mode whose coordinates are NOT quantised. The filter is a
 *  covariance recursion over raw degrees, so its wire format carries IEEE-754
 *  bit patterns as decimal strings instead — see `float-bits.ts` for why a
 *  string and not a JSON number. Consequently an `on`-mode flip serves EXACTLY
 *  the doubles TS would have produced, or the ledger says it did not. */
export interface LeanKalmanResp {
	pts?: Array<[number, string, string, string, string]>;
	error?: string;
}

/**
 * Run one verified GPS Kalman filter over a whole day's track through the
 * persistent core, synchronously. `req` is `{ pts: [[ts, latBits, lonBits,
 * accBits|null], …] }`. Throws `LeanBridgeError` on any bridge failure; the
 * caller falls back to TS.
 */
export function leanKalmanServe(req: Record<string, unknown>): LeanKalmanResp {
	return leanCore.call("kalman", req) as LeanKalmanResp;
}

/** Result shape of a `gpsquality` pre-filter pass (mirrors `verified_cli
 *  gpsquality` and the `serveLoop` `gpsQualityResult` handler): the SURVIVING
 *  `[ts, latBits, lonBits, accBits|null]` rows.
 *
 *  Same bit transport as `kalman`, but nothing here is computed — every row is
 *  a copy of an input row, so the response is a pure selection. That is what
 *  makes its gate sharper: there is no numeric near-tie class, only agreement
 *  or disagreement about which fixes are real. */
export interface LeanGpsQualityResp {
	pts?: Array<[number, string, string, string | null]>;
	error?: string;
}

/**
 * Run one verified GPS quality pre-filter over a whole day's track through the
 * persistent core, synchronously. `req` is `{ pts: [[ts, latBits, lonBits,
 * accBits|null], …] }`. Throws `LeanBridgeError` on any bridge failure; the
 * caller falls back to TS.
 */
export function leanGpsQualityServe(req: Record<string, unknown>): LeanGpsQualityResp {
	return leanCore.call("gpsquality", req) as LeanGpsQualityResp;
}

/** One segment's verdict from a `biolabels` pass: `null` is "unchanged",
 *  otherwise `[newMode, reasonFragment, refinedKind|null]`.
 *
 *  The reason is the FRAGMENT to append, not the final string — the TS passes
 *  join onto any existing `refinedReason` with `"; "`, and that concatenation
 *  stays in the shell. */
export type LeanLabelDecision = null | [string, string, string | null];

/** Result shape of a `biolabels` pass (mirrors `verified_cli biolabels` and
 *  the `serveLoop` `bioLabelsResult` handler): one decision per input segment,
 *  in order.
 *
 *  `runs` is present only for the `walkthrough` pass — the merge plan as
 *  `[start, end)` ranges over the decided sequence, since that pass also
 *  coalesces adjacent walking. Every other pass leaves the sequence alone.
 *
 *  Nothing here is a computed real: the decisions are labels and the reason
 *  strings are `toFixed` renderings, so the comparison is EXACT with no
 *  bounded-ULP class to grade. */
export interface LeanBioLabelsResp {
	decisions?: LeanLabelDecision[];
	runs?: Array<[number, number]>;
	error?: string;
}

/**
 * Run one verified biometric label-rewrite pass over a whole day's segments
 * through the persistent core, synchronously. `req` carries the pass name, the
 * segments, the day's step rows and (for `walkthrough`) the filtered fixes.
 * Throws `LeanBridgeError` on any bridge failure; the caller falls back to TS.
 */
export function leanBioLabelsServe(req: Record<string, unknown>): LeanBioLabelsResp {
	return leanCore.call("biolabels", req) as LeanBioLabelsResp;
}

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
const CALL_TIMEOUT_MS = Number(process.env.LEAN_CALL_TIMEOUT_MS) || 5000;
/** Timeout for the FIRST call over a freshly (re)built worker: it must absorb
 *  the cold `verified_cli serve` spawn — ~1.5 s idle, but several times that on
 *  a CPU-throttled pod under load. A tight 5 s here risks tripping the breaker
 *  on a cold start and dropping to TS-only for the whole process lifetime; the
 *  headroom only ever applies to the one cold call (warm calls stay at 5 s). */
const FIRST_CALL_TIMEOUT_MS = 20000;

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
		worker.postMessage({ mode, payload });
		const timeout = this.warm ? CALL_TIMEOUT_MS : FIRST_CALL_TIMEOUT_MS;
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

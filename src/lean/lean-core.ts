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
const CALL_TIMEOUT_MS = 5000;

export class LeanBridgeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LeanBridgeError";
	}
}

function defaultBin(): string {
	return process.env.LEAN_CLI ?? path.join(process.cwd(), "lean", ".lake", "build", "bin", "verified_cli");
}

class LeanCore {
	private worker: Worker | null = null;
	private control: Int32Array | null = null;
	private lenView: Int32Array | null = null;
	private body: Uint8Array | null = null;
	private dead = false;
	private announced = false;
	private readonly decoder = new TextDecoder();

	/** Emit a single process-lifetime line the first time the bridge either
	 *  serves or fails — so a long-lived server (which keeps no per-call
	 *  ledger) still makes it observable in its logs whether the verified core
	 *  is actually serving or has silently fallen back to TS. */
	private announce(serving: boolean, detail: string): void {
		if (this.announced) return;
		this.announced = true;
		if (serving) console.error(`lean-bridge: serving verified core (${detail})`);
		else console.error(`lean-bridge: unavailable — falling back to TS (${detail})`);
	}

	/** Lazily start the worker + child. Returns false (permanently) if the
	 *  worker cannot be created. */
	private ensure(): boolean {
		if (this.dead) return false;
		if (this.worker) return true;
		try {
			const sab = new SharedArrayBuffer(SAB_BYTES);
			const workerUrl = new URL("./lean-core-worker.js", import.meta.url);
			const worker = new Worker(workerUrl, { workerData: { bin: defaultBin(), sab } });
			worker.on("error", () => {
				this.dead = true;
			});
			worker.on("exit", () => {
				this.dead = true;
			});
			// Don't let the idle bridge keep the process (a CLI) alive; during a
			// call the main thread is blocked in Atomics.wait so it can't exit.
			worker.unref();
			this.worker = worker;
			this.control = new Int32Array(sab, 0, 1);
			this.lenView = new Int32Array(sab, 4, 1);
			this.body = new Uint8Array(sab, HEADER_BYTES);
			return true;
		} catch {
			this.dead = true;
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
	 * parsed `result` object, or throws `LeanBridgeError` on any failure.
	 */
	call(mode: string, payload: Record<string, unknown>): unknown {
		if (!this.ensure() || !this.worker || !this.control || !this.lenView || !this.body) {
			this.announce(false, "worker unavailable");
			throw new LeanBridgeError("lean bridge unavailable");
		}
		const control = this.control;
		Atomics.store(control, 0, CTRL_PENDING);
		this.worker.postMessage({ mode, payload });
		const woke = Atomics.wait(control, 0, CTRL_PENDING, CALL_TIMEOUT_MS);
		if (woke === "timed-out") {
			this.dead = true;
			this.announce(false, "call timed out");
			throw new LeanBridgeError("lean bridge timed out");
		}
		const status = Atomics.load(control, 0);
		if (status !== CTRL_READY) {
			this.announce(false, `error status ${status}`);
			throw new LeanBridgeError(`lean bridge error status ${status}`);
		}
		const len = Atomics.load(this.lenView, 0);
		// Copy out of the shared buffer before decoding (TextDecoder refuses
		// SharedArrayBuffer-backed views).
		const copy = this.body.slice(0, len);
		const result = JSON.parse(this.decoder.decode(copy));
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

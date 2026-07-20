/**
 * Worker thread for the synchronous Lean bridge (`lean-core.ts`).
 *
 * Owns one long-lived `verified_cli serve` child process and answers the
 * main thread's synchronous requests: it writes each request as an NDJSON
 * line to the child's stdin, awaits the child's NDJSON response line, copies
 * the `result` into the shared response buffer, and flips the Atomics
 * control word the main thread is blocked on.
 *
 * The main thread blocks (`Atomics.wait`) while THIS thread does the async
 * child I/O, so the deep synchronous pass call sites in the velocity
 * pipeline stay synchronous — no async ripple. One request is ever in
 * flight at a time (the caller blocks per call), so the child's response
 * stream is strictly one-line-per-request.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { parentPort, workerData } from "node:worker_threads";

const CTRL_READY = 1;
const CTRL_ERROR = 2;
const CTRL_TOOBIG = 3;
const HEADER_BYTES = 8;

interface InitData {
	bin: string;
	sab: SharedArrayBuffer;
}

const { bin, sab } = workerData as InitData;
const control = new Int32Array(sab, 0, 1);
const lenView = new Int32Array(sab, 4, 1);
const body = new Uint8Array(sab, HEADER_BYTES);
const encoder = new TextEncoder();

let child: ChildProcessWithoutNullStreams | null = null;
let dead = false;
let reqId = 0;

// Newline-framed reader over the child's stdout. Serial requests ⇒ at most
// one response line outstanding, but a line can arrive before `nextLine`
// is called, so completed lines queue.
let buf = "";
const lineQueue: string[] = [];
const lineWaiters: ((line: string | null) => void)[] = [];

function pushLine(line: string): void {
	const w = lineWaiters.shift();
	if (w) w(line);
	else lineQueue.push(line);
}

function nextLine(): Promise<string | null> {
	const q = lineQueue.shift();
	if (q !== undefined) return Promise.resolve(q);
	if (dead) return Promise.resolve(null);
	return new Promise((res) => lineWaiters.push(res));
}

function failWaiters(): void {
	while (lineWaiters.length) {
		const w = lineWaiters.shift();
		if (w) w(null);
	}
}

function signal(status: number): void {
	Atomics.store(control, 0, status);
	Atomics.notify(control, 0);
}

function respond(result: unknown): void {
	const enc = encoder.encode(JSON.stringify(result ?? null));
	if (enc.length > body.length) {
		signal(CTRL_TOOBIG);
		return;
	}
	body.set(enc, 0);
	Atomics.store(lenView, 0, enc.length);
	signal(CTRL_READY);
}

function startChild(): void {
	child = spawn(bin, ["serve"], { stdio: ["pipe", "pipe", "pipe"] });
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buf += chunk;
		let idx = buf.indexOf("\n");
		while (idx >= 0) {
			const line = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
			if (line.length) pushLine(line);
			idx = buf.indexOf("\n");
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (c: string) => process.stderr.write(`[lean-core] ${c}`));
	child.on("exit", () => {
		dead = true;
		failWaiters();
	});
	child.on("error", () => {
		dead = true;
		failWaiters();
	});
}

parentPort?.on("message", (msg: { mode: string; payload: Record<string, unknown> }) => {
	void (async () => {
		try {
			if (dead || !child) {
				signal(CTRL_ERROR);
				return;
			}
			reqId += 1;
			const req = JSON.stringify({ id: reqId, mode: msg.mode, ...msg.payload });
			child.stdin.write(`${req}\n`);
			const line = await nextLine();
			if (line === null) {
				signal(CTRL_ERROR);
				return;
			}
			const parsed = JSON.parse(line) as { result?: unknown; error?: string };
			if (parsed.error !== undefined) {
				signal(CTRL_ERROR);
				return;
			}
			respond(parsed.result);
		} catch {
			signal(CTRL_ERROR);
		}
	})();
});

startChild();

/**
 * What does consulting Lean cost when Lean does NOTHING? (#405)
 *
 * The arm ratios (#404) came out inverse to how much work the call does:
 *
 *   match       185 calls   ts 11183ms  lean 50160ms    4.5x
 *   gpsquality   32 calls   ts   1.7ms  lean   359ms  212.8x
 *
 * The matcher — the only tenant where consulting Lean is a real computation —
 * is the CHEAPEST. That points at the crossing rather than the core, and the
 * difference is load-bearing: under the Rust-shell architecture there IS no
 * crossing (the call is a function call in one process), so cost below the
 * transport floor is an artifact of today's staging rather than a property of
 * the verified code. "Points at" is not a measurement, hence this.
 *
 * ## The three layers, and why one ablation is not enough
 *
 * A call has four parts, and only the last one survives the architecture:
 *
 *   1. request wire   JSON.stringify → SharedArrayBuffer → Lean's `Json.parse`
 *   2. response wire  Lean's `resp.compress` → SAB → the caller's `JSON.parse`
 *   3. per-mode decode  generic `Json` → the tenant's own structures, which for
 *                       gpsquality/kalman means a decimal-string → UInt64 →
 *                       Float parse PER COORDINATE (`float-bits.ts`, `fBits`)
 *   4. the verified algorithm
 *
 * So there are three ablation handlers in `Main.lean`'s `serveLoop`, each
 * stopping one layer later, and the differences isolate the layers:
 *
 *   noop      parses the request, returns `{}`          → layer 1
 *   echo      returns the input rows verbatim            → +layer 2
 *   gqdecode  runs gpsquality's own `parseKalmanPt`      → +layer 3
 *   gpsquality  the real handler                         → +layer 4
 *
 * Measuring with `noop` ALONE gets the answer wrong, and wrong in the
 * reassuring direction: it charges the response wire and the string decode to
 * the algorithm, which made the floor look like a quarter of the call when it
 * is closer to seven eighths.
 *
 * ## Caveat that limits what this can conclude
 *
 * The payloads here are SYNTHETIC — smooth, regular tracks, not real jittery
 * GPS. Layers 1–3 are size-driven and so are faithful; layer 4 is data-driven
 * and a real track may exercise different branches of the filter. Treat the
 * verified-algorithm figure as an order of magnitude, not a measurement of the
 * corpus, and do not quote it to more precision than that.
 *
 * The row sweep separates fixed per-call cost (IPC wakeup, control word) from
 * per-ROW cost (encode, copy, parse) — only the second says whether the WIRE
 * FORMAT is the lever. The two shapes are chosen to isolate exactly that:
 *
 *   geo        `[la, lo, ts]`                    — three JSON integers
 *   gpsquality `[ts, "latBits", "lonBits", …]`   — bit patterns as decimal
 *                                                  strings, ~2.4x the bytes
 *
 * Not a gate. A measurement tool: prints a table and exits 0.
 */

import { performance } from "node:perf_hooks";
import { floatToBits } from "../lean/float-bits.js";
import { leanCore } from "../lean/lean-core.js";

/** Row counts to sweep. The upper end is a real day's track — the corpus days
 *  ran 520–1254 input fixes through `gpsquality`. */
const SIZES = [1, 10, 100, 500, 1000];

/** Calls per (mode, size) cell. The bridge is synchronous and warm after the
 *  first call, so this is about beating clock granularity, not about averaging
 *  away scheduler noise. */
const REPS = 30;

/** Discarded before timing: the FIRST call over a fresh worker pays the
 *  `verified_cli serve` spawn (~1.5 s), which is a startup cost and not a
 *  per-call one. Folding it in would inflate the floor by the whole spawn. */
const WARMUP = 3;

type Row = number[] | (number | string | null)[];

/** `geo` wire shape: quantised 1e-7° integers, exactly what `rows()` in
 *  lean-passes.ts sends. */
function geoRows(n: number): Row[] {
	const out: Row[] = [];
	for (let i = 0; i < n; i++) out.push([515000000 + i * 137, -1200000 - i * 91, 1750000000 + i * 60]);
	return out;
}

/** `gpsquality` wire shape: `[ts, latBits, lonBits, accBits|null]` with the
 *  three coordinates as decimal-string bit patterns. */
function bitRows(n: number): Row[] {
	const out: Row[] = [];
	for (let i = 0; i < n; i++) {
		out.push([
			1750000000 + i * 60,
			floatToBits(51.5 + i * 1e-5),
			floatToBits(-0.12 - i * 1e-5),
			i % 7 === 0 ? null : floatToBits(12.5 + (i % 30)),
		]);
	}
	return out;
}

interface Cell {
	totalMs: number;
	bytes: number;
	/** Bytes of the RESPONSE — the half `noop` does not exercise. */
	respBytes: number;
}

function timeCall(payload: Record<string, unknown>, mode: string): Cell {
	const bytes = JSON.stringify(payload).length;
	let last: unknown;
	for (let i = 0; i < WARMUP; i++) last = leanCore.call(mode, payload);
	const t0 = performance.now();
	for (let i = 0; i < REPS; i++) leanCore.call(mode, payload);
	return { totalMs: performance.now() - t0, bytes, respBytes: JSON.stringify(last ?? {}).length };
}

const ms = (x: number): string => (x < 10 ? x.toFixed(2) : x.toFixed(1));

function main(): void {
	if (!leanCore.available()) {
		console.error("bench-bridge: no verified core available (set LEAN_CLI). Nothing measured.");
		process.exitCode = 1;
		return;
	}

	console.log(`bench-bridge: ${REPS} calls per cell, ${WARMUP} discarded warmup, times are PER CALL\n`);

	// Two payload shapes, each measured against its real handler and against the
	// do-nothing handler. The `noop` column is the same bytes over the same wire
	// — only the algorithm differs.
	const shapes = [
		{
			name: "geo/simplify",
			real: "geo",
			rows: geoRows,
			req: (r: Row[]) => ({ op: "simplify", tol: 5_000_000, pts: r }),
		},
		{ name: "gpsquality", real: "gpsquality", rows: bitRows, req: (r: Row[]) => ({ pts: r }) },
	];

	// gpsquality gets the full three-layer decomposition. It is the tenant with
	// the worst ratio (213x) and the one whose wire format is most suspect —
	// three decimal-string doubles per row — so it is where the question "is
	// this the bridge or is this Lean?" actually has to be answered.
	console.log("── gpsquality, decomposed (n=1000, a real day's track)");
	{
		const payload = { pts: bitRows(1000) };
		const noop = timeCall(payload, "noop").totalMs / REPS;
		const echo = timeCall(payload, "echo").totalMs / REPS;
		const decode = timeCall(payload, "gqdecode").totalMs / REPS;
		const real = timeCall(payload, "gpsquality").totalMs / REPS;
		const respSide = echo - noop;
		// What survives into the Rust-shell world: everything the verified filter
		// does, with the request wire, the response wire and the per-row string
		// decode all removed.
		const algo = real - decode - respSide;
		const row = (label: string, v: number, note: string): void =>
			console.log(
				`   ${label.padEnd(26)}${ms(v).padStart(8)}ms  ${((100 * v) / real).toFixed(0).padStart(3)}%   ${note}`,
			);
		row("request wire + Json.parse", noop, "gone under a Rust shell");
		row("response wire", respSide, "gone under a Rust shell");
		row("per-row string→Float decode", decode - noop, "gone under a Rust shell");
		row("VERIFIED FILTER", algo, "the only part that survives");
		console.log(`   ${"= total".padEnd(26)}${ms(real).padStart(8)}ms`);
		console.log(`   TS arm for the same work: ~0.05ms/call (1.7ms over 32 corpus days)\n`);
	}

	for (const shape of shapes) {
		console.log(`── ${shape.name}`);
		console.log("     rows    req B   resp B      noop      echo      real   floor share");
		for (const n of SIZES) {
			const payload = shape.req(shape.rows(n));
			// Request-side floor, request+response floor, and the real handler —
			// all over the identical payload, so the only difference is what Lean
			// does with it.
			const noop = timeCall(payload, "noop");
			const echo = timeCall(payload, "echo");
			const real = timeCall(payload, shape.real);
			const noopPer = noop.totalMs / REPS;
			const echoPer = echo.totalMs / REPS;
			const realPer = real.totalMs / REPS;
			// Reported as a RANGE because the two floors bracket the truth: the
			// honest one depends on how big this tenant's reply actually is, and
			// `resp B` is printed so the reader can see which end applies.
			const lo = realPer > 0 ? (100 * noopPer) / realPer : 0;
			const hi = realPer > 0 ? (100 * echoPer) / realPer : 0;
			console.log(
				`${String(n).padStart(9)}${String(real.bytes).padStart(9)}${String(real.respBytes).padStart(9)}` +
					`${ms(noopPer).padStart(10)}ms${ms(echoPer).padStart(8)}ms${ms(realPer).padStart(8)}ms` +
					`${`${lo.toFixed(0)}-${hi.toFixed(0)}%`.padStart(12)}`,
			);
		}
		console.log("");
	}

	console.log("floor share = how much of the call is transport + JSON rather than verified code.");
	console.log("  low end  = `noop` (request side only) — the right read when the reply is small.");
	console.log("  high end = `echo` (a real-sized reply crosses back) — the right read when the");
	console.log("             reply is the rows, as it is for gpsquality/kalman.");
	console.log("Under the Rust-shell architecture the floor is not paid at all — there is no crossing.");
}

main();

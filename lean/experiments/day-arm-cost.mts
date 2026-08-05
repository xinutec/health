/**
 * What a Lean `day` tenant would COST — the third gap of #431, measured.
 *
 * Gap 4 established that the day mode CAN serve: ask the fold what it wants
 * until it stops wanting, and the demand-driven tables produce the gate's day on
 * all 33 golden days (`day-serve-rounds.mts`). That made a tenant possible. It
 * said nothing about whether one is worth having, and #405 is the reason to
 * doubt it: four of five tenants there cost bridge CROSSING rather than
 * computation, and this one multiplies crossings by the dependency depth.
 *
 * So this times both arms over the same day, the way #404 required of every
 * other tenant.
 *
 * # The two arms
 *
 * The TS arm is `phaseTimes.leanCovered` — the region a tenant would REPLACE,
 * bracketed in `velocity.ts` from `classifySegments`' output to the episodes.
 * Bracketed rather than summed from the phases because the phases do not tile
 * it. The physical-feasibility report sits inside the bracket and is NOT part of
 * the Lean day, so it is timed separately and subtracted.
 *
 * Two passes inside the bracket are then subtracted as well, and the ratio is
 * taken against what is left. `walkMatch` and `roadMatch` are the SHELLS: the
 * Lean day is handed no `walkEnv` / `roadEnv` (`compare-day.ts`'s `SHELLED`),
 * so it runs those passes and, given no matcher, writes nothing. Charging their
 * TS cost against a Lean arm that does not do the work would be measuring the
 * absence of a solver as a speed-up — and on a day with a long walk that pass
 * alone is half the region.
 *
 * They are not free in a flip, they are DEFERRED: either the matchers port too,
 * which is the 4.31 MiB/day of road and building rows gap 2 is about, or they
 * stay TS-side and the day is served by two arms. `ts_shell` is printed so the
 * size of that deferral stays visible.
 *
 * The walk matcher's share is measured by ABLATION — a second run with
 * `walkMatch: false`, and the difference — rather than read off its phase timer.
 * The phase timer is compute; the matcher also PREFETCHES its own OSM rows
 * (#333), and those reads land in the same adapter as the enrichment loop's. A
 * subtraction that took only the phase timer would leave the matcher's I/O
 * inside the region Lean is being compared against.
 *
 * The full run is timed FIRST, cold, and the ablated one second. Any warming
 * therefore flatters the ABLATED run, which makes the measured shell smaller,
 * `ts_net` larger and the ratio smaller. The bias runs against the conclusion
 * this is most likely to reach, which is the direction to be wrong in.
 *
 * The road matcher has no such switch, so it is subtracted by its phase timer
 * alone and its own reads stay inside `ts_osm`. It is the small one — the
 * corpus figure is printed so that stays checkable rather than asserted.
 *
 * The Lean arm is `rounds × fold + answers`:
 *
 *   fold      one converged `day` request through a WARM `serve` process, which
 *             is the transport the bridge already has. A fresh process per round
 *             would measure Lean's startup, which no tenant pays.
 *   noop      the same payload to the `noop` mode. The serve loop parses the
 *             request BEFORE dispatching on mode, so this is read + `Json.parse`
 *             + a trivial reply: the REQUEST-side transport floor.
 *   answers   the lookups the rounds asked for, answered live from the row-set
 *             adapter. Not Lean's cost — production pays it in either arm — but
 *             it is where the over-fetch lands, so it is counted and shown.
 *
 * `rounds × fold` is an UPPER bound: the tables grow, so early rounds carry a
 * smaller payload than the converged one this times. The bound is the honest
 * direction — it cannot make the tenant look cheaper than it is.
 *
 * # `fold − noop` is NOT the verified algorithm, and must not be quoted as it
 *
 * #405 measured a call as FOUR layers — request wire, response wire, per-mode
 * decode of generic `Json` into the tenant's own structures, and the algorithm —
 * and only the last survives the Rust-shell architecture. It also recorded the
 * trap this file would otherwise walk into verbatim: *"measuring with `noop`
 * ALONE gets the answer wrong, and wrong in the reassuring direction"*, because
 * `{}` as a reply hides both the response wire and the decode. On gpsquality
 * that mistake would have read the floor as a quarter of the call when it was
 * seven eighths.
 *
 * `noop` is the only ablation the day mode has. So `fold − noop` is layers 2+3+4
 * together, and reading it as layer 4 OVERSTATES the verified code by however
 * much the response encode and `parseEnv`'s typed decode cost — which for a
 * multi-megabyte reply and six lookup tables is not a rounding error.
 *
 * Closing that needs two more handlers in `serveLoop`, the way `echo` and
 * `gqdecode` exist for gpsquality. Until they do, the split printed below is
 * "request transport" against "everything else", and the residual that a Rust
 * shell would actually pay is UNMEASURED for this tenant.
 *
 * # The TS arm's own split
 *
 * `ts_osm` is the union of the intervals the TS run spent inside the OSM
 * adapter — a union rather than a sum because the enrichment loop runs its
 * lookups concurrently, and summing would charge overlapping waits twice. It is
 * the whole run's, not just the covered region's: the stages above the bracket
 * make no OSM calls, and the feasibility block's `stationsOnLine` is the only
 * outside contribution.
 *
 * The split matters for reading the ratio. A covered region that is mostly I/O
 * cannot be made much faster by porting the computation, whichever language the
 * computation is in.
 *
 * Run: TMPDIR=/tmp npx tsx lean/experiments/day-arm-cost.mts [date...]
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { inputsFromFixture, parseCapturedDay } from "../../src/cli/fixture-day.js";
import type { ClassificationInputs } from "../../src/geo/classification-inputs.js";
import { computeVelocityFromInputs } from "../../src/geo/velocity.js";
import type { FoldCaptureFile } from "../../src/lean/fold-capture.js";
import { buildDayRequest } from "../../src/lean/fold-payload.js";
import { converge } from "./day-serve-lib.mjs";

const ROOT = path.join(import.meta.dirname, "../..");
const DAYS_DIR = path.join(ROOT, "tests/golden/days");
const CLI = path.join(ROOT, "lean/.lake/build/bin/verified_cli");

/** Timed repeats per mode. The median is reported: three is enough to drop a
 *  single scheduler outlier and not enough to characterise a tail, which is not
 *  what this question needs — the tail belongs to a soak, this is a ratio. */
const REPEATS = 3;

/** A warm `verified_cli serve` — one process, many requests, which is the
 *  transport a tenant would use and the one `lean-core.ts` already has.
 *
 *  Line-delimited JSON in both directions. `readline` rather than manual chunk
 *  splitting because a day response is megabytes and arrives in many chunks. */
class Serve {
	private readonly proc = spawn(CLI, ["serve"], { stdio: ["pipe", "pipe", "pipe"] });
	private readonly lines: AsyncIterator<string>;
	private id = 0;
	private stderr = "";

	constructor() {
		this.lines = createInterface({ input: this.proc.stdout, crlfDelay: Number.POSITIVE_INFINITY })[
			Symbol.asyncIterator
		]();
		// Kept, not discarded. It has to be consumed — an unread pipe fills and
		// blocks the child mid-reply, which would look like a slow fold — but a
		// `panic!` also lands here, and `daydecode`'s probes are only sound if they
		// HIT. A probe that missed would still return a number, so silence on this
		// stream is the only evidence that the tables were forced rather than
		// merely asked about.
		this.proc.stderr.on("data", (b: Buffer) => {
			this.stderr += b.toString();
		});
	}

	/** Anything the child complained about since the last call, and reset. */
	takeStderr(): string {
		const s = this.stderr;
		this.stderr = "";
		return s;
	}

	/** One request, one reply, wall time around both — INCLUDING the caller's
	 *  `JSON.parse` of the reply.
	 *
	 *  Parsing it is not optional for a tenant: a reply it has not decoded is a
	 *  reply it cannot use. Reading the line and dropping it timed the Lean arm
	 *  without the half of the response wire that lands on this side, and for the
	 *  day mode that reply is megabytes. */
	async ask(mode: string, req: object): Promise<{ ms: number; bytes: number }> {
		this.id += 1;
		const line = `${JSON.stringify({ ...req, mode, id: this.id })}\n`;
		const started = performance.now();
		this.proc.stdin.write(line);
		const { value, done } = await this.lines.next();
		if (done) throw new Error(`serve loop closed during ${mode}`);
		JSON.parse(value);
		return { ms: performance.now() - started, bytes: line.length };
	}

	close(): void {
		this.proc.stdin.end();
		this.proc.kill();
	}
}

/** `spawnSync` per round, for the convergence loop only. The rounds are driven
 *  by STDERR — `panic!` prints the key it wanted — and in a warm serve loop the
 *  two streams interleave with no marker saying which round a line belongs to.
 *  A fresh process per round makes that attribution exact. The COST numbers do
 *  not come from here; they come from the warm loop below. */
function runRound(req: unknown): { out: string; err: string } {
	const r = spawnSync(CLI, ["day"], {
		input: JSON.stringify(req),
		maxBuffer: 512 * 1024 * 1024,
		encoding: "utf8",
	});
	return { out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Wall time the TS run spent inside the OSM adapter, overlaps counted once.
 *
 *  The enrichment loop issues its lookups under `mapLimit`, so several are in
 *  flight at a time; a sum of durations would exceed the wall clock it is being
 *  compared against. Returns a function that unions what was recorded. */
function timeOsm(inputs: ClassificationInputs): () => number {
	const spans: [number, number][] = [];
	const osm = inputs.osm as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
	for (const name of [
		"nearbyWays",
		"nearbyStations",
		"nearbyLandmarks",
		"linesAtPoint",
		"nearbyTransitStops",
		"reverseGeocode",
		"stationsOnLine",
	]) {
		const orig = osm[name].bind(osm);
		osm[name] = async (...args: unknown[]) => {
			const started = performance.now();
			try {
				return await orig(...args);
			} finally {
				spans.push([started, performance.now()]);
			}
		};
	}
	return () => {
		spans.sort((a, b) => a[0] - b[0]);
		let total = 0;
		let openFrom = 0;
		let openTo = -1;
		for (const [from, to] of spans) {
			if (from > openTo) {
				total += Math.max(0, openTo - openFrom);
				openFrom = from;
				openTo = to;
			} else if (to > openTo) {
				openTo = to;
			}
		}
		return total + Math.max(0, openTo - openFrom);
	};
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

interface Outcome {
	date: string;
	tsCoveredMs: number;
	/** The shelled passes' share of it — deferred by a flip, not deleted. */
	tsShellMs: number;
	/** The road matcher's part of that, by phase timer, its I/O not separable. */
	tsRoadMs: number;
	/** OSM wall with the walk matcher ablated. Still carries the road matcher's
	 *  reads, bounded above by `tsRoadMs`. */
	tsOsmMs: number;
	rounds: number;
	/** `buildDayRequest` — paid once per round, like the fold. */
	encodeMs: number;
	foldMs: number;
	noopMs: number;
	/** The `daydecode` handler: layers 1+3 — request wire plus the typed decode. */
	decodeMs: number;
	answerMs: number;
	reqMiB: number;
	note?: string;
}

async function measure(file: string, serve: Serve): Promise<Outcome> {
	const date = file.slice(0, 10);
	const captured = parseCapturedDay(readFileSync(path.join(DAYS_DIR, file), "utf8"));
	const capDir = mkdtempSync(path.join(tmpdir(), "armcost-"));
	process.env.FOLD_CAPTURE = capDir;
	const inputs = inputsFromFixture(captured, "rows");

	let cap: FoldCaptureFile;
	let tsCoveredMs: number;
	let tsRoadMs: number;
	try {
		const res = await computeVelocityFromInputs(inputs);
		tsCoveredMs = res.timing.leanCovered ?? 0;
		tsRoadMs = res.timing.roadMatch ?? 0;
		cap = JSON.parse(readFileSync(path.join(capDir, readdirSync(capDir)[0]), "utf8")) as FoldCaptureFile;
	} finally {
		delete process.env.FOLD_CAPTURE;
	}

	// The ablation, on a FRESH adapter so the timing is not the first run's
	// warmed indexes. No capture: the request the Lean arm answers must come from
	// the pipeline as it really runs, not from one with a pass switched off.
	const ablated = inputsFromFixture(captured, "rows");
	const osmWall = timeOsm(ablated);
	const noWalk = await computeVelocityFromInputs(ablated, { walkMatch: false });
	const tsOsmMs = osmWall();
	// Clamped at zero: on a day with no walk to match the two runs differ only by
	// noise, and a negative "cost of the matcher" is not a measurement.
	const walkShellMs = Math.max(0, tsCoveredMs - (noWalk.timing.leanCovered ?? 0));

	const c = await converge(cap, captured, inputs.osm, async (req) => runRound(req));
	const base = {
		date,
		tsCoveredMs,
		tsShellMs: walkShellMs + tsRoadMs,
		tsRoadMs,
		tsOsmMs,
		rounds: c.rounds,
		encodeMs: 0,
		foldMs: 0,
		noopMs: 0,
		decodeMs: 0,
		answerMs: c.answerMs,
		reqMiB: 0,
	};
	if (c.failure !== undefined) return { ...base, note: c.failure };

	const { tzAt, bestPlace, partial } = c.tables;
	const fold: number[] = [];
	const noop: number[] = [];
	const decode: number[] = [];
	const encode: number[] = [];
	let bytes = 0;
	let req = {} as object;
	for (let i = 0; i < REPEATS; i++) {
		// Rebuilt each repeat because it is a per-ROUND cost, not a setup cost: a
		// serving day encodes its inputs and its grown tables again every time it
		// asks. Leaving it out of the Lean arm would price the fold and not the
		// tenant.
		const startedEncoding = performance.now();
		req = buildDayRequest({ ...cap, tzAt, bestPlace }, captured, partial) as object;
		encode.push(performance.now() - startedEncoding);
		const d = await serve.ask("day", req);
		fold.push(d.ms);
		bytes = d.bytes;
		noop.push((await serve.ask("noop", req)).ms);
		decode.push((await serve.ask("daydecode", req)).ms);
	}
	// A `panic!` from a `daydecode` probe means it asked a key the table does not
	// hold, which makes its timing a measurement of a miss rather than of the
	// table being built. Reported per day rather than tallied: the whole point of
	// the probes is that they hit, so one is a defect and not a statistic.
	const complained = serve.takeStderr().split("\n").find((l) => l.trim() !== "");
	return {
		...base,
		encodeMs: median(encode),
		foldMs: median(fold),
		noopMs: median(noop),
		decodeMs: median(decode),
		reqMiB: bytes / (1024 * 1024),
		note: complained,
	};
}

const only = new Set(process.argv.slice(2));
const files = readdirSync(DAYS_DIR)
	.filter((f) => f.endsWith(".json"))
	.filter((f) => only.size === 0 || only.has(f.slice(0, 10)))
	.sort();

const serve = new Serve();
const outcomes: Outcome[] = [];
for (const f of files) outcomes.push(await measure(f, serve));
serve.close();

/** What Lean is actually compared against: the covered region less the two
 *  passes it runs with no solver behind them. */
const tsNet = (o: Outcome): number => o.tsCoveredMs - o.tsShellMs;
const leanArm = (o: Outcome): number => o.rounds * (o.encodeMs + o.foldMs) + o.answerMs;

const n1 = (x: number): string => x.toFixed(1).padStart(8);
console.log(
	"\ndate         ts_cov ts_shell  ts_net  ts_osm  rnd   encode     fold     noop  decode   answer lean_tot   ratio",
);
for (const o of outcomes) {
	const net = tsNet(o);
	const ratio = net > 0 ? (leanArm(o) / net).toFixed(2) : "n/a";
	console.log(
		`${o.date} ${n1(o.tsCoveredMs)}${n1(o.tsShellMs)}${n1(net)}${n1(o.tsOsmMs)} ${String(o.rounds).padStart(4)}` +
			`${n1(o.encodeMs)}${n1(o.foldMs)}${n1(o.noopMs)}${n1(o.decodeMs)}${n1(o.answerMs)}${n1(leanArm(o))}` +
			`${ratio.padStart(8)}${o.note ? `  ${o.note}` : ""}`,
	);
}

const ok = outcomes.filter((o) => o.note === undefined && tsNet(o) > 0);
const sum = (f: (o: Outcome) => number): number => ok.reduce((a, o) => a + f(o), 0);
const s = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const lean = sum(leanArm);
const net = sum(tsNet);
console.log(`\n${ok.length} day(s) timed`);
console.log(
	`  TS arm      ${s(net)} net — ${s(sum((o) => o.tsCoveredMs))} covered less ${s(sum((o) => o.tsShellMs))} of shelled matchers,` +
		` of which ${s(sum((o) => o.tsRoadMs))} is the road matcher whose reads stay in ts_osm`,
);
console.log(`  of that net ${s(sum((o) => o.tsOsmMs))} is spent inside the OSM adapter`);
console.log(
	`  Lean arm    ${s(lean)} = ${s(sum((o) => o.rounds * o.encodeMs))} encode + ${s(sum((o) => o.rounds * o.foldMs))} fold` +
		` + ${s(sum((o) => o.answerMs))} answers`,
);
// #405's layers, as far as the day mode's two handlers can separate them.
// `daydecode` returns a count, so it carries layer 1 and layer 3 and none of
// layer 2; what is left over from the real handler is layers 2 and 4 together.
console.log(
	`  of the fold ${s(sum((o) => o.rounds * o.noopMs))} request wire, ` +
		`${s(sum((o) => o.rounds * (o.decodeMs - o.noopMs)))} typed decode, ` +
		`${s(sum((o) => o.rounds * (o.foldMs - o.decodeMs)))} response wire + algorithm`,
);
console.log(
	"  the last of those is the RESIDUAL a Rust shell would still pay, plus a response encode still inside it",
);
console.log(`  ratio       ${(lean / net).toFixed(2)}× — the Lean arm against the region it would replace`);
console.log(`  deferred    ${s(sum((o) => o.tsShellMs))} of matcher, which a flip moves rather than removes`);

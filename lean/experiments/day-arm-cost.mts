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
 * # The four layers, separated (#433)
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
 * Three handlers now cut the day mode at each seam:
 *
 *   noop        request wire only — read + `Json.parse` + a trivial reply.
 *   daydecode   + the typed decode: `dayResult`'s parse prefix, then stop.
 *   dayresp     + the algorithm: the whole chain, returning counts not rows.
 *   day         + the response side: the six row arrays, encoded and shipped.
 *
 * So `resp − decode` is the ALGORITHM and `fold − resp` is layer 2. Both
 * `daydecode` and `dayresp` are checked rather than trusted: the first must
 * return a count, and the second's counts are recomputed from the `day` reply
 * (`checkChainRan`), because a chain the compiler eliminated would otherwise
 * read as a cheap algorithm — the direction that flatters the port.
 *
 * # Layer 2 is small, and the reason is the payload asymmetry
 *
 * The task that asked for this predicted "a multi-megabyte reply is not free".
 * MEASURED, that premise is wrong: the request averages 2.4 MiB of lookup
 * tables and the reply 0.11 MiB of the day's own rows, so the response side is
 * a few ms and on some days sits below the noise floor. The harness prints the
 * sizes beside the times, and says how many days came out negative rather than
 * clamping them — a clamp would turn a sampling artefact into a measurement.
 *
 * # The ratio is the NOISY number here; the split is the stable one
 *
 * `ts_net` is remeasured live every run, so the ratio moves several tenths
 * between runs on the same commit. The layer percentages barely move. Quote the
 * split; treat the ratio as an order of magnitude.
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
import { converge } from "../../src/lean/day-serve.js";

const ROOT = path.join(import.meta.dirname, "../..");
const DAYS_DIR = path.join(ROOT, "tests/golden/days");
const CLI = path.join(ROOT, "lean/.lake/build/bin/verified_cli");

/** Timed repeats per mode. The median is reported: three is enough to drop a
 *  single scheduler outlier and not enough to characterise a tail, which is not
 *  what this question needs — the tail belongs to a soak, this is a ratio. */
// Raised from 3 when `dayresp` landed: layer 2 is a difference between two
// numbers that turn out to be close, so the median needs a wider sample before
// the subtraction says anything. It is still small enough that a day is timed
// in seconds.
const REPEATS = 5;

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
	async ask(mode: string, req: object): Promise<{ ms: number; bytes: number; reply: number; result: unknown }> {
		this.id += 1;
		const line = `${JSON.stringify({ ...req, mode, id: this.id })}\n`;
		const started = performance.now();
		this.proc.stdin.write(line);
		const { value, done } = await this.lines.next();
		if (done) throw new Error(`serve loop closed during ${mode}`);
		const parsed = JSON.parse(value) as { result?: unknown };
		// The reply is returned as well as timed, because `dayresp`'s counts are
		// only worth anything if something compares them against the `day` reply
		// they claim to summarise. Its SIZE is returned too: layer 2 is whatever
		// encoding and shipping those bytes costs, so the byte count is what makes
		// a small layer-2 number explicable rather than merely surprising.
		return { ms: performance.now() - started, bytes: line.length, reply: value.length, result: parsed.result };
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

/**
 * Did `dayresp` really run the chain, or did it return fast because the compiler
 * deleted work nothing consumed?
 *
 * This is the whole reason `dayresp` returns counts rather than `{}`. The
 * hazard is specific and was identified before the handler was written:
 * `let (states, episodes) := dayChain chain` is a pure `let`, so a handler that
 * returned only `changed` would force the pass fold, have its `dayChain` call
 * eliminated as dead code, and then report a duration for "the chain" that
 * never ran it. Nothing in the timings would look wrong — it would simply read
 * as a cheaper algorithm, which is the direction that flatters the port.
 *
 * So the counts are recomputed here from the FULL `day` reply and compared. A
 * chain that did not run cannot produce the timestamp sums, and a chain that
 * ran differently is caught for free. An unexplained mismatch voids the day's
 * layer-2 number rather than being averaged into it.
 */
function checkChainRan(day: unknown, summary: unknown): string | undefined {
	const d = day as Record<string, unknown[]> | undefined;
	const s = summary as Record<string, number> | undefined;
	if (d === undefined || s === undefined) return "dayresp: no reply to cross-check";
	if (typeof s.nStates !== "number") return `dayresp: ${JSON.stringify(summary).slice(0, 120)}`;
	const tsSum = (rows: unknown[] | undefined): number =>
		(rows ?? []).reduce<number>((a, r) => {
			const o = r as { startTs: number; endTs: number };
			return a + o.startTs + o.endTs;
		}, 0);
	const want: Record<string, number> = {
		nSplit: (d.segsSplit ?? []).length,
		nEnriched: (d.segsEnriched ?? []).length,
		nMid: (d.segsMid ?? []).length,
		nSegs: (d.segs ?? []).length,
		nStates: (d.states ?? []).length,
		nEpisodes: (d.episodes ?? []).length,
		nChanged: (d.changed ?? []).length,
		sumSegTs: tsSum(d.segs),
		sumStateTs: tsSum(d.states),
		sumEpisodeTs: tsSum(d.episodes),
		nEpisodePoints: (d.episodes ?? []).reduce<number>(
			(a, e) => a + ((e as { points: unknown[] }).points ?? []).length,
			0,
		),
	};
	const bad = Object.entries(want).filter(([k, v]) => s[k] !== v);
	if (bad.length === 0) return undefined;
	return `dayresp DISAGREES with day: ${bad.map(([k, v]) => `${k} ${s[k]} != ${v}`).join(", ")}`;
}

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
	/** The `dayresp` handler: the whole chain, no row encoding. `foldMs − respMs`
	 *  is the response side; `respMs − decodeMs` is the algorithm. */
	respMs: number;
	answerMs: number;
	reqMiB: number;
	/** The `day` reply's size. Layer 2 is the cost of building and shipping
	 *  exactly these bytes, so the byte count is what makes a near-zero layer-2
	 *  explicable rather than merely surprising. */
	replyMiB: number;
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

	const c = await converge(cap, inputs, inputs.osm, async (req) => runRound(req));
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
		respMs: 0,
		answerMs: c.answerMs,
		reqMiB: 0,
		replyMiB: 0,
	};
	if (c.failure !== undefined) return { ...base, note: c.failure };

	const { tzAt, bestPlace, partial } = c.tables;
	const fold: number[] = [];
	const noop: number[] = [];
	const decode: number[] = [];
	const resp: number[] = [];
	const encode: number[] = [];
	let bytes = 0;
	let replyBytes = 0;
	let req = {} as object;
	let mismatch: string | undefined;
	for (let i = 0; i < REPEATS; i++) {
		// Rebuilt each repeat because it is a per-ROUND cost, not a setup cost: a
		// serving day encodes its inputs and its grown tables again every time it
		// asks. Leaving it out of the Lean arm would price the fold and not the
		// tenant.
		const startedEncoding = performance.now();
		req = buildDayRequest({ ...cap, tzAt, bestPlace }, inputs, partial) as object;
		encode.push(performance.now() - startedEncoding);
		const d = await serve.ask("day", req);
		fold.push(d.ms);
		bytes = d.bytes;
		replyBytes = d.reply;
		noop.push((await serve.ask("noop", req)).ms);
		const dec = await serve.ask("daydecode", req);
		decode.push(dec.ms);
		// A handler that ERRORED returns fast and would read as a cheap decode,
		// which inflates everything downstream of it. `decodeOnly` returns a count,
		// so demanding one is enough to tell a real decode from a rejected request.
		const decN = (dec.result as { n?: number } | undefined)?.n;
		if (typeof decN !== "number") mismatch ??= `daydecode: ${JSON.stringify(dec.result).slice(0, 120)}`;
		const r = await serve.ask("dayresp", req);
		resp.push(r.ms);
		mismatch ??= checkChainRan(d.result, r.result);
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
		respMs: median(resp),
		reqMiB: bytes / (1024 * 1024),
		replyMiB: replyBytes / (1024 * 1024),
		note: complained ?? mismatch,
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
	"\ndate         ts_cov ts_shell  ts_net  ts_osm  rnd   encode     fold     noop  decode    resp   answer lean_tot   ratio",
);
for (const o of outcomes) {
	const net = tsNet(o);
	const ratio = net > 0 ? (leanArm(o) / net).toFixed(2) : "n/a";
	console.log(
		`${o.date} ${n1(o.tsCoveredMs)}${n1(o.tsShellMs)}${n1(net)}${n1(o.tsOsmMs)} ${String(o.rounds).padStart(4)}` +
			`${n1(o.encodeMs)}${n1(o.foldMs)}${n1(o.noopMs)}${n1(o.decodeMs)}${n1(o.respMs)}${n1(o.answerMs)}${n1(leanArm(o))}` +
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
// #405's four layers, now separated all the way. `noop` is layer 1, `daydecode`
// adds layer 3, `dayresp` adds layer 4, and what the real handler has over
// `dayresp` is layer 2. Only the algorithm survives a Rust shell.
console.log(
	`  of the fold ${s(sum((o) => o.rounds * o.noopMs))} request wire, ` +
		`${s(sum((o) => o.rounds * (o.decodeMs - o.noopMs)))} typed decode, ` +
		`${s(sum((o) => o.rounds * (o.foldMs - o.respMs)))} response wire, ` +
		`${s(sum((o) => o.rounds * (o.respMs - o.decodeMs)))} ALGORITHM`,
);
console.log(
	`  the algorithm is the only one a Rust shell still pays: ` +
		`${((sum((o) => o.rounds * (o.respMs - o.decodeMs)) / sum((o) => o.rounds * o.foldMs)) * 100).toFixed(0)}% of the fold`,
);
// Layer 2 is a difference between two close numbers, so some days come out
// NEGATIVE. That is not a cost, it is the noise floor showing through, and
// hiding it by clamping would turn a sampling artefact into a measurement. Both
// the count and the sizes are printed so the reader can see why it is small: the
// request is megabytes of tables, the reply is the day's own rows.
const negatives = ok.filter((o) => o.foldMs - o.respMs < 0).length;
console.log(
	`  payload     ${(sum((o) => o.reqMiB) / ok.length).toFixed(2)} MiB request vs ` +
		`${(sum((o) => o.replyMiB) / ok.length).toFixed(2)} MiB reply on average — which is why layer 2 is small`,
);
if (negatives > 0) {
	console.log(
		`  CAUTION     ${negatives}/${ok.length} day(s) put the response wire BELOW zero — at this size it is inside the` +
			` noise, so read it as "not distinguishable from free", not as a number`,
	);
}
console.log(`  ratio       ${(lean / net).toFixed(2)}× — the Lean arm against the region it would replace`);
console.log(`  deferred    ${s(sum((o) => o.tsShellMs))} of matcher, which a flip moves rather than removes`);

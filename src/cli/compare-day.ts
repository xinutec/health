/**
 * CLI: does the Lean day produce what the TS pipeline produced?
 *
 * Task #424 built this as an experiment, #426 made it a gate, #429 widened it
 * past the fold, #430 widened it before. FIVE Lean stages run in ONE
 * `verified_cli day` call:
 *
 *   `Verified.Geo.SplitFold`    the two biometric splits and the stay bridge,
 *                               between segmentation and the OSM enrichment loop
 *   `Verified.Geo.EnrichFold`   the OSM enrichment loop itself — the road naming
 *                               on a moving leg, the five-rule cascade on a stay
 *   `Verified.Geo.PreFold`      the five corrections between it and pass 1 —
 *                               cadence, its revert, the jitter demotion, the
 *                               biometric signature, the physical-impossibility
 *                               override
 *   `Verified.Geo.PassFold`     all 38 passes of `src/geo/velocity.ts` (#419)
 *   `Verified.Geo.DayChain`     the six stages after them — sleep-place
 *                               attribution, the state timeline, the dwell
 *                               continuation, the episode geometry
 *
 * ONE chain, as of #430 B2. It was two sub-chains for as long as the OSM
 * enrichment stage sat unported between the splits and the corrections; the
 * corrections had to start from what the TS arm handed them, because feeding the
 * splits' output straight in would have skipped a stage silently. `EnrichFold`
 * closed that gap, and the join was taken only after the `enrich.` boundary
 * measured identical on all 33 golden days — chaining first would have made the
 * comparison the thing feeding itself.
 *
 * So the Lean arm now takes ONE input, `classifySegments`' output, and runs it
 * through to the episodes. This replays the golden corpus through both arms and
 * compares SIX boundaries: the split stage's output (`split.`), the
 * enrichment's (`enrich.`), the corrections' (`pre.`), the fold's, the states
 * and the episodes. Five of the six are interior, and they are measured because
 * a difference at the earliest one explains every one below it — comparing only
 * the end would report the explanation as the finding.
 *
 * NOT the whole day. The quality filter, Kalman and segmentation upstream are
 * still unchained, and `lean/experiments/lean-coverage.mts` counts what that
 * leaves without any comparator.
 *
 * # Why it is a GATE and not a probe
 *
 * Nothing else in the repo asks whether a Lean port still matches the TS it
 * ports. Twice that cost a real day to notice: `pickBestStation` was stale
 * against the #373 fix (found by reading, #417), and the underground trio was
 * five commits and ~300 lines behind (found by a fold abort on the first real
 * day it ran, #425). The alternative considered was a timestamp sweep — flag any
 * `Verified/**.lean` older than a `src/**.ts` its docstring names — which
 * over-reports badly: a TS commit touching a file need not touch the ported
 * function, and 12 of the modules flagged that way were mostly fine.
 *
 * Running both arms on real days is the honest signal. A lookup MISS names the
 * key the fold asked about and the TS did not; a field difference names the
 * field.
 *
 * # The bar is ABSOLUTE, not a ratchet
 *
 * Unlike `walk-gate` and the golden truth rows, there is no blessed baseline to
 * drift against. Every day must be IDENTICAL or SHELL ONLY, where SHELL ONLY
 * means the ONLY differing fields are the three the declared solver shells
 * produce. A ratchet would let a divergence be blessed in, and a divergence
 * between two implementations of one algorithm is not a measurement to record —
 * it is one of them being wrong.
 *
 * # How a day is measured
 *
 *   1. Replay the fixture through `computeVelocityFromInputs` with
 *      `FOLD_CAPTURE` set. That writes what the corrections were handed, what
 *      the cascade was handed, what it produced, and the answers to the two
 *      callbacks no adapter sees (`fold-capture.ts`).
 *   2. Build the `day` request from that capture, the lookups THIS RUN's adapter
 *      answered, and the fixture's caches (`fold-payload.ts`).
 *   3. Run `verified_cli day` and compare its segments against the TS arm's,
 *      field by field.
 *
 * Both arms therefore start from the same input and answer from the same
 * lookups. What is left is the computation, which is the point: the wire format
 * was sized first (0.35 MiB/day steady state) so that this would not be a
 * measurement of the bridge.
 *
 * # Why the lookups are RECORDED and not read from `osmTrace`
 *
 * They used to be read from the fixture, and that was wrong (#428). Golden
 * replays with `osmSource: "rows"`, which gives the TS arm a `RowSetOsmAdapter`
 * that COMPUTES the four spatial lookups over raw OSM rows — any coordinate.
 * `osmTrace` is a fixed record from an older capture, so a trace-built table
 * gave the Lean arm a strictly smaller oracle: on 2026-06-15 the TS arm asked
 * `nearbyWays` about 69 distinct coordinates of which 4 were not in the trace,
 * and one of those four was exactly the key the fold aborted on.
 *
 * # A miss is a result, not an error — but read it carefully
 *
 * `LEAN_ABORT_ON_PANIC=1` is set for the child: an unanswered lookup aborts with
 * the key in the message rather than returning an empty answer that would read
 * as a real one.
 *
 * With the tables recorded, a miss means what it is supposed to mean: the Lean
 * fold asked a question the TS cascade did not, a wiring divergence that
 * comparing outputs alone would not localise. Before that it could ALSO mean the
 * encoder had handed Lean a narrower oracle, and the two are not distinguishable
 * from the message. Any miss recorded before #428 landed has to be re-read.
 *
 * # Attributing a difference to a PASS is not something this can do
 *
 * The obvious version does not work: walking `trace` and reporting the first pass
 * whose output differs at the segment's index reports the FIRST pass every time,
 * because passes split and merge, so index 15 after the fold is not index 15
 * before it. That was written, it confidently said `stationaryCoherence`, and it
 * was an artefact. Attribution needs leg identity rather than an index (#409).
 *
 * What worked instead was the FIELD SET. A difference confined to exactly the
 * fields one callback writes is that callback, and that is how the `reenrich`
 * class was identified and then closed by porting it (`Verified.Geo.Enrich`).
 *
 * Needs the local golden fixtures (gitignored, real coordinates), so CI can
 * never run this — the deploy path is the only place it can gate.
 *
 *   pnpm run day-gate                 # every golden day
 *   pnpm run day-gate 2026-05-18      # one day
 *
 * Exit 0 = every day IDENTICAL or SHELL ONLY. Exit 1 = a divergence, a lookup
 * miss, or an unexpected shell. Exit 2 = no corpus.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClassificationInputs } from "../geo/classification-inputs.js";
import type { OsmTrace } from "../geo/osm-adapter-recording.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { canon, classify, diffEpisodes, diffSegs } from "../lean/day-compare.js";
import type { FoldCaptureFile } from "../lean/fold-capture.js";
import { buildDayRequest, encodeEpisode, encodeSeg, encodeState } from "../lean/fold-payload.js";
import { inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

const ROOT = path.join(import.meta.dirname, "../..");
const DAYS_DIR = path.join(ROOT, "tests/golden/days");
const CLI = path.join(ROOT, "lean/.lake/build/bin/verified_cli");

/** `DAY_HOST_BIN=<path>` runs the day through the in-process Rust host instead
 *  of spawning `verified_cli day`.
 *
 *  WHY THIS EXISTS. The two arms this gate compares are TS and `verified_cli`,
 *  and `verified_cli` links `c/osm-host-stub.c`: its `walkableRoads` and
 *  `buildingsNear` answer nothing, so `WalkAnnotate`'s matcher has no ways and
 *  draws no line. That is why every day reads SHELL ONLY on `walkMatchedPath` —
 *  not because the two arms disagree about geometry, but because one of them
 *  structurally cannot produce any.
 *
 *  `rust/day-shell --osm <fixture>` CAN: it answers those lookups from the day's
 *  own captured `osmTrace`, so the fold draws with the same roads the TS arm
 *  saw. Pointing this gate at it turns `walkMatchedPath` from an excused absence
 *  into a real field-by-field comparison — which is the only way the shells can
 *  be filled with anything anyone has checked.
 *
 *  Same stdin/stdout contract, so nothing else here changes. The comparison,
 *  the classifier and the accepted-shell list are all the ones the default path
 *  uses; a host judged by a looser rule than the CLI would be worthless. */
/**
 * `--freeze`: RUN the TS cascade and record its answer into each fixture's
 * `expected.tsArm`, instead of gating against one already there.
 *
 * ⚠ A one-time migration for #975, and it only runs in one direction. The day
 * gate's oracle used to be recomputed by executing the arm on every run; the arm
 * is being deleted, so the oracle has to become data first. After the deletion
 * this flag cannot work — there is nothing left to record.
 */
const FREEZE = process.argv.includes("--freeze");

const HOST_BIN = process.env.DAY_HOST_BIN;

interface Outcome {
	date: string;
	// ⚠ `NO ORACLE` is a RED verdict, not a skip. After #975 a fixture with no
	// frozen `expected.tsArm` cannot be measured at all, and the failure mode worth
	// preventing is a corpus quietly shrinking to the days that happen to carry one.
	verdict: "IDENTICAL" | "SHELL ONLY" | "DIVERGED" | "LOOKUP MISS" | "TIMEOUT" | "ERROR" | "NO ORACLE";
	detail: string;
}

/** The `Env` callbacks the `day` mode does not feed, as the CLI reports them.
 *  Checked rather than assumed: a shell added to `PassFold.Env` and left unfed
 *  would otherwise turn its fields into silent divergences on every day, and the
 *  gate would say "DIVERGED" about something nobody had wired. */
const EXPECTED_UNFED = ["roadEnv", "walkEnv"];

/** `DAY_DIFF_DUMP=1` prints the first differing VALUE for each field, not only
 *  the count.
 *
 *  "walkMatchedPath: 6/15 segments differ" says the fold moved without saying
 *  how, or how far, and the two arms' own renderings are the only thing that
 *  answers it — the gate is absolute, so there is no baseline to diff against
 *  instead. One sample per field per day: enough to start an investigation at
 *  the divergence, which is where it has to start (a checkout-based bisect
 *  cannot attribute this — old code asks the fixtures for lookups they were
 *  never captured with, and errors out instead of comparing).
 *
 *  Stays HERE rather than in `day-compare.ts` because it is the gate's
 *  reporting, not the rule: the tenant compares the same way and prints nothing.
 *  Off by default, so the gate's verdict is untouched. */
const DUMP = process.env.DAY_DIFF_DUMP === "1";

/** How long one day's bridge call may take before it is called wedged.
 *
 *  `LEAN_CALL_TIMEOUT_MS` covers the request path and NOT this gate, which is
 *  why the hang had no guard at all. Overridable for a slow machine; the point
 *  is that it is bounded, not that it is exactly two minutes. */
const DAY_BRIDGE_TIMEOUT_MS = Number(process.env.DAY_BRIDGE_TIMEOUT_MS ?? 120_000);
let dumped = new Set<string>();

function sample(label: string, index: number, a: unknown, b: unknown, where?: string): void {
	if (!DUMP || dumped.has(label)) return;
	dumped.add(label);
	const clip = (s: string): string => (s.length > 600 ? `${s.slice(0, 600)}… (${s.length} chars)` : s);
	// The index alone cannot be traced back to a pass: the state view a fixture
	// carries is a different length from the segment array the fold compares, so
	// counting rows in one to find a slot in the other silently misreads. Bounds
	// and mode identify the piece directly.
	console.log(`    ${label} — first at index ${index}${where ? ` (${where})` : ""}`);
	console.log(`      TS   ${clip(canon(a))}`);
	console.log(`      Lean ${clip(canon(b))}`);
}

/**
 * Wrap the spatial lookups so every answer this run gives is recorded,
 * keyed exactly as `RecordingOsmAdapter` keys them (`lat|lon|radius`, the radius
 * empty when the caller passed none) so `fold-payload.ts` reads it unchanged.
 *
 * `stationsOnLine` is copied from the fixture rather than recorded: the row-set
 * adapter delegates it to the trace unless the row set carries rail lines, so
 * for that one the trace IS the oracle both arms read.
 *
 * `reverseGeocode` is delegated the same way and recorded anyway. The fold
 * reaches it through `reenrichSplitWalks`, and if the Lean arm re-enriches a leg
 * the TS arm did not, recording makes that a MISS on a key the run never asked
 * for — where a copied trace would answer it and the extra re-enrichment would
 * vanish into a field diff.
 */
function recordingOsm(inputs: ClassificationInputs, fixture: OsmTrace): OsmTrace {
	const rec: OsmTrace = {
		nearbyWays: {},
		nearbyStations: {},
		// Recorded as of #430: `bestPlace` is Lean now, so the landmarks it ranks
		// have to cross the wire. Before that it was a shell and this stayed empty.
		nearbyLandmarks: {},
		linesAtPoint: {},
		reverseGeocode: {},
		nearbyTransitStops: {},
		stationsOnLine: fixture.stationsOnLine,
		// The three BULK readers, recorded as of the host callbacks (#952). They
		// were absent while `walkEnv`/`roadEnv` were shells and nothing in the
		// Lean arm could ask for them.
		//
		// Recorded rather than copied from the fixture, for the reason this
		// function's header gives about `reverseGeocode`: golden replays with
		// `osmSource: "rows"`, so the TS arm answers from a `RowSetOsmAdapter`
		// computing over raw rows while a fixture trace is a fixed record from
		// an older capture. Nothing should be able to hand the two arms
		// different roads and let it read as a difference in the algorithm.
		//
		// ⚠ IT WAS NOT THE CAUSE OF ANYTHING, and this is recorded because the
		// negative result is worth as much as the change. On 2026-05-14 the
		// host draws 97 vertices on a leg TS leaves bare and draws nothing on a
		// leg TS gives 53, and the obvious explanation was a stale oracle.
		// Checked: the fixture's four `walkableRoads` answers and this run's
		// recorded four are BYTE-IDENTICAL — same keys, same 13676/5389/721/821
		// way counts. Switching to the recorded set changed the verdict not at
		// all. Those two legs are a REAL difference between the float and
		// quantised matchers, and the oracle is now ruled out as a suspect
		// rather than merely assumed innocent.
		walkableRoads: {},
		buildingsNear: {},
		drivableRoads: {},
	};
	const key = (lat: number, lon: number, r: number | undefined): string => `${lat}|${lon}|${r ?? ""}`;
	const osm = inputs.osm;

	const ways = osm.nearbyWays.bind(osm);
	osm.nearbyWays = async (lat, lon, r?) => {
		const v = await ways(lat, lon, r);
		rec.nearbyWays[key(lat, lon, r)] = v;
		return v;
	};
	const landmarks = osm.nearbyLandmarks.bind(osm);
	osm.nearbyLandmarks = async (lat, lon, r?) => {
		const v = await landmarks(lat, lon, r);
		rec.nearbyLandmarks[key(lat, lon, r)] = v;
		return v;
	};
	const stations = osm.nearbyStations.bind(osm);
	osm.nearbyStations = async (lat, lon, r?) => {
		const v = await stations(lat, lon, r);
		rec.nearbyStations[key(lat, lon, r)] = v;
		return v;
	};
	const lines = osm.linesAtPoint.bind(osm);
	osm.linesAtPoint = async (lat, lon, r?) => {
		const v = await lines(lat, lon, r);
		rec.linesAtPoint[key(lat, lon, r)] = [...v];
		return v;
	};
	const stops = osm.nearbyTransitStops.bind(osm);
	osm.nearbyTransitStops = async (lat, lon, r?) => {
		const v = await stops(lat, lon, r);
		(rec.nearbyTransitStops as Record<string, unknown>)[key(lat, lon, r)] = v;
		return v;
	};
	const walkable = osm.walkableRoads.bind(osm);
	osm.walkableRoads = async (lat, lon, r?) => {
		const v = await walkable(lat, lon, r);
		(rec.walkableRoads as Record<string, unknown>)[key(lat, lon, r)] = v;
		return v;
	};
	const buildings = osm.buildingsNear.bind(osm);
	osm.buildingsNear = async (lat, lon, r?) => {
		const v = await buildings(lat, lon, r);
		(rec.buildingsNear as Record<string, unknown>)[key(lat, lon, r)] = v;
		return v;
	};
	const drivable = osm.drivableRoads.bind(osm);
	osm.drivableRoads = async (lat, lon, r?) => {
		const v = await drivable(lat, lon, r);
		(rec.drivableRoads as Record<string, unknown>)[key(lat, lon, r)] = v;
		return v;
	};
	const geo = osm.reverseGeocode.bind(osm);
	osm.reverseGeocode = async (lat, lon, zoom?) => {
		const v = await geo(lat, lon, zoom);
		rec.reverseGeocode[key(lat, lon, zoom)] = v;
		return v;
	};
	return rec;
}

/**
 * The lookups THIS RUN recorded, written where the host can read them.
 *
 * NOT the fixture's `osmTrace`, which was the first thing tried and is the
 * defect this file's own header describes (#428): golden replays with
 * `osmSource: "rows"`, so the TS arm answers from a `RowSetOsmAdapter` that
 * COMPUTES over raw OSM rows and can answer any coordinate, while a captured
 * trace is a fixed record from an older capture. Handing the fold the trace
 * gives it a strictly smaller and possibly staler oracle than the arm it is
 * being compared against, and then a difference in the ANSWERS reads as a
 * difference in the ALGORITHM.
 *
 * Measured, which is why this exists: on 2026-05-14 the trace-fed host drew a
 * 97-vertex path on a leg where TS drew none, and drew none on a leg where TS
 * drew 53. Both arms hit every lookup — so it was never a miss, it was two
 * different sets of roads.
 */
function osmForHost(dir: string, trace: OsmTrace): string {
	const p = path.join(dir, "osm-answers.json");
	writeFileSync(p, JSON.stringify({ inputs: { osmTrace: trace } }));
	return p;
}

/** The TS arm's run: what the fold was handed, and the answers the run's own
 *  lookups gave. `expected.tsArm` on the fixture holds exactly this. */
interface TsArm {
	capture: FoldCaptureFile;
	osmAnswers: OsmTrace;
}

/**
 * Run the TS cascade and record both halves of the oracle.
 *
 * ⚠ This is the MIGRATION path, not the gate's path. It exists to produce a
 * fixture's `expected.tsArm` (`--freeze`) while the cascade still exists; #975
 * deletes it, and after that the only source is the frozen one. A gate that
 * silently fell back here would go green by re-deriving its own oracle.
 */
async function runTsArm(inputs: ClassificationInputs, fixtureTrace: OsmTrace): Promise<TsArm> {
	const capDir = mkdtempSync(path.join(tmpdir(), "foldcap-"));
	process.env.FOLD_CAPTURE = capDir;
	// ⚠ Wraps `inputs.osm` IN PLACE, so it must not run when the arm is frozen:
	// there is nothing to record, and the wrapper would answer from an empty
	// table.
	const osmAnswers = recordingOsm(inputs, fixtureTrace);
	try {
		await computeVelocityFromInputs(inputs);
		const written = readdirSync(capDir);
		if (written.length === 0) throw new Error("cascade wrote no capture (did it return early?)");
		return {
			capture: JSON.parse(readFileSync(path.join(capDir, written[0]), "utf8")) as FoldCaptureFile,
			osmAnswers,
		};
	} finally {
		// `delete`, not `= undefined`: assigning to `process.env` coerces, so
		// `undefined` would leave the literal string "undefined" and the next
		// day would capture into a directory of that name.
		delete process.env.FOLD_CAPTURE;
	}
}

/**
 * Write the recorded arm into the fixture, in place.
 *
 * ⚠ Rewrites the RAW parsed JSON, never the zod-parsed `CapturedDay`. The
 * envelope schema is permissive on the inner closure by design, which means
 * round-tripping through it would silently DROP every field the schema does not
 * name — a 20 MB fixture rewritten as a much smaller and much wronger one.
 *
 * Write-then-rename because a reader that catches a half-written 20 MB fixture
 * sees a JSON parse error at best, and at worst a truncated day.
 */
function freeze(file: string, arm: TsArm): void {
	const full = path.join(DAYS_DIR, file);
	const raw = JSON.parse(readFileSync(full, "utf8")) as { expected: Record<string, unknown> };
	raw.expected.tsArm = arm;
	const tmp = `${full}.freezing`;
	writeFileSync(tmp, JSON.stringify(raw));
	renameSync(tmp, full);
	console.log(`    froze expected.tsArm — ${arm.capture.segsOut.length} segment(s) out`);
}

async function measure(file: string): Promise<Outcome> {
	const date = file.slice(0, 10);
	const captured = parseCapturedDay(readFileSync(path.join(DAYS_DIR, file), "utf8"));
	const capDir = mkdtempSync(path.join(tmpdir(), "foldcap-"));

	const inputs = inputsFromFixture(captured, "rows");

	// ⚠ FROZEN FIRST, and never a silent fallback. A fixture with no frozen arm
	// is REPORTED, because after #975 there is no cascade to fall back to and a
	// gate that quietly skipped such a day would read green having measured
	// nothing. `--freeze` is the one caller that runs the arm.
	let arm: TsArm;
	try {
		if (captured.expected.tsArm !== undefined) {
			arm = captured.expected.tsArm as TsArm;
		} else if (FREEZE) {
			arm = await runTsArm(inputs, captured.inputs.osmTrace);
			freeze(file, arm);
		} else {
			return { date, verdict: "NO ORACLE", detail: "fixture has no expected.tsArm — run `--freeze` (#975)" };
		}
	} catch (e) {
		return { date, verdict: "ERROR", detail: `TS arm: ${(e as Error).message}` };
	}
	const cap = arm.capture;
	const answers = arm.osmAnswers;

	const request = JSON.stringify(buildDayRequest(cap, inputs, answers));
	// `DAY_REQ_DUMP=<dir>` writes each day's request as the fold receives it.
	//
	// The request is otherwise unreachable — it is built here and piped straight
	// into a spawn, so there is no way to run one fold call by hand, and no way
	// to feed a real day to anything OTHER than this harness. `rust/day-shell`
	// (#952) needs exactly that to show it computes the same answer in-process.
	//
	// ⚠ A dumped request contains REAL LOCATION DATA — the day's fixes, places
	// and way names. Off by default, explicit path, and never a path inside the
	// repo: `tests/golden/` is gitignored for this reason and a dump is the same
	// class of data with none of that protection.
	if (process.env.DAY_REQ_DUMP !== undefined) {
		const dir = process.env.DAY_REQ_DUMP;
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, `${cap.date}-osm.json`), JSON.stringify(answers));
		writeFileSync(path.join(dir, `${cap.date}.json`), request);
	}
	let raw: string;
	try {
		raw = execFileSync(HOST_BIN ?? CLI, HOST_BIN ? ["--osm", osmForHost(capDir, answers)] : ["day"], {
			input: request,
			env: { ...process.env, LEAN_ABORT_ON_PANIC: "1" },
			maxBuffer: 512 * 1024 * 1024,
			// WITHOUT THIS THE GATE CAN HANG FOREVER, and has: on 2026-08-15 it
			// wedged after 5 of 35 days with `compare-day` and `verified_cli`
			// BOTH at 0.0% CPU, no output, no error and no exit. It is
			// INTERMITTENT — three runs of the same build finished in ~50 s
			// first — so a completing run is not evidence the deadlock is gone.
			//
			// A bound turns that into a red day instead of a stopped corpus,
			// which matters most where nobody is watching: `deploy.sh` runs this
			// under `set -e`, where a hang stops the deploy rather than failing
			// it. A gate that cannot finish cannot produce a tally, and a task
			// quoting one from a hung run is how #424 started.
			//
			// The bound is per DAY, not per corpus. Measured cost is 1-3 s a
			// day, so two minutes is ~40x headroom and only a wedge reaches it.
			timeout: DAY_BRIDGE_TIMEOUT_MS,
			encoding: "utf8",
		});
	} catch (e) {
		const err = e as { stderr?: string; code?: string; signal?: string };
		// A timeout is killed with `killSignal` (SIGTERM by default), and Node
		// reports `ETIMEDOUT` on some platforms and only the signal on others —
		// so test both, and say TIMEOUT rather than folding it into ERROR. The
		// two want different responses: ERROR is a bug in the day, TIMEOUT is
		// the deadlock, and burying one in the other loses the distinction that
		// makes the deadlock countable.
		if (err.code === "ETIMEDOUT" || err.signal === "SIGTERM") {
			return {
				date,
				verdict: "TIMEOUT",
				detail: `bridge did not answer within ${DAY_BRIDGE_TIMEOUT_MS} ms — the #424 deadlock`,
			};
		}
		const panic = (err.stderr ?? "").split("\n").find((l) => l.includes("uncaptured"));
		return {
			date,
			verdict: panic ? "LOOKUP MISS" : "ERROR",
			detail: panic ?? (err.stderr ?? "").split("\n")[0] ?? "no stderr",
		};
	}

	const res = JSON.parse(raw) as {
		segsSplit?: unknown[];
		segsEnriched?: unknown[];
		segsMid?: unknown[];
		segs?: unknown[];
		states?: unknown[];
		episodes?: unknown[];
		changed?: string[];
		unfed?: string[];
		error?: string;
	};
	if (res.error) return { date, verdict: "ERROR", detail: `Lean arm: ${res.error}` };

	const unfed = [...(res.unfed ?? [])].sort();
	if (canon(unfed) !== canon([...EXPECTED_UNFED].sort())) {
		return { date, verdict: "ERROR", detail: `unfed callbacks changed: ${unfed.join(", ") || "(none)"}` };
	}

	// The two biometric splits and the stay bridge — the earliest boundary, and a
	// SEPARATE sub-chain: the unported OSM enrichment loop runs between its output
	// and `pre.`'s input, so a `split.` line does NOT explain a `pre.` line the way
	// `pre.` explains `segs.`. Listed first because it is earliest in the day, not
	// because the ones below descend from it.
	// One sample per field PER DAY, so a whole-corpus dump does not report only
	// whichever day happened to reach a field first.
	dumped = new Set<string>();
	const split = diffSegs(cap.segsSplit.map(encodeSeg), res.segsSplit ?? [], sample).map((d) => `split.${d}`);
	// The OSM enrichment stage — the boundary that used to be the seam between two
	// sub-chains and is now interior like the rest. `cap.segsPre` is the TS arm's
	// enrichment output: an ORACLE here, no longer an input to anything.
	const enrich = diffSegs(cap.segsPre.map(encodeSeg), res.segsEnriched ?? [], sample).map((d) => `enrich.${d}`);
	// The five corrections, compared at the boundary they used to start the chain
	// at. A difference here is upstream of everything below it: the fold consumed
	// the Lean arm's own corrections, so a `pre.` line explains any `segs.` line
	// under it, and reading them the other way round would attribute a
	// correction's defect to a pass.
	const pre = diffSegs(cap.segsIn.map(encodeSeg), res.segsMid ?? [], sample).map((d) => `pre.${d}`);
	// The OTHER half of `DAY_REQ_DUMP`: the TS arm's answer, in the same wire
	// shape the Lean arm returns. Without it a divergence can be SEEN here and
	// not attributed anywhere else — the request alone lets you re-run the fold,
	// but not compare what came back to what should have.
	if (process.env.DAY_REQ_DUMP !== undefined) {
		writeFileSync(
			path.join(process.env.DAY_REQ_DUMP, `${cap.date}-ts.json`),
			JSON.stringify({
				segs: cap.segsOut.map(encodeSeg),
				states: (cap.statesOut ?? []).map(encodeState),
				episodes: (cap.episodesOut ?? []).map(encodeEpisode),
			}),
		);
	}
	const diffs = diffSegs(cap.segsOut.map(encodeSeg), res.segs ?? [], sample);
	// The stages after the fold, compared in the same call and on the same terms.
	// Prefixed so a `place` difference in the timeline is not confused with one in
	// a segment — they are different records at different points in the pipeline.
	const states = diffSegs((cap.statesOut ?? []).map(encodeState), res.states ?? [], sample).map((d) => `states.${d}`);
	const eps = diffEpisodes((cap.episodesOut ?? []).map(encodeEpisode), res.episodes ?? [], sample);
	const all = [...split, ...enrich, ...pre, ...diffs, ...states, ...eps.real];
	// Shell-only is its own verdict, not a pass: the fields are still printed.
	const { real, shell } = classify(all, eps.fallback);
	return {
		date,
		verdict: real.length > 0 ? "DIVERGED" : shell.length === 0 ? "IDENTICAL" : "SHELL ONLY",
		// Real divergences first — a shell difference must never push one off the line.
		detail:
			real.length === 0 && shell.length === 0
				? `${res.changed?.length ?? 0} passes fired, ${res.states?.length ?? 0} states, ${res.episodes?.length ?? 0} episodes`
				: [...real, ...shell].slice(0, 6).join("; "),
	};
}

// ⚠ Flags filtered out, or `--freeze` reads as a requested DATE: `only` would be
// non-empty, match no fixture, and the run would exit 2 saying there is no
// corpus — a flag typo reported as missing data.
const only = new Set(process.argv.slice(2).filter((a) => !a.startsWith("--")));
const files = readdirSync(DAYS_DIR)
	.filter((f) => f.endsWith(".json"))
	.filter((f) => only.size === 0 || only.has(f.slice(0, 10)))
	.sort();
if (files.length === 0) {
	console.error(only.size === 0 ? "no golden corpus — capture one first" : "no fixture for the requested date(s)");
	process.exit(2);
}

const started = Date.now();
const outcomes: Outcome[] = [];
for (const file of files) outcomes.push(await measure(file));

// Every outcome, not just the ones that produced segments. The misses were the
// silent ones, and a miss key is the whole finding — printing only the days
// that got as far as a comparison hid 20 of 33 behind a tally.
for (const o of outcomes) console.log(`${o.date}  ${o.verdict.padEnd(11)} ${o.detail}`);

const tally = new Map<string, number>();
for (const o of outcomes) tally.set(o.verdict, (tally.get(o.verdict) ?? 0) + 1);
console.log(`\n=== ${outcomes.length} day(s) in ${Math.round((Date.now() - started) / 1000)}s ===`);
for (const [v, c] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${v.padEnd(11)} ${c}`);

const failed = outcomes.filter((o) => o.verdict !== "IDENTICAL" && o.verdict !== "SHELL ONLY");
if (failed.length > 0) {
	console.error(`\nDAY GATE RED: ${failed.length} day(s) — ${failed.map((f) => f.date).join(", ")}`);
	process.exit(1);
}
console.log("\nday gate green: the Lean day matches the TS pipeline on every field it owns");

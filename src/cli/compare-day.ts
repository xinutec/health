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
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
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

interface Outcome {
	date: string;
	verdict: "IDENTICAL" | "SHELL ONLY" | "DIVERGED" | "LOOKUP MISS" | "ERROR";
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
let dumped = new Set<string>();

function sample(label: string, index: number, a: unknown, b: unknown): void {
	if (!DUMP || dumped.has(label)) return;
	dumped.add(label);
	const clip = (s: string): string => (s.length > 600 ? `${s.slice(0, 600)}… (${s.length} chars)` : s);
	console.log(`    ${label} — first at index ${index}`);
	console.log(`      TS   ${clip(canon(a))}`);
	console.log(`      Lean ${clip(canon(b))}`);
}

/**
 * Wrap the five spatial lookups so every answer this run gives is recorded,
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
	const geo = osm.reverseGeocode.bind(osm);
	osm.reverseGeocode = async (lat, lon, zoom?) => {
		const v = await geo(lat, lon, zoom);
		rec.reverseGeocode[key(lat, lon, zoom)] = v;
		return v;
	};
	return rec;
}

async function measure(file: string): Promise<Outcome> {
	const date = file.slice(0, 10);
	const captured = parseCapturedDay(readFileSync(path.join(DAYS_DIR, file), "utf8"));
	const capDir = mkdtempSync(path.join(tmpdir(), "foldcap-"));
	process.env.FOLD_CAPTURE = capDir;

	const inputs = inputsFromFixture(captured, "rows");
	const answers = recordingOsm(inputs, captured.inputs.osmTrace);

	let cap: FoldCaptureFile;
	try {
		await computeVelocityFromInputs(inputs);
		const written = readdirSync(capDir);
		if (written.length === 0) throw new Error("cascade wrote no capture (did it return early?)");
		cap = JSON.parse(readFileSync(path.join(capDir, written[0]), "utf8")) as FoldCaptureFile;
	} catch (e) {
		return { date, verdict: "ERROR", detail: `TS arm: ${(e as Error).message}` };
	} finally {
		// `delete`, not `= undefined`: assigning to `process.env` coerces, so
		// `undefined` would leave the literal string "undefined" and the next
		// day would capture into a directory of that name.
		delete process.env.FOLD_CAPTURE;
	}

	let raw: string;
	try {
		raw = execFileSync(CLI, ["day"], {
			input: JSON.stringify(buildDayRequest(cap, inputs, answers)),
			env: { ...process.env, LEAN_ABORT_ON_PANIC: "1" },
			maxBuffer: 512 * 1024 * 1024,
			encoding: "utf8",
		});
	} catch (e) {
		const err = e as { stderr?: string };
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

const only = new Set(process.argv.slice(2));
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

/**
 * Could `verified_cli day` ever SERVE? — the fourth gap of #431, measured.
 *
 * The gate is retrospective by construction. Its six lookup tables are the
 * answers THIS RUN gave (#428), which is exactly what makes a miss a finding
 * rather than a narrower oracle. Serving inverts that: the Lean arm has to ask
 * before the TS arm has asked, so there is no run to record and the tables
 * cannot be built in advance.
 *
 * #431 named two ways out, and both are expensive. Either the OSM callbacks
 * become live shells — a different contract, and a re-entrancy problem, because
 * the adapter is async and the bridge is not — or the day mode never serves and
 * stays a referee.
 *
 * # There is a third way, and it needs no async bridge
 *
 * The fold is a PURE FUNCTION of its tables. So run it against a table it does
 * not have, let it name what it wanted, answer that, and run it again. Each
 * round the table grows; when a round asks for nothing it did not already have,
 * every answer it read was real and its output is the answer.
 *
 * That works only because of a property the miss policy already has and which
 * reads at first like a defect: `panic!` PRINTS AND CONTINUES unless
 * `LEAN_ABORT_ON_PANIC` is set. A round with an incomplete table therefore runs
 * to the end and names every key it reached, rather than stopping at the first.
 * The rest of that round's output is poisoned by the defaults it read and is
 * thrown away — only the key set is kept.
 *
 * The cost is therefore not a rewrite. It is ROUNDS, and the round count is not
 * the number of lookups: it is the DEPTH of the dependency chain among them —
 * how many times an answer decides the next question. That number is what this
 * measures, and nothing in the repo knew it.
 *
 * # What this simulates, and what it does not
 *
 * The lookups are answered LIVE, from the fixture's own row-set adapter — the
 * same object production would hand a real shell, able to answer any coordinate
 * rather than a fixed set. That is the serving contract, honestly.
 *
 * The INPUTS are still read from a capture (`segsRaw`, the track, the day
 * tables). Those are gaps 1-3 of #431, not this one; upstream stages would
 * supply them in production. This measures the fourth gap alone.
 *
 * # Reading the result
 *
 *   rounds        how many bridge crossings a live day would need
 *   asked         lookups the converged run made
 *   recorded      lookups the TS arm made — over-fetch is the difference
 *   verdict       MATCH iff the converged output equals the gate's own
 *
 * MATCH is the load-bearing one. It says the demand-driven tables produce the
 * same day as the recorded ones, which is what "this could serve" has to mean.
 *
 * Run: TMPDIR=/tmp npx tsx lean/experiments/day-serve-rounds.mts [date...]
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import tzLookup from "tz-lookup";
import type { OsmTrace } from "../../src/geo/osm-adapter-recording.js";
import { computeVelocityFromInputs } from "../../src/geo/velocity.js";
import { inputsFromFixture, parseCapturedDay } from "../../src/cli/fixture-day.js";
import type { FoldCaptureFile, StayPlaceQuery, TzQuery } from "../../src/lean/fold-capture.js";
import { buildDayRequest } from "../../src/lean/fold-payload.js";

const ROOT = path.join(import.meta.dirname, "../..");
const DAYS_DIR = path.join(ROOT, "tests/golden/days");
const CLI = path.join(ROOT, "lean/.lake/build/bin/verified_cli");

/** A generous bound on the dependency depth, so a run that fails to converge
 *  says so instead of looping. NOT a budget the measurement is allowed to spend:
 *  reaching it is a reported failure, because the interesting number is the
 *  depth and a truncated depth is not a depth. */
const MAX_ROUNDS = 40;

/** The inverse of `fold-payload.ts`'s `bits`. Exact — the encoding is the raw
 *  `Float64` pattern, so this recovers the double the Lean arm asked about
 *  rather than a rendering of it. */
function unbits(s: string): number {
	const d = new DataView(new ArrayBuffer(8));
	d.setBigUint64(0, BigInt(s));
	return d.getFloat64(0);
}

/** `RecordingOsmAdapter`'s key shape, which `fold-payload.ts` re-keys onto bits.
 *  Written back in that shape so the encoder is used unchanged — this experiment
 *  measures the fold, not a second wire format. */
const traceKey = (lat: number, lon: number, third: number | string): string => `${lat}|${lon}|${third}`;

/** Whether `Intl` will accept it — the encoder resolves the venue-local clock
 *  with it, and a poisoned round can produce a zone that is not one. */
function isZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

interface Miss {
	what: string;
	key: string;
}

/** Every key the round wanted, deduplicated. `panic!` fires per call, so a
 *  coordinate asked twice prints twice.
 *
 *  Anchored on the message's TAIL, not on the first `)`. A line name is a key
 *  and line names contain brackets — `Northern Line (Charing Cross Branch)
 *  Southbound`. Stopping at the first one silently answers a DIFFERENT key,
 *  which the loop then believes it has handled; two days converged wrongly that
 *  way, and only the reference run noticed. */
function missesIn(stderr: string): Miss[] {
	const seen = new Map<string, Miss>();
	for (const m of stderr.matchAll(/uncaptured (\w+)\((.*?)\) — re-capture required/g)) {
		seen.set(`${m[1]}|${m[2]}`, { what: m[1], key: m[2] });
	}
	return [...seen.values()];
}

/** Key-sorted JSON — `JSON.stringify` is order-sensitive on objects and the two
 *  runs build their tables in different orders. */
function canon(v: unknown): string {
	const walk = (x: unknown): unknown =>
		Array.isArray(x)
			? x.map(walk)
			: x !== null && typeof x === "object"
				? Object.fromEntries(
						Object.entries(x as Record<string, unknown>)
							.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
							.map(([k, v2]) => [k, walk(v2)]),
					)
				: x;
	return JSON.stringify(walk(v));
}

function emptyTrace(): OsmTrace {
	return {
		nearbyWays: {},
		nearbyStations: {},
		nearbyLandmarks: {},
		linesAtPoint: {},
		reverseGeocode: {},
		nearbyTransitStops: {},
		stationsOnLine: {},
	};
}

/** `spawnSync`, not `execFileSync`: the whole measurement is on STDERR, and
 *  `execFileSync` returns stdout alone on a zero exit. A round with an
 *  incomplete table exits 0 — `panic!` prints and continues — so the successful
 *  case is exactly the one whose stderr matters. */
function run(req: unknown, abort: boolean): { out: string; err: string } {
	const r = spawnSync(CLI, ["day"], {
		input: JSON.stringify(req),
		env: abort ? { ...process.env, LEAN_ABORT_ON_PANIC: "1" } : { ...process.env },
		maxBuffer: 512 * 1024 * 1024,
		encoding: "utf8",
	});
	return { out: r.stdout ?? "", err: r.stderr ?? "" };
}

interface Outcome {
	date: string;
	rounds: number;
	asked: number;
	/** Keys a poisoned round invented that nothing could answer — see the
	 *  `orNothing` note. Over-fetch that would be merely wasteful in production
	 *  and is unanswerable against a fixture. */
	unanswerable: number;
	recorded: number;
	verdict: string;
}

async function measure(file: string): Promise<Outcome> {
	const date = file.slice(0, 10);
	const captured = parseCapturedDay(readFileSync(path.join(DAYS_DIR, file), "utf8"));
	const capDir = mkdtempSync(path.join(tmpdir(), "serverounds-"));
	process.env.FOLD_CAPTURE = capDir;
	const inputs = inputsFromFixture(captured, "rows");
	let cap: FoldCaptureFile;
	try {
		await computeVelocityFromInputs(inputs);
		const written = readdirSync(capDir);
		cap = JSON.parse(readFileSync(path.join(capDir, written[0]), "utf8")) as FoldCaptureFile;
	} finally {
		delete process.env.FOLD_CAPTURE;
	}

	const osm = inputs.osm;
	const partial = emptyTrace();
	const tzAt: TzQuery[] = [];
	const bestPlace: StayPlaceQuery[] = [];
	const answered = new Set<string>();

	let rounds = 0;
	let unanswerable = 0;
	let out = "";
	for (;;) {
		rounds += 1;
		if (rounds > MAX_ROUNDS) {
			return {
				date,
				rounds: -1,
				asked: answered.size,
				unanswerable,
				recorded: 0,
				verdict: `NO CONVERGENCE in ${MAX_ROUNDS}`,
			};
		}
		const req = buildDayRequest({ ...cap, tzAt, bestPlace }, captured, partial);
		const r = run(req, false);
		const all = missesIn(r.err);
		if (all.length === 0) {
			out = r.out;
			break;
		}
		const misses = all.filter((m) => !answered.has(`${m.what}|${m.key}`));
		// Converge on an EMPTY miss list, not on "nothing new". A key that is asked
		// again after being answered means the answer went somewhere the fold does
		// not read it — a harness fault, and one that would otherwise look exactly
		// like convergence.
		if (misses.length === 0) {
			return {
				date,
				rounds: -1,
				asked: answered.size,
				unanswerable,
				recorded: 0,
				verdict: `RE-ASKED ${all[0].what}(${all[0].key})`,
			};
		}
		for (const m of misses) {
			answered.add(`${m.what}|${m.key}`);
			const p = m.key.split("|");
			const lat = p.length >= 2 ? unbits(p[0]) : 0;
			const lon = p.length >= 2 ? unbits(p[1]) : 0;
			// A round reading defaults computes NONSENSE, and nonsense asks about
			// coordinates the real day never visits. In production a live mirror
			// answers those (wastefully) and the next round stops asking. Here two of
			// the seven tables cannot: `reverseGeocode` and `stationsOnLine` are
			// DELEGATED by the row-set adapter to the fixture's fixed trace, so an
			// invented coordinate raises. Recorded as the empty answer and counted —
			// if one of them was real rather than invented, the run does not converge
			// to the gate's output and the verdict says DIFFERS rather than hiding it.
			// The trailing comma is not a typo: `<T>` alone is reserved syntax in a
			// `.mts` file, where it would read as JSX.
			const orNothing = async <T,>(f: () => Promise<T>, empty: T): Promise<T> => {
				try {
					return await f();
				} catch {
					unanswerable += 1;
					return empty;
				}
			};
			switch (m.what) {
				case "nearbyWays":
					partial.nearbyWays[traceKey(lat, lon, "")] = await orNothing(() => osm.nearbyWays(lat, lon), []);
					break;
				case "nearbyStations": {
					const rad = unbits(p[2]);
					partial.nearbyStations[traceKey(lat, lon, rad)] = await orNothing(
						() => osm.nearbyStations(lat, lon, rad),
						[],
					);
					break;
				}
				case "nearbyLandmarks": {
					const rad = unbits(p[2]);
					partial.nearbyLandmarks[traceKey(lat, lon, rad)] = await orNothing(
						() => osm.nearbyLandmarks(lat, lon, rad),
						[],
					);
					break;
				}
				case "linesAtPoint": {
					const rad = unbits(p[2]);
					partial.linesAtPoint[traceKey(lat, lon, rad)] = await orNothing(
						async () => [...(await osm.linesAtPoint(lat, lon, rad))],
						[],
					);
					break;
				}
				case "transitStops": {
					const rad = unbits(p[2]);
					// `??=` rather than an assertion: the two sections are OPTIONAL on
					// `OsmTrace`, and `emptyTrace` seeding them is a fact about this file
					// rather than about the type.
					(partial.nearbyTransitStops ??= {})[traceKey(lat, lon, rad)] = await orNothing(
						() => osm.nearbyTransitStops(lat, lon, rad),
						[],
					);
					break;
				}
				case "reverseGeocode": {
					// The zoom crosses as a PLAIN INTEGER, unlike every other key part —
					// it is a literal the caller writes, not a measured double.
					const zoom = Number(p[2]);
					partial.reverseGeocode[traceKey(lat, lon, zoom)] = await orNothing(
						() => osm.reverseGeocode(lat, lon, zoom),
						null,
					);
					break;
				}
				case "stationsOnLine":
					(partial.stationsOnLine ??= {})[m.key] = await orNothing(() => osm.stationsOnLine(m.key), []);
					break;
				case "tzAt": {
					let tz: string;
					try {
						tz = tzLookup(lat, lon);
					} catch {
						tz = captured.inputs.homeTz;
					}
					tzAt.push({ lat, lon, tz });
					break;
				}
				case "bestPlace": {
					// Nothing to fetch: the encoder derives the stay's local samples and
					// its midpoint hour from the key itself.
					//
					// POISONING CASCADES ACROSS TABLES, and this is where it shows. A
					// missing `tzAt` defaults to the empty string, the naming arm carries
					// that into its own key, and the encoder then asks `Intl` for an hour
					// in zone "". The key is an artefact of the round, not a question the
					// day has: once the zone is really answered the next round asks with
					// it, and this spelling is never asked again.
					const tz = p.slice(4).join("|");
					if (!isZone(tz)) {
						unanswerable += 1;
						break;
					}
					bestPlace.push({ lat, lon, startTs: Number(p[2]), endTs: Number(p[3]), tz });
					break;
				}
				default:
					return {
						date,
						rounds: -1,
						asked: answered.size,
						unanswerable,
						recorded: 0,
						verdict: `UNKNOWN TABLE ${m.what}`,
					};
			}
		}
	}

	// The reference: the same converged tables, but aborting on a miss. If the
	// loop really converged this cannot miss, and its output is the gate's.
	const ref = run(buildDayRequest({ ...cap, tzAt, bestPlace }, captured, partial), true);
	const recorded = cap.tzAt.length + cap.bestPlace.length + Object.values(captured.inputs.osmTrace).reduce((n, s) => n + Object.keys(s ?? {}).length, 0);
	const verdict = ref.out === "" ? `ABORTED: ${ref.err.split("\n")[0]}` : canon(JSON.parse(out)) === canon(JSON.parse(ref.out)) ? "MATCH" : "DIFFERS";
	return { date, rounds, asked: answered.size, unanswerable, recorded, verdict };
}

const only = new Set(process.argv.slice(2));
const files = readdirSync(DAYS_DIR)
	.filter((f) => f.endsWith(".json"))
	.filter((f) => only.size === 0 || only.has(f.slice(0, 10)))
	.sort();

const outcomes: Outcome[] = [];
for (const f of files) outcomes.push(await measure(f));

console.log("\ndate        rounds  asked  unans  recorded  verdict");
for (const o of outcomes) {
	console.log(
		`${o.date}  ${String(o.rounds).padStart(6)}  ${String(o.asked).padStart(5)}  ${String(o.unanswerable).padStart(5)}  ${String(o.recorded).padStart(8)}  ${o.verdict}`,
	);
}
const ok = outcomes.filter((o) => o.verdict === "MATCH");
const maxR = Math.max(...outcomes.map((o) => o.rounds));
console.log(`\n${ok.length}/${outcomes.length} MATCH; deepest dependency chain ${maxR} round(s)`);

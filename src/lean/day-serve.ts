/**
 * Demand-driven table filling for `verified_cli day` — the mechanism, without a
 * verdict or a stopwatch attached to it.
 *
 * Extracted from `day-serve-rounds.mts` when the cost harness needed the same
 * loop (#431 gap 3), and moved out of `lean/experiments/` once it stopped being
 * one: this is the loop a `LEAN_DAY` tenant runs, not a thing measured about
 * one. Two copies would have been two copies of the two things here that are
 * subtle and were both wrong once: the miss regex has to anchor on
 * the message TAIL because line names contain brackets, and the loop has to
 * converge on an EMPTY miss list rather than on "nothing new", because a key
 * re-asked after being answered is a harness fault that otherwise reads exactly
 * like convergence.
 *
 * # Why this can work at all
 *
 * The fold is a PURE FUNCTION of its tables. Run it against a table it does not
 * have, let it name what it wanted, answer that, run it again. When a round asks
 * for nothing new, every answer it read was real.
 *
 * That needs `panic!` to PRINT AND CONTINUE, which is what it does unless
 * `LEAN_ABORT_ON_PANIC` is set. A round with an incomplete table therefore runs
 * to the end and names every key it reached rather than stopping at the first.
 * The rest of that round's output is poisoned by the defaults it read and is
 * thrown away — only the key set is kept.
 *
 * The round count is not the number of lookups. It is the DEPTH of the
 * dependency chain among them: how many times an answer decides the next
 * question.
 */

import tzLookup from "tz-lookup";
import type { ClassificationInputs } from "../geo/classification-inputs.js";
import type { OsmAdapter } from "../geo/osm-adapter.js";
import type { OsmTrace } from "../geo/osm-adapter-recording.js";
import type { DayRequestInputs, StayPlaceQuery, TzQuery } from "./fold-capture.js";
import { buildDayRequest } from "./fold-payload.js";

/** A generous bound on the dependency depth, so a run that fails to converge
 *  says so instead of looping. NOT a budget the measurement is allowed to spend:
 *  reaching it is a reported failure, because the interesting number is the
 *  depth and a truncated depth is not a depth. */
const MAX_ROUNDS = 40;

/** The inverse of `fold-payload.ts`'s `bits`. Exact — the encoding is the raw
 *  `Float64` pattern, so this recovers the double the Lean arm asked about
 *  rather than a rendering of it. */
export function unbits(s: string): number {
	const d = new DataView(new ArrayBuffer(8));
	d.setBigUint64(0, BigInt(s));
	return d.getFloat64(0);
}

/** `RecordingOsmAdapter`'s key shape, which `fold-payload.ts` re-keys onto bits.
 *  Written back in that shape so the encoder is used unchanged — this measures
 *  the fold, not a second wire format. */
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
export function missesIn(stderr: string): Miss[] {
	const seen = new Map<string, Miss>();
	for (const m of stderr.matchAll(/uncaptured (\w+)\((.*?)\) — re-capture required/g)) {
		seen.set(`${m[1]}|${m[2]}`, { what: m[1], key: m[2] });
	}
	return [...seen.values()];
}

export function emptyTrace(): OsmTrace {
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

/** The three tables the loop grows — the six spatial lookups in one `OsmTrace`,
 *  plus the two callbacks no adapter sees. */
export interface Tables {
	partial: OsmTrace;
	tzAt: TzQuery[];
	bestPlace: StayPlaceQuery[];
}

/** How the caller runs one round. Returns the child's two streams; the caller
 *  owns the transport (a fresh process, or a line into a warm `serve` loop) and
 *  therefore owns its own timing of it. */
export type RunRound = (req: unknown) => Promise<{ out: string; err: string }>;

export interface Converged {
	/** Rounds to convergence, or -1 when it did not converge. */
	rounds: number;
	/** Distinct keys the loop answered. */
	asked: number;
	/** Keys a poisoned round invented that nothing could answer — see the
	 *  `orNothing` note below. Over-fetch that would be merely wasteful in
	 *  production and is unanswerable against a fixture. */
	unanswerable: number;
	/** Wall time spent ANSWERING — the lookups, not the fold. Kept separate
	 *  because it is the one part of the Lean arm that is not Lean: production
	 *  pays it in either arm, and only the over-fetch is new. */
	answerMs: number;
	tables: Tables;
	/** The converged round's stdout, `""` when it did not converge. */
	out: string;
	failure?: string;
}

/**
 * Fill the tables by asking the fold what it wants until it stops wanting.
 *
 * The lookups are answered LIVE from `osm` — the same object production would
 * hand a real shell, able to answer any coordinate rather than a fixed set.
 *
 * Both parameters are now the NARROW types — `DayRequestInputs` rather than a
 * capture file, `ClassificationInputs` rather than a fixture — so nothing in the
 * round loop depends on a capture existing. A `FoldCaptureFile` still satisfies
 * the first structurally, which is why the experiments pass theirs unchanged.
 */
export async function converge(
	cap: DayRequestInputs,
	inputs: ClassificationInputs,
	osm: OsmAdapter,
	run: RunRound,
): Promise<Converged> {
	const partial = emptyTrace();
	const tzAt: TzQuery[] = [];
	const bestPlace: StayPlaceQuery[] = [];
	const answered = new Set<string>();
	const tables: Tables = { partial, tzAt, bestPlace };

	let rounds = 0;
	let unanswerable = 0;
	let answerMs = 0;
	const fail = (failure: string): Converged => ({
		rounds: -1,
		asked: answered.size,
		unanswerable,
		answerMs,
		tables,
		out: "",
		failure,
	});

	for (;;) {
		rounds += 1;
		if (rounds > MAX_ROUNDS) return fail(`NO CONVERGENCE in ${MAX_ROUNDS}`);
		const r = await run(buildDayRequest({ ...cap, tzAt, bestPlace }, inputs, partial));
		const all = missesIn(r.err);
		if (all.length === 0) {
			return { rounds, asked: answered.size, unanswerable, answerMs, tables, out: r.out };
		}
		const misses = all.filter((m) => !answered.has(`${m.what}|${m.key}`));
		// Converge on an EMPTY miss list, not on "nothing new". A key that is asked
		// again after being answered means the answer went somewhere the fold does
		// not read it — a harness fault, and one that would otherwise look exactly
		// like convergence.
		if (misses.length === 0) return fail(`RE-ASKED ${all[0].what}(${all[0].key})`);

		const startedAnswering = performance.now();
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
			const orNothing = async <T>(f: () => Promise<T>, empty: T): Promise<T> => {
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
					// Widened rather than asserted: the two sections are OPTIONAL on
					// `OsmTrace`, and `emptyTrace` seeding them is a fact about this file
					// rather than about the type.
					partial.nearbyTransitStops ??= {};
					partial.nearbyTransitStops[traceKey(lat, lon, rad)] = await orNothing(
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
				case "stationsOnLine": {
					partial.stationsOnLine ??= {};
					partial.stationsOnLine[m.key] = await orNothing(() => osm.stationsOnLine(m.key), []);
					break;
				}
				case "tzAt": {
					let tz: string;
					try {
						tz = tzLookup(lat, lon);
					} catch {
						tz = inputs.homeTz;
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
					return fail(`UNKNOWN TABLE ${m.what}`);
			}
		}
		answerMs += performance.now() - startedAnswering;
	}
}

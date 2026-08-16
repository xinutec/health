/**
 * The inverse of `fold-payload.ts`'s three encoders — what `LEAN_DAY=on` needs
 * and `shadow` never did.
 *
 * A shadow only ever compares two ENCODINGS: it renders the TS answer with
 * `encodeSeg` and holds it against Lean's wire rows. Serving has to go the other
 * way and rebuild the typed values the rest of `velocity.ts` and the API
 * consume, so every field the encoder writes needs a reader, and every field it
 * does NOT write is one the served day would silently lose.
 *
 * # Checked, not assumed: the encoders are total over both types
 *
 * `encodeSeg`'s key set is exactly `TrackSegment ∪ EnrichedSegment` (27 fields),
 * `encodeState`'s is exactly `DayState` (9), and `encodeEpisode`'s is exactly
 * `EpisodeGeometry` (6, `points` included). Re-read field by field on
 * 2026-08-11 rather than trusted from #431's note, because "the encoder covers
 * everything" is the premise the whole `on` path rests on and it is the kind of
 * claim that stops being true one interface edit later.
 *
 * `tests/day-decode.test.ts` holds it there: it round-trips real corpus
 * segments and fails if any key survives the trip changed — which is a test of
 * the ENCODER's coverage as much as this module's.
 *
 * # The three losses, named rather than papered over
 *
 * The round trip is the identity except where the encoder is deliberately not,
 * and a decoder that pretended otherwise would be the fiction:
 *
 *   1. `undefined` becomes `null` on the wire and `undefined` again here. The
 *      distinction does not survive JSON and nothing downstream reads it — the
 *      interfaces spell these `?:`, not `| null`.
 *   2. `focusPlaceId` is `string | number` in TS and `Option Int` in Lean, so a
 *      NON-NUMERIC id is dropped by the encoder rather than coerced to NaN. It
 *      comes back a number. Measured over the 35-day corpus: 4445 of 4445 place
 *      ids are numeric, so this is currently a loss of nothing — but it is a
 *      loss the shadow structurally cannot report, because BOTH arms of that
 *      comparison run through the same encoder.
 *   3. Vertex timestamps cross as `Float64` bits and return as doubles, so a
 *      fractional `ts` survives exactly (#420). It is the ROUNDING that would
 *      have been the loss here.
 *
 * # The graft is GONE (2026-08-16, #959). What it was, so nobody rebuilds it
 *
 * `PassFold.Env.walkEnv` / `.roadEnv` used to be declared shells, so the Lean
 * arm wrote no `walkMatchedPath` / `walkSmoothedPath` / `matchedPath` and its
 * episodes fell back to raw chords where a solver drew the TS ones. Serving
 * those verbatim would have been a REGRESSION to undrawn geometry — the exact
 * user-visible loss #398 caused — so `graftShells` / `graftEpisodes` put the TS
 * geometry back wherever Lean had drawn none.
 *
 * The shells are filled now and, under `LEAN_DAY_HOST`, the fold answers its own
 * OSM lookups and draws for itself. The deletion was gated on a measurement
 * rather than on that argument: the two grafts were made to COUNT what they
 * took, and across seven live days on the production transport they took
 * nothing — zero fields, zero episodes, `shellOnly == 0` on every ledger line.
 *
 * ⚠ If a fold ever stops drawing, the symptom is now a served day with raw
 * chords in it, NOT a silent repair. That is deliberate: `serveLeanDay`'s
 * contract is that a field divergence is served, and the graft was the one
 * place that quietly contradicted it.
 */

import type { EnrichedSegment } from "../geo/enriched-segment.js";
import type { EpisodeGeometry } from "../geo/episode-geometry.js";
import type { RefinedKind } from "../geo/segments.js";
import type { DayState, DayStateMode } from "../sleep/day-state.js";
import { floatFromBits } from "./float-bits.js";

/** A wire row, as the response carries it. Deliberately loose: the point of the
 *  readers below is to be the one place that turns `unknown` into a type. */
type Row = Record<string, unknown>;

const num = (v: unknown): number => floatFromBits(String(v));
const optNum = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : num(v));
const optStr = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const optBool = (v: unknown): boolean | undefined => (v === null || v === undefined ? undefined : Boolean(v));
/** Plain integers on the wire — timestamps and counts, never bit patterns. */
const int = (v: unknown): number => Number(v);

type PathPt = { lat: number; lon: number; ts: number };
const optPath = (v: unknown): PathPt[] | undefined =>
	v === null || v === undefined
		? undefined
		: (v as string[][]).map((q) => ({ lat: num(q[0]), lon: num(q[1]), ts: num(q[2]) }));

/** `BiometricEnrichment`'s optionals are `number | NULL`, not `| undefined`,
 *  and the null is load-bearing: it means no samples touched the window, which
 *  `stepsTotal` in particular distinguishes from a recorded zero. So this reader
 *  preserves null where the segment-level ones erase it. */
const nullNum = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

function decodeBiometrics(v: unknown): EnrichedSegment["biometrics"] {
	if (v === null || v === undefined) return undefined;
	const b = v as Row;
	return {
		hrMean: nullNum(b.hrMean),
		hrMin: nullNum(b.hrMin),
		hrMax: nullNum(b.hrMax),
		hrStd: nullNum(b.hrStd),
		sampleCount: int(b.sampleCount),
		overlapsSleep: Boolean(b.overlapsSleep),
		sleepFraction: num(b.sleepFraction),
		stepsTotal: nullNum(b.stepsTotal),
	};
}

/** One segment, as `encodeSeg` wrote it. */
export function decodeSeg(v: unknown): EnrichedSegment {
	const r = v as Row;
	const seg: EnrichedSegment = {
		startTs: int(r.startTs),
		endTs: int(r.endTs),
		mode: String(r.mode) as EnrichedSegment["mode"],
		confidence: num(r.confidence),
		confidenceMargin: num(r.confidenceMargin),
		avgSpeed: num(r.avgSpeed),
		maxSpeed: num(r.maxSpeed),
		linearity: num(r.linearity),
		pointCount: int(r.pointCount),
	};
	// Assigned conditionally, not as `field: undefined`: an explicit `undefined`
	// is an OWN key, so `Object.keys` and every structural comparison (including
	// `day-compare`'s `canon`) would see a key the TS arm does not have.
	const put = <K extends keyof EnrichedSegment>(k: K, val: EnrichedSegment[K] | undefined): void => {
		if (val !== undefined) seg[k] = val;
	};
	put("refinedMode", optStr(r.refinedMode) as EnrichedSegment["refinedMode"]);
	put("place", optStr(r.place));
	put("city", optStr(r.city));
	put("wayName", optStr(r.wayName));
	put("refinedReason", optStr(r.refinedReason));
	put("centroidLat", optNum(r.centroidLat));
	put("centroidLon", optNum(r.centroidLon));
	put("focusPlaceId", r.focusPlaceId === null || r.focusPlaceId === undefined ? undefined : int(r.focusPlaceId));
	// `false` restores as ABSENT, which is not sloppiness in either direction:
	// the encoder writes `s.needsReenrich ?? false` because Lean's `Seg` has a
	// plain `Bool`, and the TS pipeline only ever writes `true` — `velocity.ts`
	// DELETES the key once a stale segment is re-enriched (`const { needsReenrich:
	// _, ...rest }`), so absent is how "not stale" is spelled. Restoring the
	// `false` would put a key on every served segment that no TS segment carries.
	// Caught by the round-trip test, not by reading.
	if (optBool(r.needsReenrich) === true) seg.needsReenrich = true;
	// Same asymmetry, same reason: `reenrichSplitWalks` destructures the key away
	// once it has renamed the segment, so absent is how "nothing to rename" is
	// spelled on the TS side too.
	if (optBool(r.needsRename) === true) seg.needsRename = true;
	put("vehicleKind", optStr(r.vehicleKind) as EnrichedSegment["vehicleKind"]);
	put("roadCorridorFraction", optNum(r.roadCorridorFraction));
	put("displayTz", optStr(r.displayTz));
	put("snappedPath", optPath(r.snappedPath));
	put("matchedPath", optPath(r.matchedPath));
	put("walkMatchedPath", optPath(r.walkMatchedPath));
	put("walkSmoothedPath", optPath(r.walkSmoothedPath));
	// The encoder writes `[]` for an absent list, and an empty `refinedKinds` is
	// how the TS arm spells "no branch-relevant refinement" as well — but it
	// spells it by OMITTING the field. Restoring `[]` would add a key the TS
	// segment does not carry.
	const kinds = (r.refinedKinds ?? []) as RefinedKind[];
	if (kinds.length > 0) seg.refinedKinds = kinds;
	const biom = decodeBiometrics(r.biometrics);
	if (biom !== undefined) seg.biometrics = biom;
	return seg;
}

/** One timeline row, as `encodeState` wrote it. */
export function decodeState(v: unknown): DayState {
	const r = v as Row;
	const s: DayState = {
		startTs: int(r.startTs),
		endTs: int(r.endTs),
		mode: String(r.mode) as DayStateMode,
	};
	if (r.place !== null && r.place !== undefined) s.place = String(r.place);
	if (r.wayName !== null && r.wayName !== undefined) s.wayName = String(r.wayName);
	if (r.asleep !== null && r.asleep !== undefined) s.asleep = Boolean(r.asleep);
	if (r.tz !== null && r.tz !== undefined) s.tz = String(r.tz);
	if (r.minutesAsleep !== null && r.minutesAsleep !== undefined) s.minutesAsleep = int(r.minutesAsleep);
	if (r.inferred !== null && r.inferred !== undefined) s.inferred = Boolean(r.inferred);
	return s;
}

/** One drawn episode, as `encodeEpisode` wrote it. */
export function decodeEpisode(v: unknown): EpisodeGeometry {
	const r = v as Row;
	const e: EpisodeGeometry = {
		startTs: int(r.startTs),
		endTs: int(r.endTs),
		mode: String(r.mode) as EpisodeGeometry["mode"],
		kind: String(r.kind) as EpisodeGeometry["kind"],
		points: (r.points as Row[]).map((p) => {
			const pt: { lat: number; lon: number; ts?: number } = { lat: num(p.lat), lon: num(p.lon) };
			if (p.ts !== null && p.ts !== undefined) pt.ts = num(p.ts);
			return pt;
		}),
	};
	if (r.place !== null && r.place !== undefined) e.place = String(r.place);
	return e;
}

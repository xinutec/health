/**
 * `FoldCaptureFile` + `CapturedDay` → a `verified_cli day` request.
 *
 * Task #424. The wire format was decided by measurement first
 * (`lean/experiments/passfold-env-size.mts`): recorded answer tables for the
 * six mirror lookups, the day tables as data, and the road / walk solvers left
 * as shell callbacks so their 4.31 MiB/day of geometry never crosses. That is
 * 0.35 MiB/day steady state against the HSMM tenant's 33-40 (#411).
 *
 * # Floats cross as bit patterns, and so do the table KEYS
 *
 * Every float is a `Float64` bit pattern rendered as a decimal integer string,
 * the same convention as every other tenant, so both arms compare the same
 * doubles rather than two 6-decimal renderings of them.
 *
 * The lookup tables are keyed the same way, and that part is not cosmetic. A
 * recorded trace keys on `${lat}|${lon}|${radius}` — a JS number rendering.
 * Lean renders doubles differently, so a Lean-side key built from the same
 * double would not match the string, and a key that does not match is a MISS.
 * Re-keying on bits makes the two sides agree exactly or not at all.
 *
 * Recovering the double from the trace key is exact: JS `Number(String(x))`
 * round-trips, so `Number("51.502")` is bit-identical to the coordinate that
 * produced the key.
 *
 * # What a miss means
 *
 * `verified_cli day` aborts on an unanswered lookup rather than returning an
 * empty one, because empty is a real answer with a real meaning:
 * `LineMembership.scan` reads an empty served-station list as "line unknown"
 * and vetoes a journey that happened (#423). So a miss is a hard failure, and
 * it names the key. Run the CLI with `LEAN_ABORT_ON_PANIC=1` — measured, Lean's
 * `panic!` otherwise prints and CONTINUES with the default.
 *
 * A miss is a finding, not a gap in this encoder: it means the Lean fold asked
 * a question the TS cascade did not, which is a wiring divergence that output
 * comparison alone would not localise.
 *
 * THAT SENTENCE WAS FALSE FOR FOUR COMMITS, and the caveat is worth keeping.
 * It holds only because `answers` is now what the run itself answered. While
 * these tables were built from the fixture's `osmTrace`, a miss could equally
 * mean the encoder had handed Lean a narrower oracle than the TS arm used, and
 * nothing in the message distinguishes the two (#428). An encoder that decides
 * what the fold is allowed to ask has to be sure it is not the one failing.
 */

import type { CapturedDay } from "../cli/fixture-day.js";
import type { EnrichedSegment } from "../geo/enriched-segment.js";
import type { NominatimResult } from "../geo/osm.js";
import { DEFAULT_RADIUS_M } from "../geo/osm.js";
import type { OsmTrace } from "../geo/osm-adapter-recording.js";

/** `reverseGeocode`'s `zoom = 18` default, so a trace key that omitted it records
 *  the EFFECTIVE argument rather than a blank — the same choice `table3` makes
 *  for an omitted radius. */
const NOMINATIM_DEFAULT_ZOOM = 18;

import type { FoldCaptureFile } from "./fold-capture.js";

/** A `Float64` bit pattern as a decimal string — the bridge's float encoding. */
export function bits(x: number): string {
	const d = new DataView(new ArrayBuffer(8));
	d.setFloat64(0, x);
	return d.getBigUint64(0).toString();
}

const optBits = (x: number | null | undefined): string | null => (x === null || x === undefined ? null : bits(x));
const optStr = (x: string | null | undefined): string | null => (x === null || x === undefined ? null : x);

type Path = { lat: number; lon: number; ts: number }[] | undefined;
const path = (p: Path): string[][] | null =>
	p === undefined ? null : p.map((q) => [bits(q.lat), bits(q.lon), bits(q.ts)]);

/** One segment in the shape `Day.parseSeg` reads. */
export function encodeSeg(s: EnrichedSegment): unknown {
	return {
		startTs: s.startTs,
		endTs: s.endTs,
		mode: s.mode,
		refinedMode: optStr(s.refinedMode),
		confidence: bits(s.confidence),
		confidenceMargin: bits(s.confidenceMargin),
		avgSpeed: bits(s.avgSpeed),
		maxSpeed: bits(s.maxSpeed),
		linearity: bits(s.linearity),
		pointCount: s.pointCount,
		place: optStr(s.place),
		city: optStr(s.city),
		wayName: optStr(s.wayName),
		refinedReason: optStr(s.refinedReason),
		refinedKinds: s.refinedKinds ? [...s.refinedKinds] : [],
		centroidLat: optBits(s.centroidLat),
		centroidLon: optBits(s.centroidLon),
		// `focusPlaceId` is `string | number` in TS and `Option Int` in Lean.
		// Numeric ids are what the pipeline actually carries; a non-numeric one
		// would silently become NaN, so it is dropped rather than coerced.
		focusPlaceId: s.focusPlaceId === undefined || Number.isNaN(Number(s.focusPlaceId)) ? null : Number(s.focusPlaceId),
		needsReenrich: s.needsReenrich ?? false,
		vehicleKind: optStr(s.vehicleKind),
		roadCorridorFraction: optBits(s.roadCorridorFraction),
		displayTz: optStr(s.displayTz),
		snappedPath: path(s.snappedPath),
		matchedPath: path(s.matchedPath),
		walkMatchedPath: path(s.walkMatchedPath),
		walkSmoothedPath: path(s.walkSmoothedPath),
		biometrics: s.biometrics
			? {
					hrMean: optBits(s.biometrics.hrMean),
					hrMin: optBits(s.biometrics.hrMin),
					hrMax: optBits(s.biometrics.hrMax),
					hrStd: optBits(s.biometrics.hrStd),
					sampleCount: s.biometrics.sampleCount,
					overlapsSleep: s.biometrics.overlapsSleep,
					sleepFraction: bits(s.biometrics.sleepFraction),
					stepsTotal: optBits(s.biometrics.stepsTotal),
				}
			: null,
	};
}

/** Split an `osmTrace` key back into its numeric arguments. Exact: the key was
 *  built by JS number rendering, which round-trips. */
function keyNums(k: string): number[] {
	return k
		.split("|")
		.filter((s) => s !== "")
		.map(Number);
}

/** `[latBits, lonBits, radiusBits, answer]` from a trace section.
 *
 *  MEASURED, and it is why this takes a default: the trace keys on the radius
 *  the CALLER passed, and three of `velocity.ts`'s four `linesAtPoint` call
 *  sites pass none — so those entries are keyed `lat|lon|` while the adapter
 *  actually answered at `DEFAULT_RADIUS_M.linesAtPoint` (100 m). The Lean fold
 *  passes the radius explicitly, as a function of three arguments must, so it
 *  asks `lat|lon|100`: the same question in a different spelling, and without
 *  this it reads as a miss.
 *
 *  Filling in the default is recording the EFFECTIVE argument, the same choice
 *  `fold-capture.ts` makes for the `tzAt` fallback. It is not a widening: the
 *  omitted radius has exactly one value. */
function table3<T>(section: Record<string, T> | undefined, dflt: number, map: (v: T) => unknown): unknown[] {
	const out: unknown[] = [];
	for (const [k, v] of Object.entries(section ?? {})) {
		const n = keyNums(k);
		if (n.length < 2) continue;
		out.push([bits(n[0]), bits(n[1]), bits(n.length >= 3 ? n[2] : dflt), map(v)]);
	}
	return out;
}

/** `[latBits, lonBits, answer]`. The cascade's `nearbyWays` never passes a
 *  radius (`velocity.ts:1265`), which is why `Env.nearbyWays` takes two
 *  arguments — so only the two-part keys belong here. */
function table2<T>(section: Record<string, T> | undefined, map: (v: T) => unknown): unknown[] {
	const out: unknown[] = [];
	for (const [k, v] of Object.entries(section ?? {})) {
		const n = keyNums(k);
		if (n.length !== 2) continue;
		out.push([bits(n[0]), bits(n[1]), map(v)]);
	}
	return out;
}

/** `reverseGeocode(cityGrid(lat), cityGrid(lon), 16)` — the endpoint city lookup
 *  `enrichMovingSegment` makes, which reaches the fold through
 *  `reenrichSplitWalks`.
 *
 *  `[latBits, lonBits, zoom, address|null]`. The zoom crosses as a PLAIN INTEGER,
 *  unlike every other table key: it is a literal the caller writes (16 here, 18
 *  by default), not a measured double, so keying it on float bits would be a
 *  spelling both sides must agree on for nothing. The coordinates stay on bits
 *  for the usual reason — JS and Lean render doubles differently.
 *
 *  A `null` answer is Nominatim resolving nothing, which is a RESULT. Stored as
 *  such, so a key present with a null answer never reads as a miss.
 *
 *  Only the five address fields `extractCity` reads cross. The rest of a
 *  `NominatimResult` belongs to the venue namers, which the fold does not run. */
function geocodeTable(section: Record<string, NominatimResult | null> | undefined): unknown[] {
	const out: unknown[] = [];
	for (const [k, v] of Object.entries(section ?? {})) {
		const n = keyNums(k);
		if (n.length < 2) continue;
		out.push([
			bits(n[0]),
			bits(n[1]),
			n.length >= 3 ? n[2] : NOMINATIM_DEFAULT_ZOOM,
			v === null
				? null
				: {
						stateDistrict: optStr(v.address.state_district),
						city: optStr(v.address.city),
						town: optStr(v.address.town),
						village: optStr(v.address.village),
						municipality: optStr(v.address.municipality),
					},
		]);
	}
	return out;
}

/** Build the request.
 *
 *  `answers` is what the REPLAY'S OWN adapter answered, not the fixture's
 *  `osmTrace`, and the difference is a defect this used to have. Under
 *  `osmSource: "rows"` — golden's default — the TS arm gets a
 *  `RowSetOsmAdapter` that COMPUTES the four spatial lookups over raw OSM rows,
 *  so its coordinate domain is unbounded. `osmTrace` is a fixed record from an
 *  older capture, and on 2026-06-15 the TS arm asked `nearbyWays` about 69
 *  distinct coordinates of which 4 were not in the trace at all. Building the
 *  Lean tables from the trace therefore handed the fold a strictly SMALLER
 *  oracle and manufactured misses that say nothing about the port (#428).
 *
 *  It is also the second-order fix: the row set and the trace are two different
 *  oracles (#412), so a trace-built table can carry a different ANSWER for a
 *  key both hold, not merely be missing keys. A recorded table cannot.
 *
 *  `trace` asks for per-pass output, which is how a divergence gets attributed
 *  to the pass that produced it (#409) — off by default because it multiplies
 *  the response by 38. */
export function buildDayRequest(cap: FoldCaptureFile, day: CapturedDay, answers: OsmTrace, trace = false): unknown {
	const t = answers;
	const inputs = day.inputs;
	return {
		segs: cap.segsIn.map(encodeSeg),
		trace,
		env: {
			homeTz: inputs.homeTz,
			points: cap.obs.points.map((p) => [p.ts, bits(p.lat), bits(p.lon), bits(p.speedKmh)]),
			rawFixes: cap.obs.rawFixes.map((p) => [p.ts, bits(p.lat), bits(p.lon), optBits(p.accuracy)]),
			displayFixes: cap.obs.displayFixes.map((p) => [p.ts, bits(p.lat), bits(p.lon), optBits(p.accuracy)]),
			steps: cap.obs.steps.map((s) => [s.ts, bits(s.steps)]),
			hr: cap.obs.hr.map((h) => [h.ts, bits(h.bpm)]),
			sleep: cap.obs.sleep.map((s) => [s.startTs, s.endTs]),
			// Kalman speed at a timestamp — a projection of `points`, not a
			// separate observation, so it is derived here rather than captured.
			speedByTs: cap.obs.points.map((p) => [p.ts, bits(p.speedKmh)]),

			knownPlaces: inputs.knownPlaces.map((p) => [p.id, bits(p.centroidLat), bits(p.centroidLon)]),
			focusPlaceDays: inputs.knownPlaces.map((p) => [p.id, p.uniqueDays]),
			hsmmPlaces: inputs.knownPlaces.map((p) => [
				p.id,
				optStr(p.displayName),
				bits(p.centroidLat),
				bits(p.centroidLon),
			]),
			hmmDecode: (inputs.hsmmDecode ?? []).map((h) => ({
				startTs: h.startTs,
				endTs: h.endTs,
				mode: h.mode,
				lineName: optStr(h.lineName),
				placeId: h.placeId ?? null,
			})),
			railRouteCache: inputs.railRouteCache.map((r) => [
				r.routeKey,
				(JSON.parse(r.geometryJson) as { lat: number; lon: number }[]).map((p) => [bits(p.lat), bits(p.lon)]),
			]),
			busRouteCache: (inputs.busRouteCache ?? []).map((b) => ({
				routeRef: b.routeRef,
				routeName: optStr(b.routeName),
				osmRelationId: b.osmRelationId,
				stops: b.stops.map((s) => [optStr(s.name), bits(s.lat), bits(s.lon), s.seq]),
			})),
			railStops: (inputs.railStopsCache ?? []).map((r) => ({
				lineRef: optStr(r.lineRef),
				lineName: optStr(r.lineName),
				osmRelationId: r.osmRelationId,
				routeType: r.routeType,
				stops: r.stops.map((s) => [optStr(s.name), bits(s.lat), bits(s.lon), s.seq]),
			})),

			lookups: {
				nearbyStations: table3(t.nearbyStations, DEFAULT_RADIUS_M.nearbyStations, (v) =>
					v.map((s) => ({
						name: s.name,
						subtype: s.subtype,
						distanceM: bits(s.distanceM),
						lat: optBits(s.lat),
						lon: optBits(s.lon),
					})),
				),
				linesAtPoint: table3(t.linesAtPoint, DEFAULT_RADIUS_M.linesAtPoint, (v) => [...v]),
				transitStops: table3(t.nearbyTransitStops, DEFAULT_RADIUS_M.nearbyTransitStops, (v) =>
					v.map((s) => ({ subtype: s.subtype, distanceM: bits(s.distanceM) })),
				),
				nearbyWays: table2(t.nearbyWays, (v) =>
					v.map((w) => ({
						type: w.type,
						subtype: w.subtype,
						name: optStr(w.name),
						distanceM: optBits(w.distanceM),
					})),
				),
				stationsOnLine: Object.entries(t.stationsOnLine ?? {}).map(([line, v]) => [
					line,
					v.map((s) => [s.name, bits(s.lat), bits(s.lon)]),
				]),
				reverseGeocode: geocodeTable(t.reverseGeocode),
				// The two the adapter never saw — see `fold-capture.ts`.
				tzAt: cap.tzAt.map((q) => [bits(q.lat), bits(q.lon), q.tz]),
				bestPlace: cap.bestPlace.map((q) => [
					bits(q.lat),
					bits(q.lon),
					q.startTs,
					q.endTs,
					q.tz,
					q.label === null ? null : { label: q.label, city: q.city },
				]),
			},
		},
	};
}

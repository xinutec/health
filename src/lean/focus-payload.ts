/**
 * The `verified_cli focus` wire format, and the TS arm's own rendering of what
 * comes back on it.
 *
 * The counterpart of `fold-payload.ts` for the focus-place mining referee
 * (#435). It is far smaller, and the reason is the whole point of that task:
 * `detectFocusPlaces` takes a point list and nothing else — no `OsmAdapter`, no
 * lookup tables, so there is no recorded-vs-computed oracle to get wrong (#428)
 * and no demand-driven rounds. One pure function, one input.
 *
 * Floats cross as IEEE-754 bit patterns (`float-bits.ts`), so the comparison is
 * on the same doubles rather than on two six-decimal renderings.
 *
 * `report` is deliberately WIDER than the cluster record: it carries every
 * value `src/cli/refresh-focus-places.ts` derives from a mined cluster before
 * writing the row — the label, the serialised hour profile and its re-parse,
 * both sleep-hour estimates, the distinct-day count. So one comparison covers
 * the classification layer as well as the geometry, in the cron's own order.
 * The Lean twin is `Focus.report` in `lean/Main.lean`, and the two must keep
 * mirroring each other.
 */

import {
	type Cluster,
	classifyCluster,
	hourProfileForRange,
	hourProfileOf,
	parseHourProfile,
	type Stay,
	serializeHourProfile,
	sleepHoursFromFitbit,
	sleepHoursOf,
	uniqueDayCount,
} from "../geo/focus-places.js";
import { floatToBits } from "./float-bits.js";

/** `[startTs, endTs, latBits, lonBits, pointCount, durationSec]`. */
export type WireStay = [number, number, string, string, number, number];
/** `[ts, latBits, lonBits, accBits | null]` — the same point shape the Kalman
 *  and gpsquality modes take. */
export type WirePoint = [number, string, string, string | null];
/** `[id, latBits, lonBits, firstSeenTs]`. */
export type WireExisting = [number, string, string, number];

export interface WireCluster {
	id: number;
	lat: string;
	lon: string;
	dwell: number;
	stays: WireStay[];
}

export interface FocusRequest {
	points: WirePoint[];
	sleepWindows: [number, number][];
	/** Clusters that go straight to `splitCluster`, bypassing the miner. The
	 *  captured café/residence and Home clusters are months of history each, so
	 *  no single day's points can reproduce them. */
	clusters: WireCluster[];
	/** Existing rows for `matchClusters` to hold identity against. */
	old: WireExisting[];
}

export function encodeStay(s: Stay): WireStay {
	return [s.startTs, s.endTs, floatToBits(s.centroidLat), floatToBits(s.centroidLon), s.pointCount, s.durationSec];
}

export function encodeCluster(c: Cluster): WireCluster {
	return {
		id: c.id,
		lat: floatToBits(c.centroidLat),
		lon: floatToBits(c.centroidLon),
		dwell: c.totalDwellSec,
		stays: c.stays.map(encodeStay),
	};
}

/** A cluster and everything the mining cron derives from it.
 *
 *  The hour profile is rendered BOTH serialised and re-parsed: the column
 *  stores permille integers, so comparing only the string would let
 *  `parseHourProfile` drift unseen, and comparing only the parse would hide a
 *  rounding difference that is what actually gets stored. */
export function report(c: Cluster, sleepWindows: { startTs: number; endTs: number }[]): Record<string, unknown> {
	const profile = serializeHourProfile(hourProfileOf(c));
	const first = c.stays[0];
	return {
		id: c.id,
		lat: floatToBits(c.centroidLat),
		lon: floatToBits(c.centroidLon),
		dwell: c.totalDwellSec,
		stays: c.stays.map(encodeStay),
		label: classifyCluster(c).label,
		profile,
		reparsed: parseHourProfile(profile)?.map(floatToBits) ?? null,
		// `hourProfileForRange` is the RUNTIME counterpart of `hourProfileOf` — it
		// scores one live stay against a mined profile — so it runs here on the
		// cluster's own first stay rather than being left to the guards.
		firstStayProfile:
			first === undefined ? null : serializeHourProfile(hourProfileForRange(first.startTs, first.endTs, c.centroidLon)),
		sleepH: floatToBits(sleepHoursOf(c)),
		sleepFitbitH: floatToBits(sleepHoursFromFitbit(c.stays, sleepWindows)),
		uniqueDays: uniqueDayCount(c.stays, c.centroidLon),
	};
}

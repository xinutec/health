/**
 * Rescue a short, clean-GPS Underground hop that the rail passes missed.
 *
 * The underground-reconstruction pass (`annotateUndergroundRuns`) only fires
 * on a run that is **≥180 s** *and* built from **coarse** cell-tower fixes —
 * the degraded GPS a deep tunnel usually produces. A *short* tube hop whose
 * GPS happens to surface cleanly (fixes landing on the platforms) trips
 * neither gate, so it stays inside its host walking segment until
 * `splitWalksOnVehicleLeg` carves it out as a `driving` leg — and by then the
 * rail passes have already run. The only remaining mode-assigning passes are
 * the bus passes, which happily name it after whatever route shares the
 * corridor.
 *
 * Real case (2026-06-29): Euston Square → Baker Street on the sub-surface line
 * (Circle/H&C/Metropolitan), ~35 km/h, mislabelled "bus 18" because route 18
 * runs the same Marylebone Road corridor.
 *
 * The rule here, run AFTER railJourney (so it can't trigger a journey
 * over-merge) and BEFORE the bus passes:
 *
 *   A *motorised* (`driving`) leg whose board + alight fixes both resolve to
 *   stations sharing at least one Underground line, AND whose average speed is
 *   above sustained central-London bus pace, is a tube. Upgrade it to `train`
 *   (which makes it ineligible for the bus passes, since those only touch
 *   `driving` legs).
 *
 * Why speed is the discriminator: on a shared bus/tube corridor the station
 * geometry can't tell the two apart (a bus on Marylebone Road passes the same
 * kerbside tube stations). But a London bus averages ~15–20 km/h over a
 * central leg; a tube hop averages ~25–40. So the station-pair establishes
 * "this is a rail corridor at all", and the speed gate separates tube from
 * bus. A genuinely slow leg is left `driving` for the bus matcher to judge.
 *
 * Second sufficient signature — the **blackout hop** (2026-07-07): a ONE-stop
 * sub-surface ride is too slow for the speed gate (platform dwell drags the
 * leg average to ~19 km/h) but has a structure no surface vehicle produces:
 * nearly all of the leg's net displacement sits in a single inter-fix hop at
 * motorised implied speed (the tunnel blackout — the phone last fixed at the
 * board station and next fixed at the alight station), while every *observed*
 * portion of the leg moves at walking pace (platform access). A bus's
 * observed portions move at bus pace and its displacement is spread across
 * fixes; even a bus that loses signal mid-ride keeps vehicle-pace fixes
 * either side of the hole. A leg with this signature between two stations on
 * a shared line is a tube regardless of its average speed.
 */

import { type NearbyStation, pickBestStation } from "../osm.js";
import { haversineMeters } from "../place-snap.js";
import { effectiveMode, samplesInWindow } from "../segment-util.js";
import type { TransportMode } from "../segments.js";
import { expandTubeLineNames } from "./rail-runs.js";

/** Minimum average speed (km/h) for a station-to-station leg to read as a tube
 *  rather than a bus. Above sustained central-London bus pace (~15–20 km/h),
 *  comfortably below tube line speed. Set conservatively — a slower hop is
 *  left to the blackout signature or the bus matcher (a missed upgrade is
 *  safe; calling a bus a tube is not). */
export const TUBE_HOP_MIN_AVG_KMH = 28;

/** Blackout hop: minimum fraction of the leg's net displacement carried by
 *  its single largest inter-fix hop. Below this the ride was substantially
 *  observed — surface vehicle territory. */
export const TUBE_HOP_BLACKOUT_MIN_SHARE = 0.6;
/** Blackout hop: minimum implied speed (km/h) across that largest hop —
 *  the unobserved stretch must have been motorised, not a slow indoor drift. */
export const TUBE_HOP_BLACKOUT_MIN_KMH = 25;
/** Blackout hop: maximum average speed (km/h) of the leg *outside* the
 *  largest hop. Walking pace — the observed parts are platform access, not a
 *  rolling bus. */
export const TUBE_HOP_SURFACE_MAX_KMH = 8;

/** The tunnel-blackout structure of a short Underground ride: the leg's
 *  displacement is concentrated in one motorised inter-fix hop and everything
 *  observed around it moves at walking pace. Returns the hop's bounding fix
 *  indices — last-seen-before-the-tunnel / first-seen-after are the board /
 *  alight evidence (the leg's own first fix trails the preceding walk through
 *  Kalman lag and can resolve to the wrong station). Robust to a surviving
 *  poor-accuracy fix mid-blackout (it splits the gap in two; the reacquire
 *  hop still carries the displacement). Null = no blackout signature. */
function findBlackoutHop(
	fixes: ReadonlyArray<{ ts: number; lat: number; lon: number }>,
): { start: number; end: number } | null {
	const first = fixes[0];
	const last = fixes[fixes.length - 1];
	const netM = haversineMeters(first.lat, first.lon, last.lat, last.lon);
	if (netM <= 0) return null;
	let bestM = 0;
	let bestS = 0;
	let bestEnd = 0;
	let totalM = 0;
	for (let i = 1; i < fixes.length; i++) {
		const d = haversineMeters(fixes[i - 1].lat, fixes[i - 1].lon, fixes[i].lat, fixes[i].lon);
		totalM += d;
		if (d > bestM) {
			bestM = d;
			bestS = fixes[i].ts - fixes[i - 1].ts;
			bestEnd = i;
		}
	}
	if (bestM / netM < TUBE_HOP_BLACKOUT_MIN_SHARE) return null;
	// A zero-duration hop (duplicate-ts fixes) is still a teleport.
	const impliedKmh = bestS > 0 ? (bestM / bestS) * 3.6 : Number.POSITIVE_INFINITY;
	if (impliedKmh < TUBE_HOP_BLACKOUT_MIN_KMH) return null;
	const surfaceS = last.ts - first.ts - bestS;
	const surfaceKmh = surfaceS > 0 ? ((totalM - bestM) / surfaceS) * 3.6 : 0;
	return surfaceKmh <= TUBE_HOP_SURFACE_MAX_KMH ? { start: bestEnd - 1, end: bestEnd } : null;
}

type TubeHopSegment = {
	startTs: number;
	endTs: number;
	mode: TransportMode;
	refinedMode?: TransportMode;
	refinedReason?: string;
	wayName?: string;
	avgSpeed: number;
};

/**
 * Upgrade fast station-to-station `driving` legs to `train`. Pure: all OSM
 * access is through the two injected lookups (mirroring `annotateRailRuns`).
 * Segments that don't qualify pass through untouched.
 */
export async function upgradeTubeHops<T extends TubeHopSegment>(
	segments: T[],
	points: ReadonlyArray<{ ts: number; lat: number; lon: number }>,
	stationsLookup: (lat: number, lon: number) => Promise<NearbyStation[]>,
	linesLookup: (lat: number, lon: number) => Promise<Set<string>>,
): Promise<T[]> {
	const out: T[] = [];
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (effectiveMode(seg) !== "driving") {
			out.push(seg);
			continue;
		}
		// A genuine isolated tube hop is bracketed by walks (walk to the
		// station, ride, walk out). A fast driving leg sitting immediately
		// next to a `train` is a fragment of THAT ride — surfaced GPS at the
		// tail/head of a longer run, or an interchange sliver — not a separate
		// hop. Upgrading it spuriously splits one ride into pieces (the
		// 2026-06-17 Wembley Park → King's Cross tail). Leave it to the rail
		// reconcile/absorb machinery. Checked before any OSM lookup so an
		// adjacent-train day makes no new query and stays fixture-stable.
		const prev = segments[i - 1];
		const next = segments[i + 1];
		if ((prev && effectiveMode(prev) === "train") || (next && effectiveMode(next) === "train")) {
			out.push(seg);
			continue;
		}
		const fixes = samplesInWindow(points, seg);
		if (fixes.length < 2) {
			out.push(seg);
			continue;
		}
		// Two sufficient structural signatures, both pure (no OSM): fast enough
		// that no bus explains the average, OR the tunnel-blackout shape. Checked
		// before the lookups so a leg with neither makes no new OSM query.
		const blackout = seg.avgSpeed < TUBE_HOP_MIN_AVG_KMH ? findBlackoutHop(fixes) : null;
		if (seg.avgSpeed < TUBE_HOP_MIN_AVG_KMH && !blackout) {
			out.push(seg);
			continue;
		}
		const board = blackout ? fixes[blackout.start] : fixes[0];
		const alight = blackout ? fixes[blackout.end] : fixes[fixes.length - 1];

		const [boardStations, alightStations] = await Promise.all([
			stationsLookup(board.lat, board.lon),
			stationsLookup(alight.lat, alight.lon),
		]);
		const boardStation = pickBestStation(boardStations);
		const alightStation = pickBestStation(alightStations);
		// Both endpoints must be real, distinct stations. This is the gate a
		// taxi/car between arbitrary addresses fails — its endpoints aren't
		// stations.
		if (!boardStation || !alightStation || boardStation.name === alightStation.name) {
			out.push(seg);
			continue;
		}

		const [boardLines, alightLines] = await Promise.all([
			linesLookup(board.lat, board.lon),
			linesLookup(alight.lat, alight.lon),
		]);
		// OSM names each travel direction as its own line; canonicalise before
		// intersecting (same as resolveRailRunLabel). At least one shared line
		// ⇒ a single Underground line serves both ends ⇒ a rail corridor.
		const boardCanon = new Set([...boardLines].flatMap(expandTubeLineNames));
		const alightCanon = new Set([...alightLines].flatMap(expandTubeLineNames));
		const shared = [...boardCanon].filter((l) => alightCanon.has(l));
		if (shared.length === 0) {
			out.push(seg);
			continue;
		}

		// Name the line only when exactly one is shared; the sub-surface
		// stations share three (Circle/H&C/Met), so fall back to the bare
		// station-pair label there.
		const base = `${boardStation.name} → ${alightStation.name}`;
		const wayName = shared.length === 1 ? `${base} · ${shared[0]}` : base;
		out.push({
			...seg,
			mode: "train",
			refinedMode: "train",
			wayName,
			refinedReason: `tube hop ${blackout ? "blackout" : "station-pair"}${seg.refinedReason ? ` (was: ${seg.refinedReason})` : ""}`,
		});
	}
	return out;
}

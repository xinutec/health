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
 */

import { type NearbyStation, pickBestStation } from "../osm.js";
import { effectiveMode, samplesInWindow } from "../segment-util.js";
import type { TransportMode } from "../segments.js";
import { expandTubeLineNames } from "./rail-runs.js";

/** Minimum average speed (km/h) for a station-to-station leg to read as a tube
 *  rather than a bus. Above sustained central-London bus pace (~15–20 km/h),
 *  comfortably below tube line speed. The sole bus/tube discriminator on a
 *  shared corridor, so it is set conservatively — a slower hop is left
 *  `driving` (a missed upgrade is safe; calling a bus a tube is not). */
export const TUBE_HOP_MIN_AVG_KMH = 28;

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
		if (effectiveMode(seg) !== "driving" || seg.avgSpeed < TUBE_HOP_MIN_AVG_KMH) {
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
		const board = fixes[0];
		const alight = fixes[fixes.length - 1];

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
			refinedReason: `tube hop station-pair${seg.refinedReason ? ` (was: ${seg.refinedReason})` : ""}`,
		});
	}
	return out;
}

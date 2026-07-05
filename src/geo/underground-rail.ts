/**
 * Underground rail-run reconstruction.
 *
 * When a journey goes underground the phone loses GPS and falls back to
 * cell-tower positioning, which emits *coarse* fixes — accuracy ~100 m
 * or worse, often snapping near whatever station the train is passing.
 * Those fixes are useless for a smoother (you can't denoise a 6 km
 * accuracy radius into a trajectory) but they are not noise: a run of
 * them tends to land near the consecutive stations of the line the
 * train is on.
 *
 * `reconstructUndergroundRun` reads that signal. Given the coarse fixes
 * inside a suspected underground stretch plus the well-located fixes
 * that bracket it (the boarding and alighting ends), it asks: is there
 * a single rail line that (a) serves both the boarding and alighting
 * ends and (b) is hugged by the coarse fixes in between? The coarse
 * fixes are what disambiguate parallel lines — two lines may both
 * connect the endpoints, but only the one actually travelled is the
 * one the mid-journey coarse fixes sit on.
 *
 * This is deliberately a *discrete* inference (which line?), kept
 * separate from smoothing and from quality control. It needs no
 * ordered line topology — only the existing "which line names are
 * near this point" lookup.
 */

import type { EnrichedSegment } from "./enriched-segment.js";
import type { NearbyStation, NearbyWay } from "./osm.js";
import { pickBestStation } from "./osm.js";
import { dbOsmAdapter } from "./osm-adapter.js";
import { expandTubeLineNames } from "./passes/rail-runs.js";

/** A raw GPS fix with its reported accuracy radius, in metres. */
export interface CoarseFix {
	ts: number;
	lat: number;
	lon: number;
	accuracy: number | null;
}

export interface UndergroundRun {
	/** The rail/metro line the journey used. */
	line: string;
	boardingStation: string;
	alightingStation: string;
	/** Timestamps of the first and last coarse fix — the underground
	 *  window, used to carve the train segment out of its host. */
	startTs: number;
	endTs: number;
}

/** Accuracy (m) at or above which a fix is treated as a cell-network
 *  fallback ("coarse"), not a real GPS fix. Open-air GPS sits well
 *  under this; ~100 m is the typical network-positioning floor. */
export const COARSE_ACCURACY_M = 100;

/** Radius (m) for the `nearbyStations` lookups annotateUndergroundRuns
 *  uses. Wider than annotateRailRuns' 400 m because underground coarse
 *  fixes have larger reported uncertainty and the station node may sit
 *  outside the run's centroid. Exported so the velocity-layer caller
 *  threads the same radius when passing its own adapter-backed lookup. */
export const UNDERGROUND_STATION_RADIUS_M = 350;

/** Radius (m) for the `linesAtPoint` lookups annotateUndergroundRuns
 *  uses. Wider than the default 100 m because the coarse fix's
 *  reported coordinate may sit further from the actual track. */
export const UNDERGROUND_LINES_RADIUS_M = 300;

/** Accuracy (m) above which even a coarse fix is unusable: its
 *  reported coordinate is so uncertain that snapping it to a station
 *  is meaningless (a total-GPS-loss fix can report a multi-kilometre
 *  radius). Such fixes are ignored entirely. */
export const COARSE_ACCURACY_MAX_M = 800;

/** Minimum coarse fixes required to call a stretch an underground run.
 *  One coarse fix is a blip; a run of them is a journey. */
const MIN_COARSE_FIXES = 2;

/** Minimum straight-line distance (m) between the boarding and
 *  alighting ends for the stretch to count as a journey. Coarse fixes
 *  clustered around a single station — a platform wait or a same-
 *  station interchange — fall under this and are not reconstructed. */
const MIN_JOURNEY_M = 800;

type LinesLookup = (lat: number, lon: number) => Promise<Set<string>>;
type WaysLookup = (lat: number, lon: number) => Promise<NearbyWay[]>;
type StationsLookup = (lat: number, lon: number) => Promise<NearbyStation[]>;

/** A coarse cell-network fix whose coordinate is reliable enough to
 *  snap to a station (accuracy in [COARSE_ACCURACY_M, COARSE_ACCURACY_MAX_M]). */
function isCoarse(f: CoarseFix): boolean {
	return f.accuracy != null && f.accuracy >= COARSE_ACCURACY_M && f.accuracy <= COARSE_ACCURACY_MAX_M;
}

/** Any fix that marks the GPS-dark window — a coarse cell-network fix OR
 *  a total-loss fix (accuracy above COARSE_ACCURACY_MAX_M, a multi-km
 *  radius). Total-loss fixes can't be snapped to a station, but their
 *  *presence* is itself the underground signal: open-air GPS does not
 *  report kilometre-scale uncertainty, deep tube does. Counting them when
 *  detecting the dark window (not when snapping) is what lets a deep-tube
 *  leg whose few coarse fixes are interleaved with total-loss garbage —
 *  too short a coarse-only run to qualify — still be recognised. */
function isUndergroundSignal(f: CoarseFix): boolean {
	return f.accuracy != null && f.accuracy >= COARSE_ACCURACY_M;
}

/**
 * Identify the underground line of a journey from its coarse fixes.
 *
 * `fixes` is every fix inside the suspected underground stretch;
 * `boardingFix` / `alightingFix` are the last well-located fix before
 * it and the first one after. Returns the reconstructed run, or null
 * when the evidence does not single out one line.
 */
export async function reconstructUndergroundRun(
	fixes: CoarseFix[],
	boardingFix: { lat: number; lon: number },
	alightingFix: { lat: number; lon: number },
	stationsLookup: StationsLookup,
	linesLookup: LinesLookup,
): Promise<UndergroundRun | null> {
	const coarse = fixes.filter(isCoarse).sort((a, b) => a.ts - b.ts);
	if (coarse.length < MIN_COARSE_FIXES) return null;

	// Lines that serve the boarding and alighting ends.
	const boardLines = await linesLookup(boardingFix.lat, boardingFix.lon);
	const alightLines = await linesLookup(alightingFix.lat, alightingFix.lon);
	if (boardLines.size === 0 || alightLines.size === 0) return null;

	// Lines under each coarse fix — the path the train actually hugged.
	const coarseLineSets = await Promise.all(coarse.map((f) => linesLookup(f.lat, f.lon)));

	// A candidate line serves both ends AND is hugged by at least one
	// coarse fix. Score each by how many coarse fixes sit on it, so a
	// parallel line that merely connects the endpoints loses to the one
	// the journey actually followed.
	const candidates = new Map<string, number>();
	for (const line of boardLines) {
		if (!alightLines.has(line)) continue;
		const onCoarse = coarseLineSets.reduce((n, s) => n + (s.has(line) ? 1 : 0), 0);
		if (onCoarse > 0) candidates.set(line, onCoarse);
	}
	if (candidates.size === 0) return null;
	const line = [...candidates.entries()].sort((a, b) => b[1] - a[1])[0][0];

	const board = pickBestStation(await stationsLookup(boardingFix.lat, boardingFix.lon));
	const alight = pickBestStation(await stationsLookup(alightingFix.lat, alightingFix.lon));
	if (!board || !alight) return null;

	// A run must go *between two distinct stations over a real
	// distance*. Coarse fixes clustered at one station (a platform wait,
	// a same-station interchange) resolve both ends to the same place —
	// that is not a journey.
	if (board.name === alight.name) return null;
	if (equirectMeters(boardingFix.lat, boardingFix.lon, alightingFix.lat, alightingFix.lon) < MIN_JOURNEY_M) {
		return null;
	}

	return {
		line,
		boardingStation: board.name,
		alightingStation: alight.name,
		startTs: coarse[0].ts,
		endTs: coarse[coarse.length - 1].ts,
	};
}

/**
 * Reconstruct an underground journey as ONE or TWO line legs.
 *
 * A single coarse run can span an interchange: the cell-network fixes hug
 * one line, GPS briefly recovers on the platform at the changeover (a small
 * cluster of well-located `interchangeFixes` mid-run), then coarse fixes hug
 * the next line. No single line serves both ends, so {@link
 * reconstructUndergroundRun} alone returns null and the whole ride is lost
 * (the 2026-06-28 Highbury & Islington → King's Cross [Victoria] → Wembley
 * Park [Metropolitan] return).
 *
 * Strategy: try a single through-line first (the common case — unchanged). If
 * that fails AND a mid-run good-fix cluster pins a plausible interchange,
 * split the coarse fixes there and reconstruct each half independently. Two
 * legs are returned only when both halves resolve to a real single-line
 * journey AND agree on the interchange station — so a spurious mid-run blip
 * cannot manufacture a phantom change.
 */
export async function reconstructUndergroundJourney(
	fixes: CoarseFix[],
	interchangeFixes: CoarseFix[],
	boardingFix: { lat: number; lon: number },
	alightingFix: { lat: number; lon: number },
	stationsLookup: StationsLookup,
	linesLookup: LinesLookup,
): Promise<UndergroundRun[]> {
	const single = await reconstructUndergroundRun(fixes, boardingFix, alightingFix, stationsLookup, linesLookup);
	if (single) return [single];

	const coarse = fixes.filter(isCoarse).sort((a, b) => a.ts - b.ts);
	if (coarse.length < 2 * MIN_COARSE_FIXES) return []; // not enough to split into two real legs

	// A genuine interchange means the rider could NOT have stayed on one line:
	// the boarding end is not served by the second leg's line, and the
	// alighting end is not served by the first leg's. This rejects a
	// parallel-line corridor (e.g. Metropolitan/Jubilee through Finchley Road,
	// or Metropolitan/Circle/H&C at Baker Street) where one line actually serves
	// both ends and the per-fix line lookup merely disagrees — a single ride,
	// not a change (2026-06-23 Wembley Park → Euston Square, all Metropolitan).
	const boardLines = await linesLookup(boardingFix.lat, boardingFix.lon);
	const alightLines = await linesLookup(alightingFix.lat, alightingFix.lon);

	// Candidate interchanges: clusters of good fixes that surfaced mid-run,
	// each separated by a recovered-GPS gap. Order by time.
	const mid = interchangeFixes
		.filter((f) => f.ts > coarse[0].ts && f.ts < coarse[coarse.length - 1].ts)
		.sort((a, b) => a.ts - b.ts);
	const clusters: CoarseFix[][] = [];
	for (const f of mid) {
		const cur = clusters.at(-1);
		if (cur && f.ts - cur[cur.length - 1].ts <= MAX_COARSE_GAP_S) cur.push(f);
		else clusters.push([f]);
	}

	for (const cluster of clusters) {
		const ixTs = cluster[Math.floor(cluster.length / 2)].ts;
		const ixPt = {
			lat: cluster.reduce((s, f) => s + f.lat, 0) / cluster.length,
			lon: cluster.reduce((s, f) => s + f.lon, 0) / cluster.length,
		};
		const before = coarse.filter((f) => f.ts < ixTs);
		const after = coarse.filter((f) => f.ts > ixTs);
		if (before.length < MIN_COARSE_FIXES || after.length < MIN_COARSE_FIXES) continue;
		const leg1 = await reconstructUndergroundRun(before, boardingFix, ixPt, stationsLookup, linesLookup);
		const leg2 = await reconstructUndergroundRun(after, ixPt, alightingFix, stationsLookup, linesLookup);
		if (!leg1 || !leg2 || leg1.alightingStation !== leg2.boardingStation) continue;

		// Compare PHYSICAL lines, not OSM relation strings: "Metropolitan Line"
		// and "Circle, Hammersmith & City and Metropolitan Lines" are the same
		// line. Both halves must be on genuinely distinct lines that meet at one
		// station, and neither end could have ridden straight through on the
		// other half's line — otherwise it is a parallel-line corridor (Met/Jubilee
		// at Finchley Road, Met/Circle/H&C at Baker Street), a single ride the
		// per-fix line lookup merely disagrees on (2026-06-23 Wembley Park →
		// Euston Square, all Metropolitan).
		const expand = (names: Iterable<string>): Set<string> => new Set([...names].flatMap(expandTubeLineNames));
		const leg1Lines = expand([leg1.line]);
		const leg2Lines = expand([leg2.line]);
		const disjoint = (a: Set<string>, b: Set<string>): boolean => ![...a].some((x) => b.has(x));
		if (
			disjoint(leg1Lines, leg2Lines) &&
			disjoint(expand(boardLines), leg2Lines) &&
			disjoint(expand(alightLines), leg1Lines)
		) {
			return [leg1, leg2];
		}
	}
	return [];
}

/** Shortest underground run worth carving out (s). Below this, a stray
 *  pair of coarse fixes in an ordinary walk is just noise. */
const MIN_RUN_DURATION_S = 180;

/** A surviving side-piece (the walk before/after the tube) shorter than
 *  this is absorbed into the train segment rather than kept as its own
 *  sliver. */
const MIN_SIDE_DURATION_S = 60;

/** Gap (s) between consecutive coarse fixes above which they belong to
 *  separate runs: GPS recovered in between, so a later unrelated coarse
 *  blip (poor indoor GPS at the destination) is not the same journey. */
const MAX_COARSE_GAP_S = 300;

function equirectMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const dLat = (lat2 - lat1) * 111_320;
	const dLon = (lon2 - lon1) * 111_320 * Math.cos((lat1 * Math.PI) / 180);
	return Math.sqrt(dLat * dLat + dLon * dLon);
}

/**
 * Find underground runs hiding inside the day's segments and carve them
 * out as their own `train` segments.
 *
 * Underground, the coarse cell-network fixes either smear a host
 * segment into a slow "walk" (when they leak into the smoother) or sit
 * inside an inferred GPS-gap segment. Either way the host segment spans
 * `walk → tube → walk`. For each non-stationary segment that is not
 * already an annotated rail run, this looks for a run of coarse fixes,
 * reconstructs the line via {@link reconstructUndergroundRun}, and — on
 * success — splits the host into up to three segments: the walk before,
 * the reconstructed `train`, and the walk after. Side pieces shorter
 * than {@link MIN_SIDE_DURATION_S} are absorbed so the train segment
 * covers the host's full span with no slivers.
 *
 * Purely additive: a segment with no coarse-fix run passes through
 * untouched, so days with no underground travel are unaffected.
 */
export async function annotateUndergroundRuns(
	segments: EnrichedSegment[],
	rawFixes: CoarseFix[],
	stationsLookup: StationsLookup = (lat, lon) => dbOsmAdapter.nearbyStations(lat, lon, UNDERGROUND_STATION_RADIUS_M),
	linesLookup: LinesLookup = (lat, lon) => dbOsmAdapter.linesAtPoint(lat, lon, UNDERGROUND_LINES_RADIUS_M),
	waysLookup: WaysLookup = (lat, lon) => dbOsmAdapter.nearbyWays(lat, lon),
): Promise<EnrichedSegment[]> {
	const good = rawFixes.filter((f) => f.accuracy == null || f.accuracy < COARSE_ACCURACY_M);
	const result: EnrichedSegment[] = [];

	for (const host of segments) {
		const alreadyRail = host.mode === "train" && (host.wayName ?? "").includes("→");
		if (host.mode === "stationary" || alreadyRail) {
			result.push(host);
			continue;
		}

		// Cluster the host's GPS-dark fixes (coarse OR total-loss) into runs.
		// A gap longer than MAX_COARSE_GAP_S between consecutive dark fixes
		// means GPS recovered in between — one run ended — so a later
		// unrelated blip cannot be mistaken for part of the same journey.
		// Total-loss fixes are counted here (window detection) but not for
		// snapping (reconstructUndergroundRun re-filters to coarse): they
		// extend a deep-tube window whose coarse fixes alone are too sparse.
		const hostCoarse = rawFixes
			.filter((f) => f.ts >= host.startTs && f.ts <= host.endTs && isUndergroundSignal(f))
			.sort((a, b) => a.ts - b.ts);
		const runs: CoarseFix[][] = [];
		for (const f of hostCoarse) {
			const cur = runs.at(-1);
			if (cur && f.ts - cur[cur.length - 1].ts <= MAX_COARSE_GAP_S) cur.push(f);
			else runs.push([f]);
		}
		const span = (r: CoarseFix[]): number => r[r.length - 1].ts - r[0].ts;
		// The journey is the longest-spanning run that clears the bar.
		const runFixes = runs
			.filter((r) => r.length >= MIN_COARSE_FIXES && span(r) >= MIN_RUN_DURATION_S)
			.sort((a, b) => span(b) - span(a))[0];
		if (!runFixes) {
			result.push(host);
			continue;
		}

		const boarding = [...good].reverse().find((f) => f.ts <= runFixes[0].ts);
		const alighting = good.find((f) => f.ts >= runFixes[runFixes.length - 1].ts);
		if (!boarding || !alighting) {
			result.push(host);
			continue;
		}

		// Good fixes that surfaced INSIDE the run are interchange candidates —
		// the platform where the rider changed lines (the run spans a change).
		const midGood = good.filter((f) => f.ts > runFixes[0].ts && f.ts < runFixes[runFixes.length - 1].ts);
		const legs = await reconstructUndergroundJourney(
			runFixes,
			midGood,
			boarding,
			alighting,
			stationsLookup,
			linesLookup,
		);
		if (legs.length === 0) {
			result.push(host);
			continue;
		}

		// The train window spans the GPS-dark stretch — last good fix before
		// the run to the first one after, clamped to the host. That covers the
		// real ride (entering the station, the tunnel, surfacing), not just the
		// mid-tunnel coarse-fix span.
		const darkStart = Math.max(host.startTs, boarding.ts);
		const darkEnd = Math.min(host.endTs, alighting.ts);
		const keepPre = darkStart - host.startTs >= MIN_SIDE_DURATION_S;
		const keepPost = host.endTs - darkEnd >= MIN_SIDE_DURATION_S;
		const trainStart = keepPre ? darkStart : host.startTs;
		const trainEnd = keepPost ? darkEnd : host.endTs;

		const distM = equirectMeters(boarding.lat, boarding.lon, alighting.lat, alighting.lon);
		const speedKmh = Math.round((distM / Math.max(1, trainEnd - trainStart)) * 3.6 * 10) / 10;

		// Boundaries between consecutive legs: the changeover sits between one
		// leg's last coarse fix and the next leg's first.
		const boundaries: number[] = [];
		for (let li = 0; li < legs.length - 1; li++) {
			boundaries.push(Math.round((legs[li].endTs + legs[li + 1].startTs) / 2));
		}

		if (keepPre) {
			result.push({
				...host,
				endTs: trainStart,
				wayName: await sideWayName(good, host.startTs, trainStart, waysLookup),
			});
		}
		for (let li = 0; li < legs.length; li++) {
			const leg = legs[li];
			const segStart = li === 0 ? trainStart : boundaries[li - 1];
			const segEnd = li === legs.length - 1 ? trainEnd : boundaries[li];
			const reason =
				legs.length > 1
					? `underground reconstruction (interchange leg ${li + 1}/${legs.length} on ${leg.line})`
					: `underground reconstruction (${runFixes.length} coarse fixes on ${leg.line})`;
			result.push({
				...host,
				startTs: segStart,
				endTs: segEnd,
				mode: "train",
				refinedMode: "train",
				confidence: 0.6,
				confidenceMargin: 1.5,
				avgSpeed: speedKmh,
				maxSpeed: speedKmh,
				linearity: 1,
				pointCount: 0,
				place: undefined,
				city: undefined,
				wayName: `${leg.boardingStation} → ${leg.alightingStation} · ${leg.line}`,
				refinedReason: reason,
			});
		}
		if (keepPost) {
			result.push({
				...host,
				startTs: trainEnd,
				wayName: await sideWayName(good, trainEnd, host.endTs, waysLookup),
			});
		}
	}

	return result;
}

/** Way label for a side piece of a split host, from the PIECE's own
 *  fixes. The host's wayName was composed across ALL its fixes — both
 *  walks plus the tunnel — so inheriting it stamps the pre-tube walk's
 *  street onto the post-tube walk at the other end of town (measured:
 *  a King's Cross walk labelled with a Belgravia street, task #248).
 *  Undefined when the piece has no fixes or no named way nearby —
 *  honest blank beats a leaked label. */
async function sideWayName(
	good: CoarseFix[],
	startTs: number,
	endTs: number,
	waysLookup: WaysLookup,
): Promise<string | undefined> {
	const inPiece = good.filter((f) => f.ts >= startTs && f.ts <= endTs);
	if (inPiece.length === 0) return undefined;
	const sampleCount = Math.min(3, inPiece.length);
	const votes = new Map<string, number>();
	for (let i = 0; i < sampleCount; i++) {
		const f = inPiece[Math.floor((i * (inPiece.length - 1)) / Math.max(1, sampleCount - 1))];
		const ways = await waysLookup(f.lat, f.lon);
		const named = ways
			.filter((w) => w.type === "highway" && w.name)
			.sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0))[0];
		if (named?.name) votes.set(named.name, (votes.get(named.name) ?? 0) + 1);
	}
	if (votes.size === 0) return undefined;
	return [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

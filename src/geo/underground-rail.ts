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
 * a single rail line that (a) passes both the boarding and alighting
 * ends, (b) is hugged by the coarse fixes in between, and (c) actually
 * STOPS at the two stations those ends resolve to? The coarse fixes are
 * what disambiguate parallel lines — two lines may both connect the
 * endpoints, but only the one actually travelled is the one the
 * mid-journey coarse fixes sit on. (c) is what disambiguates a line
 * that merely runs past one of them (see `line-membership.ts`).
 *
 * This is deliberately a *discrete* inference (which line?), kept
 * separate from smoothing and from quality control. It needs no
 * ordered line topology — only the existing "which line names are
 * near this point" lookup.
 */

import type { EnrichedSegment } from "./enriched-segment.js";
import type { FilteredPoint } from "./kalman.js";
import { lineCannotServe, type ServedStationsLookup } from "./line-membership.js";
import type { NearbyStation, NearbyWay } from "./osm.js";
import { pickBestStation, refineMode } from "./osm.js";
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

/** How many points along a side piece to sample for its way label. Matches
 *  `N_SAMPLES` in the OSM enrichment pass, because it is answering that
 *  pass's question. */
const SIDE_WAY_SAMPLES = 5;

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
	servedLookup: ServedStationsLookup,
	expandSharedTrack = false,
): Promise<UndergroundRun | null> {
	const coarse = fixes.filter(isCoarse).sort((a, b) => a.ts - b.ts);
	if (coarse.length < MIN_COARSE_FIXES) return null;

	// Lines that pass the boarding and alighting ends.
	//
	// `expandSharedTrack` reconciles OSM's two tagging conventions for the same
	// physical line — the combined relation ("Circle, Hammersmith & City and
	// Metropolitan Lines" at King's Cross) against the plain name ("Metropolitan
	// Line" at Finchley Road) — so an intersection can see through the naming.
	// It is OFF for the FIRST through-line attempt and ON for the halves of an
	// interchange split, and that asymmetry is deliberate: expanding only ever
	// ADDS a through-line reading the raw names denied, and a change of line is
	// exactly what such a reading would paper over. `reconstructUndergroundJourney`
	// owns the ordering — raw through-line, then the split, then this as a last
	// resort — so the naming is only reconciled once no change of line fits.
	const readLines = (lines: Iterable<string>): Set<string> =>
		expandSharedTrack ? new Set([...lines].flatMap(expandTubeLineNames)) : new Set(lines);
	const boardLines = readLines(await linesLookup(boardingFix.lat, boardingFix.lon));
	const alightLines = readLines(await linesLookup(alightingFix.lat, alightingFix.lon));
	if (boardLines.size === 0 || alightLines.size === 0) return null;

	// Lines under each coarse fix — the path the train actually hugged.
	const coarseLineSets = (await Promise.all(coarse.map((f) => linesLookup(f.lat, f.lon)))).map(readLines);

	// A candidate line passes both ends AND is hugged by at least one
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

	// This run is underground by construction, so its endpoints are underground
	// stations: at a multi-operator interchange prefer the `station=subway`
	// node over the mainline terminus sharing the site (see `pickBestStation`).
	const board = pickBestStation(await stationsLookup(boardingFix.lat, boardingFix.lon), "subway");
	const alight = pickBestStation(await stationsLookup(alightingFix.lat, alightingFix.lon), "subway");
	if (!board || !alight) return null;

	// A run must go *between two distinct stations over a real
	// distance*. Coarse fixes clustered at one station (a platform wait,
	// a same-station interchange) resolve both ends to the same place —
	// that is not a journey.
	if (board.name === alight.name) return null;
	if (equirectMeters(boardingFix.lat, boardingFix.lon, alightingFix.lat, alightingFix.lon) < MIN_JOURNEY_M) {
		return null;
	}

	// Everything above is proximity: a line qualifies by running NEAR both
	// ends. That is how the 2026-06-28 return became one "North London line"
	// leg — the Overground passes Finchley Road on its way to Finchley Road &
	// Frognal, and parallels the Metropolitan for miles, so it satisfied both
	// the endpoint and the coarse-fix tests. Membership is the corrective, and
	// it belongs HERE, before the label is written, not only in the gate that
	// rejects the finished leg (#377). Losing every candidate is a real answer:
	// no honest single-line reading exists, which is the signal
	// `reconstructUndergroundJourney` needs to go looking for the interchange.
	let line: string | null = null;
	for (const [candidate] of [...candidates.entries()].sort((a, b) => b[1] - a[1])) {
		if (await lineCannotServe(candidate, board.name, servedLookup)) continue;
		if (await lineCannotServe(candidate, alight.name, servedLookup)) continue;
		line = candidate;
		break;
	}
	if (line === null) return null;

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
	servedLookup: ServedStationsLookup,
): Promise<UndergroundRun[]> {
	const single = await reconstructUndergroundRun(
		fixes,
		boardingFix,
		alightingFix,
		stationsLookup,
		linesLookup,
		servedLookup,
	);
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

	// Candidate interchanges: clusters of good fixes that surfaced mid-run, each
	// one PLACE the ride was observed at. Time alone does not separate them —
	// when GPS is up its fixes are seconds apart, so a purely temporal rule
	// merges every surfacing along the ride into one blob whose centroid is a
	// point mid-track, at no station at all (2026-06-28: King's Cross, Great
	// Portland Street and Baker Street collapsed into one "interchange" out in
	// Regent's Park). A cluster therefore also ends when the ride has MOVED —
	// beyond the radius within which fixes still belong to the same station.
	const mid = interchangeFixes
		.filter((f) => f.ts > coarse[0].ts && f.ts < coarse[coarse.length - 1].ts)
		.sort((a, b) => a.ts - b.ts);
	const clusters: CoarseFix[][] = [];
	let sumLat = 0;
	let sumLon = 0;
	for (const f of mid) {
		const cur = clusters.at(-1);
		const nearCentroid =
			cur !== undefined &&
			equirectMeters(f.lat, f.lon, sumLat / cur.length, sumLon / cur.length) <= UNDERGROUND_STATION_RADIUS_M;
		if (cur && f.ts - cur[cur.length - 1].ts <= MAX_COARSE_GAP_S && nearCentroid) {
			cur.push(f);
			sumLat += f.lat;
			sumLon += f.lon;
		} else {
			clusters.push([f]);
			sumLat = f.lat;
			sumLon = f.lon;
		}
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
		const leg1 = await reconstructUndergroundRun(
			before,
			boardingFix,
			ixPt,
			stationsLookup,
			linesLookup,
			servedLookup,
			true,
		);
		const leg2 = await reconstructUndergroundRun(
			after,
			ixPt,
			alightingFix,
			stationsLookup,
			linesLookup,
			servedLookup,
			true,
		);
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

	// Last resort: no line reaches both ends under OSM's own names, and no
	// change of line fits the evidence either. Now — and only now — reconcile
	// the two tagging conventions and ask the through-line question again. OSM
	// tags one physical line two ways, so "no line reaches both ends" can be a
	// fact about a combined relation name rather than about the journey: the
	// 2026-05-22 King's Cross St Pancras → Finchley Road ride is Metropolitan
	// end to end and was lost to that (#185).
	//
	// It has to come AFTER the split, because reading through the naming is
	// exactly what would paper over a real change of line: on 2026-07-07 the
	// same expansion turns a King's Cross → Euston Square [Northern] → Wembley
	// Park [Metropolitan] return into one bogus Metropolitan through-ride.
	return (
		(await reconstructUndergroundRun(
			fixes,
			boardingFix,
			alightingFix,
			stationsLookup,
			linesLookup,
			servedLookup,
			true,
		).then((r) => (r ? [r] : null))) ?? []
	);
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

/** Span (s) of uninterrupted good GPS that ends a blackout rather than
 *  merely interrupting it. A train passing a vent shaft or a shallow station
 *  box gives the phone one glimpse of sky and takes it away again — that is
 *  the same tunnel, not two. Sustained good GPS is a real recovery: whatever
 *  goes dark afterwards is a different blackout (walking indoors at the
 *  destination), and annexing it runs the ride past its own alight.
 *
 *  Measured over the corpus, the two cases do not overlap: the mid-tunnel
 *  reacquires a run must grow through are lone fixes spanning 0 s (2026-05-22
 *  at 19:05:53 and 19:14:07), while every post-arrival gap that must NOT be
 *  crossed holds 6–22 good fixes spanning 66–257 s (2026-05-20, 06-16, 05-12). */
const RECOVERY_SPAN_S = 30;

/**
 * Extend a run of GPS-dark fixes outwards through `all` — the day's dark
 * fixes — for as long as it is still the same blackout.
 *
 * The run was found inside one host segment, so its ends are wherever that
 * segment happened to be cut. The tunnel's ends are a property of the fix
 * stream instead: dark fixes past the host boundary can be the same blackout
 * and belong to the same ride.
 *
 * Two things stop the growth — the {@link MAX_COARSE_GAP_S} contiguity rule,
 * and a sustained good-GPS recovery inside the gap ({@link RECOVERY_SPAN_S}).
 * The recovery test is asked ONLY here, not of the run's own interior: inside
 * the host the classifier has already judged this one continuous moving leg,
 * so a surfacing there is a surfacing. Growth annexes fixes the classifier
 * gave to a different segment, and that claim has to clear a higher bar.
 */
function growThroughDarkness(
	run: readonly CoarseFix[],
	all: readonly CoarseFix[],
	good: readonly CoarseFix[],
): CoarseFix[] {
	/** Did GPS genuinely come back between these two dark fixes? */
	const recovered = (fromTs: number, toTs: number): boolean => {
		const between = good.filter((f) => f.ts > fromTs && f.ts < toTs);
		return between.length > 0 && between[between.length - 1].ts - between[0].ts >= RECOVERY_SPAN_S;
	};
	let lo = all.findIndex((f) => f.ts >= run[0].ts);
	if (lo < 0) return [...run]; // the run's fixes are not in `all` — nothing to grow into
	let hi = all.length - 1;
	while (hi > lo && all[hi].ts > run[run.length - 1].ts) hi--;
	while (lo > 0 && all[lo].ts - all[lo - 1].ts <= MAX_COARSE_GAP_S && !recovered(all[lo - 1].ts, all[lo].ts)) lo--;
	while (
		hi < all.length - 1 &&
		all[hi + 1].ts - all[hi].ts <= MAX_COARSE_GAP_S &&
		!recovered(all[hi].ts, all[hi + 1].ts)
	) {
		hi++;
	}
	return all.slice(lo, hi + 1);
}

/** How close in time and space a well-located fix has to be, on BOTH sides of
 *  a GPS-dark one, to prove the phone was never actually out of contact with
 *  the sky. Deliberately tight on distance: on 2026-07-16 the blip sat 24 m
 *  and 50 m from its neighbours, while every genuine tunnel fix that day sat
 *  570–3242 m from the nearest good fix. The two populations do not overlap,
 *  and it is POSITION continuity that separates them — accuracy cannot, since
 *  the blip's own accuracy is what raised the question. */
const BLIP_NEIGHBOUR_S = 120;
const BLIP_NEIGHBOUR_M = 250;

/**
 * Is this dark fix a lone accuracy wobble inside continuous good coverage,
 * rather than a tunnel?
 *
 * Underground, the phone loses the sky: the fixes around a real blackout are
 * either dark themselves or hundreds of metres away, because the train covered
 * that ground while nobody was looking. A fix that reports 134 m of uncertainty
 * while sitting 30 m from well-located fixes seconds either side reports on the
 * receiver, not on the journey.
 */
function isAccuracyBlip(f: CoarseFix, good: readonly CoarseFix[]): boolean {
	const near = (g: CoarseFix | undefined): boolean =>
		g !== undefined &&
		Math.abs(g.ts - f.ts) <= BLIP_NEIGHBOUR_S &&
		equirectMeters(f.lat, f.lon, g.lat, g.lon) <= BLIP_NEIGHBOUR_M;
	return near([...good].reverse().find((g) => g.ts < f.ts)) && near(good.find((g) => g.ts > f.ts));
}

/**
 * Drop accuracy blips from the END of a run — the fixes that let it outlive
 * the ride.
 *
 * The run's tail is what sets the alight: the window closes at the first good
 * fix after the last dark one, so a blip four minutes into the walk away from
 * the station moves the alight four minutes late and swallows the walk. On
 * 2026-07-16 that ran the Euston Square ride over a confirmed 07:47–07:54 walk
 * to UCLH.
 *
 * The tail ONLY. Measured over the corpus, blips are not uniformly noise:
 * filtering them everywhere also drops poor-GPS indoor stays and mid-ride
 * surfacings, fragmenting runs that are right today (06-16, 06-22, 07-07 each
 * lost a confirmed row). Trimming both ends is still wrong at the head, where
 * the boarding anchor already owns the question and a blip trim moved 07-07's
 * evening boarding six minutes late. What is asymmetric is the consequence: an
 * over-long tail overwrites a confirmed walk, an over-long head does not.
 *
 * Being a blip is necessary but not sufficient: the rider must also have moved
 * CLEAR of the blackout, by more than a station's own footprint
 * ({@link UNDERGROUND_STATION_RADIUS_M}). Arriving somewhere is not a tidy
 * event — the phone reacquires on the platform, loses it again under the
 * concourse roof, and settles outside, so the fixes just after a ride are a
 * mixture that looks blip-shaped while still being the arrival. Distance is
 * what tells the two apart, and the corpus separates cleanly on it: 2026-07-16's
 * blip is 517 m from the last tunnel fix, four minutes into a walk that had
 * already left Euston Square, while 2026-07-07's is 119 m — still inside King's
 * Cross, where the user's own account has him until 17:45. Trimming that one
 * cut six minutes off a confirmed ride and left a phantom stay in the gap.
 */
function trimBlipTail(run: readonly CoarseFix[], good: readonly CoarseFix[]): CoarseFix[] {
	const movedClear = (f: CoarseFix, prev: CoarseFix): boolean =>
		equirectMeters(f.lat, f.lon, prev.lat, prev.lon) > UNDERGROUND_STATION_RADIUS_M;
	let end = run.length;
	while (end > 1 && isAccuracyBlip(run[end - 1], good) && movedClear(run[end - 1], run[end - 2])) end--;
	return run.slice(0, end);
}

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
	points: readonly FilteredPoint[],
	stationsLookup: StationsLookup = (lat, lon) => dbOsmAdapter.nearbyStations(lat, lon, UNDERGROUND_STATION_RADIUS_M),
	linesLookup: LinesLookup = (lat, lon) => dbOsmAdapter.linesAtPoint(lat, lon, UNDERGROUND_LINES_RADIUS_M),
	waysLookup: WaysLookup = (lat, lon) => dbOsmAdapter.nearbyWays(lat, lon),
	servedLookup: ServedStationsLookup = (line) => dbOsmAdapter.stationsOnLine(line),
): Promise<EnrichedSegment[]> {
	const good = rawFixes.filter((f) => f.accuracy == null || f.accuracy < COARSE_ACCURACY_M);
	/** Every GPS-dark fix of the day, in order — the stream a host's run is
	 *  grown back out into once the host has established there IS a ride. */
	const darkFixes = rawFixes.filter(isUndergroundSignal).sort((a, b) => a.ts - b.ts);
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
		const hostRun = runs
			.filter((r) => r.length >= MIN_COARSE_FIXES && span(r) >= MIN_RUN_DURATION_S)
			.sort((a, b) => span(b) - span(a))[0];
		if (!hostRun) {
			result.push(host);
			continue;
		}
		// The host said WHETHER there is a ride in here; it does not get to say
		// how long the tunnel is. GPS goes dark when the train enters and
		// returns when it surfaces, and where the classifier cut a segment
		// boundary has nothing to do with either — on 2026-05-22 it cut at two
		// mid-tunnel reacquires, so the clipped window resolved a King's Cross
		// St Pancras → Finchley Road ride as "Euston Square → St John's Wood",
		// a station in at BOTH ends. Grow the run through the day's contiguous
		// dark fixes under the same gap rule, so its ends are the tunnel's ends.
		// The train segment written below stays clamped to the host either way.
		// Trimmed AFTER growing, so it catches a blip whichever side annexed it —
		// the host's own clustering or the growth past the host boundary. What
		// survives still has to clear the same bar the host run cleared, or the
		// ride would be reconstructed out of evidence just disowned.
		const runFixes = trimBlipTail(growThroughDarkness(hostRun, darkFixes, good), good);
		if (runFixes.length < MIN_COARSE_FIXES || span(runFixes) < MIN_RUN_DURATION_S) {
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
			servedLookup,
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
				wayName: await sideWayName(points, host.startTs, trainStart, host.mode, waysLookup),
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
				wayName: await sideWayName(points, trainEnd, host.endTs, host.mode, waysLookup),
			});
		}
	}

	return result;
}

/** Way label for a side piece of a split host.
 *
 *  The host's own wayName was composed across ALL its fixes — both walks plus
 *  the tunnel — so inheriting it stamps the pre-tube walk's street onto the
 *  post-tube walk at the other end of town (measured: a King's Cross walk
 *  labelled with a Belgravia street, task #248).
 *
 *  So the piece is named from the piece's own fixes — but by the SAME rule the
 *  OSM enricher uses for any other moving segment, not a local one. Sampling
 *  evenly, deduping ways by MINIMUM distance across samples, and handing the
 *  result to `refineMode` is exactly what `enrichMovingSegment` does; the only
 *  parts left out are the city lookup and the mode decision, neither of which a
 *  carve remainder needs (the carve already settled the mode, and re-deciding
 *  it here reads a station forecourt as rail).
 *
 *  Asking a different question was a real defect, not a stylistic one. The old
 *  rule — three samples, nearest named highway of any type, ties broken by
 *  insertion order so the FIRST fix won — named the 2026-07-15 walk from Work
 *  to King's Cross "Clarence Passage", 14 m from its opening fix, where the
 *  enricher given the same window says "Argyle Street".
 *
 *  Undefined when the piece has no fixes or no named way nearby — an honest
 *  blank beats a leaked label. */
async function sideWayName(
	points: readonly FilteredPoint[],
	startTs: number,
	endTs: number,
	mode: EnrichedSegment["mode"],
	waysLookup: WaysLookup,
): Promise<string | undefined> {
	const inPiece = points.filter((p) => p.ts >= startTs && p.ts <= endTs).sort((a, b) => a.ts - b.ts);
	if (inPiece.length === 0) return undefined;
	const sampleCount = Math.min(SIDE_WAY_SAMPLES, inPiece.length);
	const sampled = Array.from(
		{ length: sampleCount },
		(_, i) => inPiece[Math.floor((i * (inPiece.length - 1)) / Math.max(1, sampleCount - 1))],
	);
	// Dedup by (type, subtype, name) keeping the minimum distance, so a way
	// brushed past at one sample cannot outweigh one hugged at four others.
	const byKey = new Map<string, NearbyWay>();
	for (const ways of await Promise.all(sampled.map((p) => waysLookup(p.lat, p.lon)))) {
		for (const w of ways) {
			const key = `${w.type}/${w.subtype}/${w.name ?? ""}`;
			const existing = byKey.get(key);
			if (!existing || (w.distanceM ?? Number.POSITIVE_INFINITY) < (existing.distanceM ?? Number.POSITIVE_INFINITY))
				byKey.set(key, w);
		}
	}
	if (byKey.size === 0) return undefined;
	// The piece's OWN pace — the host's average is the tunnel's, and a walk
	// handed a train's speed gets refined as one.
	const speeds = inPiece.map((p) => p.speed_kmh ?? 0).sort((a, b) => a - b);
	const medianKmh = speeds[Math.floor(speeds.length / 2)] ?? 0;
	return refineMode(mode, medianKmh, [...byKey.values()]).wayName;
}

/**
 * Re-evaluate emitted stationary stays for hidden mid-stay departures,
 * using multi-signal weighted evidence. Companion to the segment-level
 * `unknown` mode emission (honest-gaps Phase 1) — together they pull
 * fabricated motion / over-merged stays back to what the data supports.
 *
 * `findStays` in `segments.ts` emits one stationary segment per spatial
 * cluster, but cannot tell from GPS alone whether a long gap between
 * two in-cluster fixes is "user stayed silently, phone went idle" or
 * "user briefly left and came back". Both patterns leave the same
 * trace: two clusters of in-place fixes bracketing a no-fix window.
 *
 * This pass combines four signals to estimate the likelihood of
 * mid-stay departure, then splits only when the evidence is strong
 * enough to warrant breaking the stay (and emits an `unknown` segment
 * in the gap so downstream rendering shows the departure honestly):
 *
 *   - **Biometric step count during the gap.** This is the *only*
 *     direct evidence of movement we have. Steps mid-gap = the user
 *     moved. Zero steps = the user sat. Drives the score on its own.
 *   - **Gap-anomaly ratio.** When the cluster has a dense pre-gap
 *     fix history, an anomalously long gap *amplifies* the step
 *     signal — but contributes nothing on its own. A long gap with
 *     no steps is the "phone died" pattern, not the "user left"
 *     pattern.
 *   - **HR during the gap.** Sustained elevation above resting
 *     baseline is supporting evidence of activity; restful HR is
 *     mild counter-evidence.
 *   - **Post-gap fix proximity.** A fix that lands back inside ~20 m
 *     of the cluster centroid is mild counter-evidence (the user
 *     returned to the exact same spot, more consistent with
 *     "didn't really leave").
 *
 * Calibration is deliberately conservative — the bias is toward NOT
 * splitting. A slight over-merge ("user was at hotel for 1h25m" when
 * they actually went out briefly) is far less misleading than a
 * fabricated split that breaks a quiet at-home evening into multiple
 * sub-stays. Cases where step data is too ambiguous to distinguish
 * "brief errand" from "sat silently" stay merged — the honest
 * "don't know" answer is to leave the data's ambiguity intact.
 */

import type { HrPoint, StepPoint } from "./biometrics.js";
import type { FilteredPoint } from "./kalman.js";
import { samplesInWindow } from "./segment-util.js";
import type { TrackSegment, TransportMode } from "./segments.js";

export interface SplitContext {
	hr: HrPoint[];
	steps: StepPoint[];
}

/** Minimum in-stay gap (seconds) to even consider as a potential
 *  departure point. Shorter gaps are normal GPS jitter and not worth
 *  evaluating. */
const MIN_GAP_TO_EVALUATE_S = 15 * 60;

/** Log-evidence threshold for splitting. Conservative — splits only on
 *  overwhelming evidence (clear in-gap step activity, or many steps
 *  combined with a very anomalous gap). The bias is toward NOT
 *  splitting: a slight over-merge of a stay is far less misleading
 *  than a fabricated split that breaks a quiet at-home evening into
 *  multiple sub-stays. */
const SPLIT_THRESHOLD_NATS = 2.5;

/** Minimum number of pre-gap in-cluster fixes before the
 *  gap-anomaly signal is meaningful. Below this the cluster has no
 *  established fix density and the ratio can't distinguish "user
 *  left" from "GPS finally fired again". */
const GAP_ANOMALY_MIN_PRE_FIXES = 5;

/** Compute haversine distance in metres. Shared with segments.ts but
 *  duplicated here to keep this module standalone. */
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface GapEvidence {
	gapDurationS: number;
	medianPriorGapS: number;
	preGapFixCount: number;
	stepsInGap: number;
	hrMeanInGap: number | null;
	hrSamplesInGap: number;
	postGapDistFromCentroidM: number;
}

/** Compute weighted log-evidence that the user *left* during this gap.
 *  Positive → evidence of departure. Negative → evidence of continued
 *  stay. Sum across signals; > SPLIT_THRESHOLD_NATS triggers a split.
 *
 *  Calibration philosophy: step density is the only DIRECT evidence
 *  of movement we have. HR, gap-anomaly, and proximity are supporting
 *  signals — they can amplify or counter the step signal but cannot
 *  drive a split on their own. A long gap with zero steps and resting
 *  HR is strong evidence of sitting silently, not leaving. The bias
 *  is toward NOT splitting: a slight over-merge is less misleading
 *  than a fabricated split. */
export function scoreSplitEvidence(ev: GapEvidence): number {
	const gapMin = ev.gapDurationS / 60;
	if (gapMin <= 0) return 0;
	const stepsPerMin = ev.stepsInGap / gapMin;

	// Primary signal — biometric step density. This is the only direct
	// evidence of movement. Resting human (sitting, sleeping, watching
	// TV): 0-1 steps/min from incidental wrist motion. At-place
	// fidgeting / brief moves to fridge/bathroom: 1-3 steps/min.
	// Light walking: 5-15 steps/min. Brisk walking: 30+ steps/min.
	let score: number;
	if (stepsPerMin > 20)
		score = 3.5; // unambiguous sustained walking
	else if (stepsPerMin > 8)
		score = 2.0; // clear movement
	else if (stepsPerMin > 3)
		score = 0.5; // some movement but ambiguous
	else if (stepsPerMin > 1)
		score = -0.5; // at-place fidgeting
	else score = -2.0; // strong evidence of sitting

	// Supporting signal — gap-anomaly ratio. Amplifies the step signal
	// when both are positive, otherwise neutral. A very anomalous gap
	// (ratio > 50) with no steps is the "phone died" pattern, not the
	// "user left" pattern — we don't add positive evidence on the
	// gap-anomaly alone.
	if (ev.preGapFixCount >= GAP_ANOMALY_MIN_PRE_FIXES && ev.medianPriorGapS > 0 && score > 0) {
		const ratio = ev.gapDurationS / ev.medianPriorGapS;
		if (ratio > 50)
			score += 1.0; // very anomalous + movement → confident
		else if (ratio > 10) score += 0.5; // mildly anomalous + movement → mild boost
	}

	// Supporting signal — HR during the gap. Sustained elevation above
	// resting baseline is supporting evidence of activity; restful HR
	// is mild counter-evidence. We don't have per-user baseline here;
	// thresholds reflect typical population baselines (60-80 resting,
	// 95+ light activity, 110+ brisk).
	if (ev.hrSamplesInGap >= 3 && ev.hrMeanInGap !== null) {
		if (ev.hrMeanInGap > 110) score += 0.8;
		else if (ev.hrMeanInGap > 95) score += 0.3;
		else if (ev.hrMeanInGap < 75) score -= 0.5;
	}

	// Counter-evidence — post-gap fix landed back inside ~20 m of
	// cluster centroid. Mild signal that the user didn't really leave
	// (or left and returned to the exact same spot). Doesn't outweigh
	// strong step-density signals.
	if (ev.postGapDistFromCentroidM < 20) score -= 0.5;

	return score;
}

/**
 * Re-evaluate findStays output. For each stationary segment, walk its
 * in-segment fix sequence; at each gap ≥ MIN_GAP_TO_EVALUATE_S compute
 * weighted split evidence and split where joint evidence exceeds
 * SPLIT_THRESHOLD_NATS.
 *
 * When a stay is split, an `unknown` segment is emitted between the
 * resulting sub-stays — so downstream rendering shows the honest "we
 * don't know what the user was doing" gap rather than implicitly
 * stitching sub-stays back together via `mergeAdjacent`. The sub-stays
 * inherit the parent's metadata (place, city, displayTz) so the place
 * label is preserved across the split.
 *
 * Non-stationary segments and pointCount=0 synthetic segments are
 * passed through untouched. The output preserves segment order.
 */
export function splitStaysOnEvidence(
	segments: readonly TrackSegment[],
	points: readonly FilteredPoint[],
	ctx: SplitContext,
): TrackSegment[] {
	const out: TrackSegment[] = [];
	for (const seg of segments) {
		if (seg.mode !== "stationary" || seg.pointCount < 2) {
			out.push(seg);
			continue;
		}
		const segFixes = samplesInWindow(points, seg).sort((a, b) => a.ts - b.ts);
		if (segFixes.length < 2) {
			out.push(seg);
			continue;
		}
		const subRuns = splitByEvidence(segFixes, ctx);
		if (subRuns.length <= 1) {
			out.push(seg);
			continue;
		}
		for (let i = 0; i < subRuns.length; i++) {
			const run = subRuns[i];
			out.push({
				...seg,
				startTs: run[0].ts,
				endTs: run[run.length - 1].ts,
				pointCount: run.length,
			});
			if (i < subRuns.length - 1) {
				const gapStart = run[run.length - 1].ts;
				const gapEnd = subRuns[i + 1][0].ts;
				const min = Math.round((gapEnd - gapStart) / 60);
				out.push({
					startTs: gapStart,
					endTs: gapEnd,
					mode: "unknown",
					confidence: 0.1,
					confidenceMargin: 1,
					avgSpeed: 0,
					maxSpeed: 0,
					linearity: 0,
					pointCount: 0,
					refinedReason: `no GPS coverage for ${min} min (mid-stay departure inferred from biometric / fix-density evidence)`,
				});
			}
		}
	}
	return out;
}

// --- walk-split: carve hidden sits out of phantom walks (task #245) -------

/** Only walks at least this long are evaluated. Short walks can't contain
 *  a sit run long enough to carve (see WALK_SPLIT_MIN_SIT_S). */
const WALK_SPLIT_MIN_SEGMENT_S = 20 * 60;

/** Mean cadence at or below which an edge run is a sit. Real indoor sits
 *  are NOT contiguous zeros — the 2026-06-09 clinic hour has isolated
 *  fidget spikes (25–49 steps: a consult-room walk, reception) yet
 *  averages ~4 steps/min. 5/min sits between stay-split's "at-place
 *  fidgeting" band (1–3) and its "ambiguous" band (3–8); sustained
 *  walking is an order of magnitude above. */
const WALK_SPLIT_SIT_MEAN_MAX = 5;

/** Forward-looking window (minutes) whose mean must reach
 *  WALK_SPLIT_CORE_MIN_CADENCE for a minute to count as the start of
 *  sustained walking. A lone fidget spike fails the window; a real walk
 *  start passes immediately. */
const WALK_SPLIT_ONSET_WINDOW_MIN = 6;

/** The boundary minute itself must carry at least this many steps — the
 *  forward/backward window alone would otherwise anchor the boundary a
 *  few zero-step minutes early (the window "sees" the walk before it
 *  starts). A walking minute under 10 steps does not exist. */
const WALK_SPLIT_ONSET_MIN_CADENCE = 10;

/** An edge sit must be at least this long to be carved out. A human can
 *  pause 10 minutes mid-walk (coffee queue, platform wait); 15+ minutes
 *  at sitting-level cadence inside a "walk" is a sit. Mirrors
 *  MIN_GAP_TO_EVALUATE_S in spirit: conservative, edge-only. */
const WALK_SPLIT_MIN_SIT_S = 15 * 60;

/** After carving, the remaining walking core must actually look like a
 *  walk — sustained cadence and non-trivial duration. Otherwise the
 *  segment is left intact for the whole-segment demotion pass
 *  (`demoteJitterWalkToStationary`) to judge; this pass only handles the
 *  MIXED case where a real walk hides inside the same segment. */
const WALK_SPLIT_CORE_MIN_CADENCE = 40;
const WALK_SPLIT_CORE_MIN_S = 3 * 60;

/** A step row must exist in/after the segment within this window to
 *  prove the step stream was alive. Without it, zero steps is absence
 *  of data, not evidence of sitting — a dead Fitbit must never convert
 *  real walks into sits. Mirrors the cadence-correction freshness gate. */
const WALK_SPLIT_FRESHNESS_S = 30 * 60;

/**
 * Carve long low-cadence edge runs out of "walking" segments as
 * stationary sits (task #245 — the Cleveland Clinic shape: a ~60-min
 * indoor sit whose jittery indoor GPS classified as one walk together
 * with the real ~10-min walk that followed).
 *
 * Mechanism: bucket the user's per-minute step counts across the
 * segment; find the maximal prefix and suffix runs of minutes below
 * WALK_SPLIT_LOW_CADENCE_PER_MIN. An edge run ≥ WALK_SPLIT_MIN_SIT_S is
 * a sit — emitted as a stationary segment with the GPS motion stats
 * zeroed (they are jitter artifacts; the zero IS the claim) — and the
 * remaining core keeps walking. The split fires only when the core
 * passes the real-walk checks, so an all-jitter segment falls through
 * untouched to the whole-segment demotion pass.
 *
 * Runs at the staySplit stage (before OSM enrichment) so the carved-out
 * sit gets a normal place resolution — at the clinic this is what lets
 * the sit re-attach to the hospital instead of rendering as movement.
 */
export function splitWalksOnEvidence(
	segments: readonly TrackSegment[],
	points: readonly FilteredPoint[],
	ctx: SplitContext,
): TrackSegment[] {
	const debug = process.env.WALK_SPLIT_DEBUG === "1";
	const out: TrackSegment[] = [];
	for (const seg of segments) {
		if (debug) {
			const t = (ts: number): string => new Date(ts * 1000).toISOString().slice(11, 16);
			console.error(`[walk-split] seg ${t(seg.startTs)}-${t(seg.endTs)} mode=${seg.mode} pts=${seg.pointCount}`);
		}
		if (seg.mode !== "walking" || seg.endTs - seg.startTs < WALK_SPLIT_MIN_SEGMENT_S) {
			out.push(seg);
			continue;
		}
		// Freshness: the step stream must be demonstrably alive around the
		// segment, else zero steps means "no data".
		const fresh = ctx.steps.some((s) => s.ts >= seg.startTs && s.ts <= seg.endTs + WALK_SPLIT_FRESHNESS_S);
		if (!fresh) {
			out.push(seg);
			continue;
		}

		// Per-minute cadence, bucketed from the segment start.
		const totalMin = Math.ceil((seg.endTs - seg.startTs) / 60);
		const cadence = new Array<number>(totalMin).fill(0);
		for (const s of ctx.steps) {
			const k = Math.floor((s.ts - seg.startTs) / 60);
			if (k >= 0 && k < totalMin) cadence[k] += s.steps;
		}

		// Boundary search, robust to fidget spikes inside the sit: the sit
		// → walk boundary is the FIRST minute b where (a) the forward
		// window mean reaches sustained-walking cadence and (b) everything
		// before b averages at sitting level. A lone spike fails (a); a
		// diluted mean from a long zero-run cannot eat into the walk
		// because (a) anchors the boundary at the walk onset.
		const meanOf = (from: number, to: number): number => {
			if (to <= from) return 0;
			let sum = 0;
			for (let k = from; k < to; k++) sum += cadence[k];
			return sum / (to - from);
		};
		const minSitMin = Math.ceil(WALK_SPLIT_MIN_SIT_S / 60);
		let prefixMin = 0;
		for (let b = minSitMin; b <= totalMin - 1; b++) {
			if (
				cadence[b] >= WALK_SPLIT_ONSET_MIN_CADENCE &&
				meanOf(b, Math.min(totalMin, b + WALK_SPLIT_ONSET_WINDOW_MIN)) >= WALK_SPLIT_CORE_MIN_CADENCE &&
				meanOf(0, b) <= WALK_SPLIT_SIT_MEAN_MAX
			) {
				prefixMin = b;
				break;
			}
		}
		// Suffix: mirrored — the walk → sit boundary is the LAST minute e
		// where the backward window still walks and everything after sits.
		let suffixMin = 0;
		for (let e = totalMin - minSitMin; e >= 1; e--) {
			if (e <= prefixMin) break;
			if (
				cadence[e - 1] >= WALK_SPLIT_ONSET_MIN_CADENCE &&
				meanOf(Math.max(0, e - WALK_SPLIT_ONSET_WINDOW_MIN), e) >= WALK_SPLIT_CORE_MIN_CADENCE &&
				meanOf(e, totalMin) <= WALK_SPLIT_SIT_MEAN_MAX
			) {
				suffixMin = totalMin - e;
				break;
			}
		}
		if (debug)
			console.error(
				`[walk-split]   eval: totalMin=${totalMin} prefixMin=${prefixMin} suffixMin=${suffixMin} cadence=${cadence.join(",")}`,
			);
		if (prefixMin === 0 && suffixMin === 0) {
			out.push(seg);
			continue;
		}

		// The carved core must be a real walk.
		const coreFromMin = prefixMin;
		const coreToMin = totalMin - suffixMin;
		const coreS = Math.min(seg.endTs, seg.startTs + coreToMin * 60) - (seg.startTs + coreFromMin * 60);
		if (coreS < WALK_SPLIT_CORE_MIN_S) {
			out.push(seg);
			continue;
		}
		const coreCad = cadence.slice(coreFromMin, coreToMin);
		const coreMean = coreCad.reduce((a, b) => a + b, 0) / coreCad.length;
		if (coreMean < WALK_SPLIT_CORE_MIN_CADENCE) {
			out.push(seg);
			continue;
		}

		const b1 = seg.startTs + prefixMin * 60;
		const b2 = Math.min(seg.endTs, seg.startTs + coreToMin * 60);
		const countIn = (from: number, to: number): number => points.filter((p) => p.ts >= from && p.ts < to).length;
		const sitPart = (from: number, to: number, minutes: number): TrackSegment => ({
			...seg,
			mode: "stationary",
			startTs: from,
			endTs: to,
			avgSpeed: 0,
			maxSpeed: 0,
			linearity: 0,
			pointCount: countIn(from, to),
			refinedReason: `steps-aware walk split: ≤ ${WALK_SPLIT_SIT_MEAN_MAX} steps/min mean for ${minutes} min inside a walking segment — a sit, not a walk`,
		});
		if (prefixMin > 0) out.push(sitPart(seg.startTs, b1, prefixMin));
		out.push({ ...seg, startTs: b1, endTs: b2, pointCount: countIn(b1, b2) });
		if (suffixMin > 0) out.push(sitPart(b2, seg.endTs, suffixMin));
	}
	return out;
}

/** Walk fixes in time order, accumulating into sub-runs; close a run
 *  when the gap to the next fix scores above SPLIT_THRESHOLD_NATS. */
function splitByEvidence(fixes: FilteredPoint[], ctx: SplitContext): FilteredPoint[][] {
	const runs: FilteredPoint[][] = [[fixes[0]]];
	const priorGapsInRun: number[] = [];
	let runCentroidLat = fixes[0].lat;
	let runCentroidLon = fixes[0].lon;

	for (let i = 1; i < fixes.length; i++) {
		const prev = fixes[i - 1];
		const cur = fixes[i];
		const gapS = cur.ts - prev.ts;

		// Short gaps: just join the current run, update centroid + gap stats.
		if (gapS < MIN_GAP_TO_EVALUATE_S) {
			const run = runs[runs.length - 1];
			run.push(cur);
			priorGapsInRun.push(gapS);
			runCentroidLat += (cur.lat - runCentroidLat) / run.length;
			runCentroidLon += (cur.lon - runCentroidLon) / run.length;
			continue;
		}

		// Long gap: evaluate split evidence.
		const stepsInGap = ctx.steps.filter((s) => s.ts > prev.ts && s.ts < cur.ts).reduce((sum, s) => sum + s.steps, 0);
		const hrInGap = ctx.hr.filter((h) => h.ts > prev.ts && h.ts < cur.ts);
		const hrMean = hrInGap.length > 0 ? hrInGap.reduce((s, h) => s + h.bpm, 0) / hrInGap.length : null;
		const postGapDist = haversineMeters(runCentroidLat, runCentroidLon, cur.lat, cur.lon);
		const score = scoreSplitEvidence({
			gapDurationS: gapS,
			medianPriorGapS: priorGapsInRun.length > 0 ? median(priorGapsInRun) : 0,
			preGapFixCount: runs[runs.length - 1].length,
			stepsInGap,
			hrMeanInGap: hrMean,
			hrSamplesInGap: hrInGap.length,
			postGapDistFromCentroidM: postGapDist,
		});

		if (score > SPLIT_THRESHOLD_NATS) {
			// Close current run, start a fresh one at this fix.
			runs.push([cur]);
			priorGapsInRun.length = 0;
			runCentroidLat = cur.lat;
			runCentroidLon = cur.lon;
		} else {
			// Stay merged — long gap not strong enough evidence of departure.
			const run = runs[runs.length - 1];
			run.push(cur);
			priorGapsInRun.push(gapS);
			runCentroidLat += (cur.lat - runCentroidLat) / run.length;
			runCentroidLon += (cur.lon - runCentroidLon) / run.length;
		}
	}

	return runs;
}

// --- vehicle-leg split inside a walk ----------------------------------
// Sibling of splitWalksOnEvidence (which carves a SIT out of a walk using
// step cadence). This carves a VEHICLE leg out of a walk using GPS net
// progress: a "walking" segment that actually contains a short ride —
// classically "walked out of the station, then took a taxi/bus the rest
// of the way" — comes out as one walking segment because its mean speed
// averages the on-foot part with the ride. We must use NET DISPLACEMENT,
// not the per-fix speed: standing in an urban canyon produces jittery
// 20 km/h speed READINGS with near-zero actual progress, so a speed-only
// rule would mis-split a stationary platform wait. A vehicle leg is a run
// of fixes that genuinely *travels* at vehicle pace.

/** Only walks longer than this are worth examining for a hidden ride. */
const VEHICLE_LEG_MIN_SEGMENT_S = 5 * 60;
/** Net-progress speed (km/h) that marks a fix as travelling, not walking.
 *  Comfortably above the 12 km/h walking ceiling (constraint C2) so GPS
 *  noise on a real walk can't reach it. */
const VEHICLE_LEG_MOVE_KMH = 15;
/** The carved leg must actually go somewhere — net displacement floor. */
const VEHICLE_LEG_MIN_DIST_M = 400;
/** …over at least this long, so a single glitchy pair can't trigger it. */
const VEHICLE_LEG_MIN_DURATION_S = 120;
/** …and contain at least one unambiguously-motorised instant — a speed
 *  no walker or runner sustains. This second signal, combined with real
 *  net progress, is what separates a ride from urban-canyon jitter. */
const VEHICLE_LEG_PEAK_KMH = 20;
/** A residual walk shorter than this on either side of the leg isn't
 *  worth emitting as its own row — fold it into the ride instead. */
const VEHICLE_LEG_MIN_REMAINDER_S = 60;

/**
 * Split each `walking` segment that hides a vehicle leg into
 * `[walk?, driving, walk?]`. The carved leg is left as `driving`; the
 * later bus-vs-car pass (#247) and OSM road naming refine it. Walks with
 * no qualifying ride pass through untouched. Pure.
 */
export function splitWalksOnVehicleLeg<T extends TrackSegment>(
	segments: readonly T[],
	points: readonly FilteredPoint[],
): T[] {
	const debug = process.env.VEHICLE_SPLIT_DEBUG === "1";
	const tt = (ts: number): string => new Date(ts * 1000).toISOString().slice(11, 16);
	const out: T[] = [];
	const isTrain = (s: T | undefined): boolean =>
		s !== undefined && ((s as { refinedMode?: TransportMode }).refinedMode ?? s.mode) === "train";
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (seg.mode !== "walking" || seg.endTs - seg.startTs < VEHICLE_LEG_MIN_SEGMENT_S) {
			out.push(seg);
			continue;
		}
		const fixes = samplesInWindow(points, seg).sort((a, b) => a.ts - b.ts);
		if (debug) {
			console.error(
				`[vehicle-split] walk ${tt(seg.startTs)}-${tt(seg.endTs)} fixes=${fixes.length} speeds=${fixes.map((f) => Math.round(f.speed_kmh ?? 0)).join(",")}`,
			);
		}
		if (fixes.length < 3) {
			out.push(seg);
			continue;
		}

		// Find the contiguous fix interval [a,b] that best looks like a
		// ride: real net displacement covered at vehicle MEAN pace. The
		// mean-speed gate is the discriminator — a genuine walk can't
		// average 15 km/h, and station jitter (high speed readings, no net
		// progress) can't clear the distance floor. O(n²), n tiny.
		const peakBetween = (a: number, b: number): number => {
			let p = 0;
			for (let k = a; k <= b; k++) p = Math.max(p, fixes[k].speed_kmh ?? 0);
			return p;
		};
		let best: { a: number; b: number; netDist: number; dur: number; peak: number } | null = null;
		for (let a = 0; a < fixes.length - 1; a++) {
			for (let b = a + 1; b < fixes.length; b++) {
				const dur = fixes[b].ts - fixes[a].ts;
				if (dur < VEHICLE_LEG_MIN_DURATION_S) continue;
				const netDist = haversineMeters(fixes[a].lat, fixes[a].lon, fixes[b].lat, fixes[b].lon);
				if (netDist < VEHICLE_LEG_MIN_DIST_M) continue;
				if ((netDist / dur) * 3.6 < VEHICLE_LEG_MOVE_KMH) continue;
				const peak = peakBetween(a, b);
				if (peak < VEHICLE_LEG_PEAK_KMH) continue;
				// Prefer the interval covering the most ground; at a tie prefer
				// the tighter (shorter) one, so flat departure/arrival fixes
				// don't pad the leg into the adjacent on-foot stretch.
				if (!best || netDist > best.netDist || (netDist === best.netDist && dur < best.dur)) {
					best = { a, b, netDist, dur, peak };
				}
			}
		}
		if (debug) {
			console.error(
				`[vehicle-split]   best=${best ? `${tt(fixes[best.a].ts)}-${tt(fixes[best.b].ts)} dist=${Math.round(best.netDist)} mean=${Math.round((best.netDist / best.dur) * 3.6)} peak=${Math.round(best.peak)}` : "none"}`,
			);
		}
		if (!best) {
			out.push(seg);
			continue;
		}
		// Trim on-foot shoulders the max-distance interval may have
		// absorbed (slow walking that progresses in the same direction):
		// shrink inward while the boundary step isn't itself vehicle-paced.
		const stepKmh = (i: number, j: number): number => {
			const dt = fixes[j].ts - fixes[i].ts;
			return dt > 0 ? (haversineMeters(fixes[i].lat, fixes[i].lon, fixes[j].lat, fixes[j].lon) / dt) * 3.6 : 0;
		};
		let a = best.a;
		let b = best.b;
		while (a < b && stepKmh(a, a + 1) < VEHICLE_LEG_MOVE_KMH) a++;
		while (b > a && stepKmh(b - 1, b) < VEHICLE_LEG_MOVE_KMH) b--;
		const netDist = haversineMeters(fixes[a].lat, fixes[a].lon, fixes[b].lat, fixes[b].lon);
		const dur = fixes[b].ts - fixes[a].ts;
		const peak = peakBetween(a, b);

		// Boundaries: fold a sub-minute residual walk into the ride.
		let driveStart = fixes[a].ts;
		let driveEnd = fixes[b].ts;
		if (driveStart - seg.startTs < VEHICLE_LEG_MIN_REMAINDER_S) driveStart = seg.startTs;
		if (seg.endTs - driveEnd < VEHICLE_LEG_MIN_REMAINDER_S) driveEnd = seg.endTs;

		// Train-bleed guard: a walk's tail accelerating into the next train
		// (or its head decelerating out of the previous one) is the train
		// boundary bleeding into the walk, not a separate ride. If the
		// carved leg butts against an adjacent train segment, skip it.
		const BLEED_S = 90;
		if (isTrain(segments[i + 1]) && seg.endTs - driveEnd < BLEED_S) {
			if (debug) console.error(`[vehicle-split]   skip: boarding bleed into next train`);
			out.push(seg);
			continue;
		}
		if (isTrain(segments[i - 1]) && driveStart - seg.startTs < BLEED_S) {
			if (debug) console.error(`[vehicle-split]   skip: alighting bleed from prev train`);
			out.push(seg);
			continue;
		}

		const countIn = (from: number, to: number): number => points.filter((p) => p.ts >= from && p.ts < to).length;
		const meanKmh = dur > 0 ? Math.round((netDist / dur) * 3.6 * 10) / 10 : 0;
		// Carve the ride. Clear the inherited on-foot enrichment (footway
		// name, place, walking refinedMode) — OSM enrichment already ran, so
		// this leg stays an un-named `driving` for the bus-vs-car pass (#247)
		// and the day-state layer to render.
		const drivePart = { ...seg } as T & { refinedMode?: TransportMode; wayName?: string; place?: string };
		drivePart.mode = "driving";
		drivePart.refinedMode = undefined;
		drivePart.wayName = undefined;
		drivePart.place = undefined;
		drivePart.startTs = driveStart;
		drivePart.endTs = driveEnd;
		drivePart.avgSpeed = meanKmh;
		drivePart.maxSpeed = Math.round(peak * 10) / 10;
		drivePart.linearity = 1;
		drivePart.pointCount = countIn(driveStart, driveEnd);
		drivePart.refinedReason = `vehicle-leg split: ${Math.round(netDist)} m net progress in ${Math.round(dur / 60)} min (peak ${Math.round(peak)} km/h) inside a walking segment — a ride, not a walk`;
		if (driveStart > seg.startTs) out.push({ ...seg, endTs: driveStart, pointCount: countIn(seg.startTs, driveStart) });
		out.push(drivePart);
		if (driveEnd < seg.endTs) out.push({ ...seg, startTs: driveEnd, pointCount: countIn(driveEnd, seg.endTs) });
	}
	return out;
}

// --- walk→vehicle boundary correction ---------------------------------
// Sibling of splitWalksOnVehicleLeg, for the boundary case that pass can't
// safely touch. When a drive begins, its first seconds — the launch from
// the kerb — are slow enough to look on-foot in a 5-minute window, so
// segmentation glues them onto the *preceding* walk. The median speed then
// hides the fast tail and the leg stays "walking" (2026-06-21 morning: a
// 24 km/h "walk" down the start of the drive). splitWalksOnVehicleLeg
// won't reclaim it — its 400 m / 120 s bars are deliberately high because,
// for a ride hidden in the *middle* of a walk, there is nothing to
// corroborate it and urban-canyon jitter must not trigger a split.
//
// Here there IS corroboration: the next segment is already a confirmed
// road vehicle. So the bar can be low — a short, sustained, real-progress
// run at the walk's tail belongs to the drive it hands off to. We move the
// boundary rather than carve a new segment: the vehicle simply starts
// earlier. Net displacement (not speed readings) is still the gate, so
// stationary jitter at the kerb can't trigger it.

/** Per-step net-progress speed (km/h) that marks the tail as travelling,
 *  not walking — above the 12 km/h walking ceiling so a real walk's GPS
 *  noise can't reach it. */
const HANDOFF_MOVE_KMH = 15;
/** Require a sustained run (this many vehicle-paced steps), so a single
 *  glitchy fix pair can't move the boundary. */
const HANDOFF_MIN_TAIL_STEPS = 2;
/** Net displacement floor for the run — comfortably beyond GPS noise
 *  (~10–20 m), but far below splitWalksOnVehicleLeg's 400 m because the
 *  adjacent confirmed vehicle already corroborates that travel happened. */
const HANDOFF_MIN_NET_DIST_M = 80;
/** …and one unambiguously-motorised instant, as a second signal. */
const HANDOFF_PEAK_KMH = 20;
/** Keep a real walk on the near side: if the run would consume all but
 *  this much of the walk, it isn't a boundary tail — leave it for the
 *  interior-ride pass / mode scorer, don't swallow the whole segment. */
const HANDOFF_MIN_WALK_REMAINDER_S = 60;

/** Road-vehicle modes a walk tail can be reassigned INTO. Train is
 *  excluded on purpose: a walk accelerating into a train is boarding
 *  bleed, handled by the platform/boarding passes, not a road ride. */
const HANDOFF_VEHICLE_MODES: ReadonlySet<string> = new Set(["driving", "bus", "cycling"]);

function segMode(s: { mode: string; refinedMode?: TransportMode }): string {
	return s.refinedMode ?? s.mode;
}

/**
 * Move a walking segment's vehicle-paced trailing run into the road-vehicle
 * segment that immediately follows it, by advancing the shared boundary to
 * where the sustained motion begins. Segment count is unchanged — only the
 * boundary (and the two segments' recomputed speed stats) move. Walks with
 * no qualifying tail, or no road-vehicle successor, pass through untouched.
 * Pure.
 */
export function reassignWalkTailToVehicle<T extends TrackSegment>(
	segments: readonly T[],
	points: readonly FilteredPoint[],
): T[] {
	const segs = [...segments];
	const out: T[] = [];
	const stats = (start: number, end: number): { count: number; avg: number; max: number } => {
		const speeds: number[] = [];
		for (const p of points) if (p.ts >= start && p.ts < end) speeds.push(p.speed_kmh ?? 0);
		const max = speeds.length ? Math.max(...speeds) : 0;
		return { count: speeds.length, avg: Math.round(median(speeds) * 10) / 10, max: Math.round(max * 10) / 10 };
	};

	for (let i = 0; i < segs.length; i++) {
		const cur = segs[i];
		const next = segs[i + 1];
		if (cur.mode !== "walking" || !next || !HANDOFF_VEHICLE_MODES.has(segMode(next))) {
			out.push(cur);
			continue;
		}
		const fixes = samplesInWindow(points, cur).sort((a, b) => a.ts - b.ts);
		if (fixes.length < 3) {
			out.push(cur);
			continue;
		}
		const stepKmh = (a: number, b: number): number => {
			const dt = fixes[b].ts - fixes[a].ts;
			return dt > 0 ? (haversineMeters(fixes[a].lat, fixes[a].lon, fixes[b].lat, fixes[b].lon) / dt) * 3.6 : 0;
		};
		// Walk back from the last fix over consecutive vehicle-paced steps.
		let s = fixes.length - 1;
		let tailSteps = 0;
		while (s > 0 && stepKmh(s - 1, s) >= HANDOFF_MOVE_KMH) {
			s--;
			tailSteps++;
		}
		if (tailSteps < HANDOFF_MIN_TAIL_STEPS) {
			out.push(cur);
			continue;
		}
		const last = fixes.length - 1;
		const netDist = haversineMeters(fixes[s].lat, fixes[s].lon, fixes[last].lat, fixes[last].lon);
		let peak = 0;
		for (let k = s; k <= last; k++) peak = Math.max(peak, fixes[k].speed_kmh ?? 0);
		const driveStart = fixes[s].ts;
		if (netDist < HANDOFF_MIN_NET_DIST_M || peak < HANDOFF_PEAK_KMH) {
			out.push(cur);
			continue;
		}
		if (driveStart - cur.startTs < HANDOFF_MIN_WALK_REMAINDER_S) {
			out.push(cur);
			continue;
		}
		// Move the boundary: walk ends, vehicle begins, at driveStart.
		const walkStats = stats(cur.startTs, driveStart);
		const vehStats = stats(driveStart, next.endTs);
		out.push({
			...cur,
			endTs: driveStart,
			avgSpeed: walkStats.avg,
			maxSpeed: walkStats.max,
			pointCount: walkStats.count,
		});
		segs[i + 1] = {
			...next,
			startTs: driveStart,
			avgSpeed: vehStats.avg,
			maxSpeed: vehStats.max,
			pointCount: vehStats.count,
			refinedReason: `walk→vehicle boundary: ${Math.round(netDist)} m vehicle-paced run (peak ${Math.round(peak)} km/h) reassigned from the preceding walk to this ride`,
		};
	}
	return out;
}

/**
 * Moving-segment merge passes and shared enrichment helpers.
 *
 * Coalesces adjacent moving segments of the same mode, composes a
 * char-budgeted wayName label from their per-segment contributions, and
 * provides the bounded-concurrency `mapLimit` used by segment enrichment.
 * Extracted from the velocity orchestrator.
 */

import type { EnrichedSegment } from "../enriched-segment.js";
import { effectiveMode } from "../segment-util.js";

/**
 * Merge consecutive moving segments that share a refined mode and are
 * separated by a small gap. Mirrors `mergeAdjacentStays` for the moving
 * case: the segment classifier oscillates between similar modes
 * (driving ↔ train) on long highway runs and `refineMode` corrects each
 * label individually but leaves the boundaries in place. This collapses
 * those now-redundant boundaries.
 *
 * Stationary segments are left untouched — that's `mergeAdjacentStays`'
 * job and the predicate there (same `place`) is stricter.
 *
 * A different mode in the middle (e.g. a brief walking break for
 * dropping someone off) breaks the chain — that pause is exactly what
 * the user wants to see.
 */
export const MOVING_MERGE_MAX_GAP_S = 3 * 60;

/** Max segments enriched concurrently. Each segment issues a handful of
 *  DB-backed OSM queries; 6 segments × ~3 in-flight queries stays safely
 *  under the 20-connection pool even when per-query latency is tunnel-high.
 *  See the enrichment call site for the failure this bounds. */
export const ENRICH_CONCURRENCY = 6;

/** `Promise.all(items.map(fn))` with at most `limit` callbacks in flight.
 *  Results keep input order; rejections propagate like Promise.all. */
export async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Pick a wayName label for a merged moving segment. Each source segment
 * contributes its `wayName` weighted by its duration; we sort by time,
 * drop names under WAY_LABEL_MIN_COVERAGE of the total, and emit up to
 * WAY_LABEL_MAX_NAMES names joined by ", " — but stop early if the
 * joined string exceeds WAY_LABEL_MAX_CHARS so the timeline UI stays
 * tidy. The result is always at most one short line of text.
 */
const WAY_LABEL_MAX_CHARS = 30;
const WAY_LABEL_MIN_COVERAGE = 0.15;
const WAY_LABEL_MAX_NAMES = 3;

export function composeWayName(contribs: Map<string, number>): string | null {
	let total = 0;
	for (const v of contribs.values()) total += v;
	if (total === 0) return null;
	const ranked = [...contribs.entries()]
		.sort((a, b) => b[1] - a[1])
		.filter(([, dur]) => dur / total >= WAY_LABEL_MIN_COVERAGE)
		.slice(0, WAY_LABEL_MAX_NAMES)
		.map(([name]) => name);
	if (ranked.length === 0) return null;
	let label = ranked[0];
	for (let i = 1; i < ranked.length; i++) {
		const tentative = `${label}, ${ranked[i]}`;
		if (tentative.length > WAY_LABEL_MAX_CHARS) break;
		label = tentative;
	}
	return label;
}

export function mergeAdjacentMoving(segments: EnrichedSegment[]): EnrichedSegment[] {
	const result: EnrichedSegment[] = [];
	const wayContribs = new WeakMap<EnrichedSegment, Map<string, number>>();
	const addContribution = (target: EnrichedSegment, name: string | undefined, durationS: number): void => {
		if (!name || durationS <= 0) return;
		let m = wayContribs.get(target);
		if (!m) {
			m = new Map();
			wayContribs.set(target, m);
		}
		m.set(name, (m.get(name) ?? 0) + durationS);
	};

	for (const seg of segments) {
		const prev = result[result.length - 1];
		const segMode = effectiveMode(seg);
		const segDuration = seg.endTs - seg.startTs;
		// Strictly conflicting city tags (both defined, different value) block
		// the merge — the user crossed an actual boundary. A defined city
		// next to an untagged transit segment is fine to merge: the merged
		// city falls back to undefined unless all sources agree (handled below).
		const citiesConflict =
			prev !== undefined && prev.city !== undefined && seg.city !== undefined && prev.city !== seg.city;

		if (
			prev &&
			segMode !== "stationary" &&
			effectiveMode(prev) === segMode &&
			seg.startTs - prev.endTs <= MOVING_MERGE_MAX_GAP_S &&
			!citiesConflict
		) {
			const w0 = prev.pointCount;
			const w1 = seg.pointCount;
			const wTot = w0 + w1;
			prev.endTs = seg.endTs;
			prev.pointCount = wTot;
			prev.avgSpeed = Math.round(((prev.avgSpeed * w0 + seg.avgSpeed * w1) / wTot) * 10) / 10;
			prev.maxSpeed = Math.round(Math.max(prev.maxSpeed, seg.maxSpeed) * 10) / 10;
			prev.linearity = Math.round(((prev.linearity * w0 + seg.linearity * w1) / wTot) * 100) / 100;
			prev.confidence = Math.round(((prev.confidence * w0 + seg.confidence * w1) / wTot) * 100) / 100;
			prev.confidenceMargin = Math.round(((prev.confidenceMargin * w0 + seg.confidenceMargin * w1) / wTot) * 100) / 100;
			// City: only carry forward if all merged sources agree on it.
			// Mismatched (one tagged, the other untagged) → drop, since the
			// merged span no longer corresponds to a single city.
			if (prev.city !== seg.city) prev.city = undefined;
			addContribution(prev, seg.wayName, segDuration);
		} else {
			const copy = { ...seg };
			result.push(copy);
			addContribution(copy, seg.wayName, segDuration);
		}
	}

	// Resolve composite wayName from per-segment contributions. A single
	// contributor short-circuits to the existing wayName; multiple sources
	// produce a time-ordered, coverage-filtered, char-budgeted label.
	for (const seg of result) {
		const contribs = wayContribs.get(seg);
		if (!contribs) continue;
		const composite = composeWayName(contribs);
		if (composite) seg.wayName = composite;
	}

	return result;
}

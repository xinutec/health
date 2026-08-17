/**
 * In-memory cache for `/api/velocity` results.
 *
 * `computeVelocity` does a Nextcloud fetch + Kalman + segmentation +
 * OSM enrichment + biometric joins; on a data-rich day it takes
 * 5–10 seconds. Most of that work is deterministic for a given
 * `(user_id, date, tz)`, and the user typically revisits the same
 * day several times during a session (tab switches, chevron
 * navigation, refreshes). Caching the result in-process turns
 * those repeat views into ~50ms reads.
 *
 * Design choices:
 *
 *   - **Per-pod only.** Cleared on every process restart, which
 *     means a deploy automatically invalidates everything — no
 *     schema-version tag, no stale-cache-after-logic-change risk.
 *     The trade-off: cold cache after each deploy, so the first
 *     view of any day after deploy still pays the full compute.
 *     Nothing changes the pipeline's answer WITHOUT a restart any
 *     more: the verified-core master toggle was the one exception
 *     and it was removed with the TS arm (#975). Anything that
 *     reintroduces live switching must clear this cache too.
 *
 *   - **Short TTL (5 min).** Today's date keeps accumulating new
 *     Owntracks pushes, and Fitbit sleep sync can land any time.
 *     A 5-minute window is short enough that the user sees fresh
 *     data within a fix-or-two of it arriving, and long enough
 *     that a typical session of tab-switching benefits.
 *
 *   - **LRU eviction at 32 entries.** Single user covers maybe a
 *     month of recently-visited days; 32 leaves headroom without
 *     unbounded growth.
 *
 *   - **In-flight dedup.** Two concurrent requests for the same
 *     key share a single computation. Without this, opening the
 *     dashboard in two tabs would trigger two parallel
 *     OSM-enrichment runs hitting the same DB rows.
 *
 *   - **Logs hit/miss to stdout.** So we can confirm the cache is
 *     working from `kubectl logs` without instrumenting the
 *     frontend.
 */

import type { VelocityResult } from "../geo/velocity.js";

interface CacheEntry {
	result: VelocityResult;
	cachedAtMs: number;
}

const TTL_MS = 5 * 60 * 1000;

/** TTL for a day that is still happening.
 *
 *  A finished day's classification is settled: replaying it tomorrow gives the
 *  same answer, so five minutes of staleness costs nothing. A day *in progress*
 *  is a different object — every new fix can change it, and the pipeline's
 *  verdict on an unfinished journey is provisional by construction. One minute
 *  into a tube ride the rail passes have too little track to identify the line,
 *  so the leg reads as an unidentified vehicle; two minutes later it is a train
 *  on the Metropolitan Line. Cache the first answer for five minutes and the
 *  user stares at a superseded verdict long after the pipeline would have
 *  corrected itself (the 2026-07-12 report).
 *
 *  The cost is affordable precisely because the day is partial: today's compute
 *  runs in a few hundred milliseconds mid-morning, not the 5–10 s a full
 *  data-rich day takes — there is simply less of it. So a live day gets a short
 *  TTL, still long enough to absorb tab-switching and chevron navigation. */
export const LIVE_TTL_MS = 60 * 1000;

const MAX_ENTRIES = 32;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<VelocityResult>>();

/** Bumped by {@link invalidateVelocityCache}. A compute that started under an
 *  older generation must not write its result into the cleared cache — see
 *  there for why clearing the map alone is not enough. */
let generation = 0;

/** Is `date` the day currently in progress, as the viewer experiences it?
 *
 *  The boundary that matters is the viewer's local midnight, not UTC's — at
 *  23:30 in London the UTC date has already rolled over, and treating the day
 *  as finished would freeze the evening's timeline an hour early. `tz`
 *  undefined mirrors the API's own fallback: the date is read as UTC.
 *
 *  `nowMs` is injectable so this is testable without freezing the clock. */
export function isLiveDay(date: string, tz: string | undefined, nowMs: number = Date.now()): boolean {
	const today = new Intl.DateTimeFormat("en-CA", {
		timeZone: tz ?? "UTC",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(nowMs));
	return date === today;
}

/** Get a velocity result from the cache, or compute and cache it. Generic so
 *  the route can cache the result with request-scoped extras attached (the
 *  watch-battery series) without widening `VelocityResult` itself; one key
 *  always stores what its own `compute` returned.
 *
 *  `ttlMs` lets the caller shorten the window for a day still in progress —
 *  see {@link LIVE_TTL_MS}. */
export async function getVelocityCached<T extends VelocityResult>(
	key: string,
	compute: () => Promise<T>,
	ttlMs: number = TTL_MS,
): Promise<T> {
	const entry = cache.get(key);
	if (entry && Date.now() - entry.cachedAtMs < ttlMs) {
		// LRU bump: delete + re-insert so this key is now most-recent.
		cache.delete(key);
		cache.set(key, entry);
		console.log(`velocity-cache HIT ${key} age=${Math.round((Date.now() - entry.cachedAtMs) / 1000)}s`);
		return entry.result as T;
	}

	// In-flight dedup: if another request for the same key is already
	// computing, await its promise instead of starting a parallel run.
	const pending = inFlight.get(key);
	if (pending) {
		console.log(`velocity-cache JOIN ${key}`);
		return pending as Promise<T>;
	}

	console.log(`velocity-cache MISS ${key}`);
	const startedIn = generation;
	const promise = compute()
		.then((result) => {
			// Computed across an invalidation: this result came out of the engine
			// that was live when it started, which is exactly what the invalidation
			// was discarding. Return it to the caller who asked before the switch,
			// but do not seat it in the cache — that would re-admit a pre-switch
			// answer with a full fresh TTL.
			if (generation !== startedIn) {
				console.log(`velocity-cache STALE ${key} — spanned an invalidation, not stored`);
				return result;
			}
			// LRU eviction: if at cap, drop the oldest entry. Map
			// preserves insertion order; the first key is the oldest.
			if (cache.size >= MAX_ENTRIES) {
				const oldest = cache.keys().next().value;
				if (oldest !== undefined) cache.delete(oldest);
			}
			cache.set(key, { result, cachedAtMs: Date.now() });
			return result;
		})
		.finally(() => {
			// Only retire OUR slot. If an invalidation dropped this promise from
			// the map and a later caller registered a replacement compute for the
			// same key under the new engine, a bare delete would evict that live
			// entry and the caller after it would start a third run.
			if (inFlight.get(key) === promise) inFlight.delete(key);
		});

	inFlight.set(key, promise);
	return promise;
}

/** Clear the cache, dropping in-flight computes as well as seated entries.
 *
 * ⚠ `invalidateVelocityCache` IS GONE (#975), and so is the reason it existed.
 * Its only caller was the verified-core master toggle, which swapped the Lean
 * core for TS inside a live process — the one thing that changed what
 * `computeVelocity` returns WITHOUT a restart. With the toggle removed, the
 * cache's per-pod assumption holds again on its own: only a deploy changes the
 * answer, and a deploy restarts the pod. The invalidator is not unused so much
 * as unnecessary.
 *
 * ⚠ Anything that later changes the pipeline's answer under a running pod must
 * bring it back. This is the note that says so.
 *
 * The generation bump is what drops in-flight work: a compute that began before
 * the clear still completes and still returns to whoever was already awaiting
 * it, but its result is not seated afterwards. Underscored because production
 * has no caller — the tests are the only ones, and that is the point. */
export function _resetVelocityCache(): void {
	generation++;
	cache.clear();
	inFlight.clear();
}

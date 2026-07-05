/**
 * Shared Overpass + Nominatim fetcher used by `osm.ts` (cache-based
 * Nominatim path) and `osm-local.ts` (spatially-indexed mirror).
 *
 * Two mirrors, each with a hard timeout so a hung connection-refused
 * doesn't sit for minutes blocking the velocity pipeline. Plus a
 * circuit breaker (see `osm-overpass-breaker.ts`) — when the public
 * mirrors start rate-limiting we'd otherwise eat 20s of timeout on
 * every queued request; the breaker turns that into a fail-fast.
 */

import { isOverpassBreakerOpen, recordOverpassFailure, recordOverpassSuccess } from "./osm-overpass-breaker.js";

export const USER_AGENT = "health.xinutec.org (pippijn@xinutec.org)";

/** Thrown by `overpassFetch` when the circuit breaker is open.
 *  Callers (`ensureCovered` and its friends) catch it and treat it
 *  like any other transient Overpass failure — log + skip enrichment
 *  for this request — but the distinct class makes intent clear. */
export class OverpassBreakerOpenError extends Error {
	constructor() {
		super("Overpass circuit breaker is open — skipping fetch");
		this.name = "OverpassBreakerOpenError";
	}
}

const OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

// 4s was fine for point-radius queries (small responses); the local
// mirror's 10 km bbox queries — especially landmark + highway in dense
// urban areas — can legitimately take 10+ seconds. 20s keeps us under
// the Overpass server-side `[timeout:25]` while leaving headroom for
// a hung connection to abort and fall through to the mirror.
const OVERPASS_TIMEOUT_MS = 20_000;

/** Maximum number of concurrent Overpass fetches across the whole
 *  process. With the streaming JSON parser in osm-local each fetch
 *  peaks at ~5-10 MB regardless of response size (elements get
 *  flushed in 500-feature batches; the byte buffer is small), so two
 *  in flight at once is comfortably under the 512 MB pod limit. We
 *  cap at 2 anyway — Overpass's public mirrors rate-limit aggressive
 *  clients and serialising a bit on our side is friendlier than
 *  triggering 429s mid-pipeline. */
const OVERPASS_CONCURRENCY = 2;
let inFlight = 0;
const queue: Array<() => void> = [];
function acquire(): Promise<void> {
	if (inFlight < OVERPASS_CONCURRENCY) {
		inFlight++;
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		queue.push(() => {
			inFlight++;
			resolve();
		});
	});
}
function release(): void {
	inFlight--;
	const next = queue.shift();
	if (next) next();
}

/**
 * POST a single Overpass query body to each mirror in turn until one
 * returns a successful response. Each mirror gets up to
 * `OVERPASS_TIMEOUT_MS` before we abort and try the next. Throws only
 * if every mirror fails — caller decides whether to negative-cache,
 * skip, or surface the error.
 */
export async function overpassFetch(body: string, opts: { timeoutMs?: number } = {}): Promise<Response> {
	// Per-call timeout: defaults to the request-path-friendly 20s, but the
	// offline mirror CLIs (refresh-bus-routes) pass a larger budget for
	// heavier area queries that legitimately take longer than the
	// fail-fast request path tolerates.
	const timeoutMs = opts.timeoutMs ?? OVERPASS_TIMEOUT_MS;
	// Fail-fast when the breaker is open: skip the timeout dance
	// on calls that are highly likely to fail anyway. Caller treats
	// this like any other Overpass failure.
	if (isOverpassBreakerOpen()) {
		throw new OverpassBreakerOpenError();
	}
	await acquire();
	try {
		let lastErr: unknown;
		for (const url of OVERPASS_URLS) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const res = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "text/plain", "User-Agent": USER_AGENT },
					body,
					signal: controller.signal,
				});
				if (res.ok) {
					recordOverpassSuccess();
					return res;
				}
				// Non-OK: only fall through on transient (5xx) or
				// rate-limited (429). 4xx that aren't 429 are permanent
				// (bad query); don't waste mirrors on those.
				if (res.status !== 429 && res.status < 500) return res;
				lastErr = new Error(`Overpass ${url} returned ${res.status}`);
			} catch (e) {
				lastErr = e;
			} finally {
				clearTimeout(timer);
			}
		}
		// All mirrors exhausted without a 2xx — count this as one
		// failure for the breaker. Subsequent calls will short-circuit
		// once we cross the threshold.
		recordOverpassFailure();
		throw lastErr ?? new Error("All Overpass mirrors failed");
	} finally {
		release();
	}
}

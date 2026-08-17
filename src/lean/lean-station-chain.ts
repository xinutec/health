/**
 * Request-path staging of the verified station-chain resolver, behind
 * `LEAN_STATIONCHAIN` (#711).
 *
 * The port (#672) has been complete since 2026-08-10: `Verified.Hsmm.
 * StationChain` is pinned by 22 guards and live-compared by
 * `scripts/compare-stationchain.sh` over the eleven decoded-day fixtures,
 * 11/11 identical. What it did NOT have is what every other tenant has — a
 * `LedgerVerdict` and a staging flag — so on LIVE days `resolveStationChain`
 * ran in the TS and the verified twin was consulted on nothing at all. A port
 * measured only on a corpus is measured only where someone chose to look.
 *
 *   off    (default) — no shadow, zero cost.
 *   shadow — resolve both ways, compare the pairs, record. Production keeps
 *            serving the TS resolution.
 *   on     — SERVES the verified resolution, falling back to TS on any bridge
 *            failure. **This is a WRITE path**: `resolveStationChain` runs
 *            inside `segmentsFromStates`, whose output `cli/decode-day.ts`
 *            persists to `decoded_days`, so under `on` the board/alight
 *            stations in the database are the Lean resolver's.
 *
 * The flip to `on` is deliberately not taken here. The four tenants already
 * serving (`rail`, `kalman`, `gpsquality`, `biolabels`) are leaf numeric passes;
 * every tenant still in shadow either writes or feeds geometry into what is
 * written, and this one writes. Shadow is the half that buys live measurement
 * without changing served output, and it is the half that was missing.
 *
 * ## What a shadow day costs, measured before it was wired
 *
 * 2.87 MiB/day mean over the eleven fixtures (2.53 min, 3.31 max), against the
 * HSMM tenant's 33–40 MiB (#411) and the day fold's 0.35 MiB (#424). By
 * component on the worst day: edges 2.02 MiB, nodes 0.65, obs 0.45,
 * relations 0.18, segs ~0. So the route graph is 81% of it.
 *
 * That 81% is NOT prunable, which is worth recording because the prune looks
 * obvious and is wrong. Every edge-length and candidate consumer filters by
 * `lineMemberships`, so sending only the day's own lines seems free — but
 * `stationFootprintNodes` is line-AGNOSTIC: it seeds and terminates the
 * along-line search from any edge within `STATION_FOOTPRINT_M` of a station,
 * whatever line that edge belongs to. Dropping other lines' edges would move
 * the seeds, and therefore the result. A geographic prune fails the same way
 * one step later: node order decides ties in four places, and the comparator's
 * own ablation showed the corpus does not exercise those ties, so a prune that
 * reordered nodes would go green here and be untested where it matters.
 *
 * `underground` is the one field sent and never read. It is left in rather than
 * trimmed: it is a rounding error of the payload, and the encoder's value is
 * that it is the SAME encoder the comparator uses (#426 — two copies of an
 * order-sensitive encoder is how a port drifts).
 */

import { nodeKey, type RouteGraph } from "../geo/route-graph.js";
import type { Observation } from "../hmm/observation.js";
import { type ResolvedStations, type ResolveStationChainOpts, resolveStationChain } from "../hmm/station-chain.js";
import { errorText } from "../util/error-text.js";
import { leanStationChainServe } from "./lean-core.js";
import type { LedgerVerdict } from "./ledger-verdict.js";
import { leanRunScope } from "./run-scope.js";

/**
 * `solo` — the verified resolver alone (#975). No TS arm, no comparison, no
 * fallback.
 *
 * ⚠ The `namedTrainLegs(opts) === 0` guard is dropped, and it is the one guard
 * in the audit that LOOKED like a second code path: it returns
 * `resolveStationChain(opts)` — the whole TS function — rather than a trivial
 * value. It is not. `station-chain.ts:644` skips every segment on exactly the
 * predicate `namedTrainLegs` counts (`mode !== "train" || lineName === null ||
 * lineName === "unknown_rail"`), so with zero named legs it provably returns an
 * empty Map. Lean is asked instead and returns the same.
 */
export type LeanStationChainMode = "off" | "shadow" | "on" | "solo";

export function leanStationChainMode(): LeanStationChainMode {
	// Env-only, as with the sibling tenants.
	const v = process.env.LEAN_STATIONCHAIN;
	return v === "on" || v === "shadow" || v === "solo" ? v : "off";
}

/** The wire form of the route graph.
 *
 *  `nodes` MUST stay in `routeGraph.nodes.values()` order. It is a JS `Map`, so
 *  that is insertion order, and four things downstream read it: the candidate
 *  dedupe keeps the first best, the sort is stable, the cut at
 *  `MAX_CANDIDATES_PER_SIDE` falls where those leave it, and the argmax over
 *  max-marginals is first-wins. Sorting this array to make a diff tidier would
 *  change results. */
function encodeGraph(g: RouteGraph): { edges: unknown[]; nodes: unknown[] } {
	return {
		edges: [...g.edges.values()].map((e) => ({
			id: e.id,
			geometry: e.geometry.map((p) => ({ lat: p.lat, lon: p.lon })),
			lineMemberships: [...e.attrs.lineMemberships],
			underground: e.attrs.underground,
			// The Lean edge carries node KEY STRINGS, not coordinates — `nodeKey`'s
			// `toFixed(5)` rounding stays shell-side, as it does for
			// `RouteConnectivity`. Note the ~0.3 m consequence this creates and
			// which both arms share: a node's coordinates are the rounded key
			// parsed back (`buildRouteGraph` materialises them that way), while the
			// edge geometry it belongs to keeps full precision.
			startNode: nodeKey(e.startPoint.lat, e.startPoint.lon),
			endNode: nodeKey(e.endPoint.lat, e.endPoint.lon),
		})),
		nodes: [...g.nodes.values()].map((n) => ({
			id: n.id,
			lat: n.point.lat,
			lon: n.point.lon,
			stationName: n.stationName ?? null,
			edgeIds: [...n.edgeIds],
		})),
	};
}

function encodeObs(o: Observation): unknown {
	return {
		ts: o.ts,
		gps: o.gps === null ? null : { lat: o.gps.lat, lon: o.gps.lon, speedKmh: o.gps.speedKmh },
		hr: o.hr,
		cadence: o.cadence,
		hourLocal: o.hourLocal,
		dayOfWeekLocal: o.dayOfWeekLocal,
		inBed: o.inBed,
		roadDistM: o.roadDistM ?? null,
		railDistM: o.railDistM ?? null,
		reacquireAgeMin: o.reacquireAgeMin ?? null,
		prevGpsFix: o.prevGpsFix,
		nextGpsFix: o.nextGpsFix,
	};
}

/**
 * The station-chain request, exactly as both the tenant and
 * `compare-stationchain.ts` send it. ONE encoder, imported by both: the node
 * and candidate orders it fixes are load-bearing, so a second copy would be a
 * second set of tie-breaks that could drift apart while both looked right.
 */
export function encodeStationChainRequest(opts: ResolveStationChainOpts): Record<string, unknown> {
	return {
		...encodeGraph(opts.routeGraph),
		obs: opts.observations.map(encodeObs),
		segs: opts.segments.map((s) => ({
			startTs: s.startTs,
			endTs: s.endTs,
			mode: s.mode,
			lineName: s.lineName,
		})),
		// `undefined` and `[]` are different requests: absent means the mirror was
		// never consulted (every servedPen is 0), empty means it was and had
		// nothing. Preserve the distinction rather than defaulting.
		relations:
			opts.railStopRelations === undefined
				? null
				: opts.railStopRelations.map((r) => ({
						lineRef: r.lineRef,
						lineName: r.lineName,
						stops: r.stops.map((s) => ({ name: s.name })),
					})),
	};
}

/** Named-line train legs — the only thing this resolver can act on, and so the
 *  denominator that decides whether a shadow day measured anything. */
function namedTrainLegs(opts: ResolveStationChainOpts): number {
	return opts.segments.filter((s) => s.mode === "train" && s.lineName !== null && s.lineName !== "unknown_rail").length;
}

function resolveViaLean(opts: ResolveStationChainOpts): Map<number, ResolvedStations> {
	const res = leanStationChainServe(encodeStationChainRequest(opts));
	if (res.error !== undefined || res.resolved === undefined) {
		throw new Error(`lean station-chain returned no resolution: ${res.error ?? "missing resolved"}`);
	}
	return new Map(res.resolved.map(([i, board, alight]) => [i, { board, alight }]));
}

/** Canonical form of one day's resolution, for an order-independent compare.
 *  The resolver returns a `Map` keyed by segment index, so sorting by that key
 *  compares the CONTENT rather than two insertion orders. */
function pairs(m: Map<number, ResolvedStations>): string {
	return [...m.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([i, r]) => `${i}|${r.board ?? "-"}|${r.alight ?? "-"}`)
		.join(" ");
}

interface ChainStats {
	/** Days the shadow ran — days with at least one named-line train leg. */
	days: number;
	/** Named-line train legs those days offered. Zero legs over a whole run is
	 *  a clean sweep of nothing, which the ledger must not report as a pass. */
	legs: number;
	/** Days whose Lean pairs differed from the TS pairs. */
	diverged: number;
	/** Days whose bridge call threw — resolve continued on the TS arm. */
	skipped: number;
}

interface ChainDivergence {
	date: string;
	kind: "pairs" | "skip";
	detail: string;
	scope: string;
}

const MAX_DIVERGENCES = 32;
const fresh = (): ChainStats => ({ days: 0, legs: 0, diverged: 0, skipped: 0 });
let stats = fresh();
const divergences: ChainDivergence[] = [];

export function resetLeanStationChainStats(): void {
	stats = fresh();
	divergences.length = 0;
}

function record(date: string, kind: ChainDivergence["kind"], detail: string): void {
	if (divergences.length >= MAX_DIVERGENCES) return;
	divergences.push({ date, kind, detail, scope: leanRunScope() });
}

/**
 * Resolve the day's board/alight pairs through whichever arm `LEAN_STATIONCHAIN`
 * selects, shadowing the other when asked.
 *
 *   off    → TS, no bridge call.
 *   shadow → TS is returned; Lean is run alongside and compared.
 *   on     → Lean is returned, with a TS fallback on ANY bridge failure. A
 *            verified-core hiccup must never crash or corrupt a persisted
 *            decode, the same fail-safe the other seven tenants use, and every
 *            fallback is warned so a silently-degrading serve path stays visible.
 *
 * A day with no named-line train leg makes NO bridge call in any mode. There is
 * nothing for the resolver to decide, and 2.87 MiB to decide it with would be
 * the pure waste this tenant was sized to avoid — so those days are not counted
 * as shadowed either, which keeps `calls` honest about what was measured.
 *
 * `date` is passed in rather than derived from `observations[0].ts`, which was
 * the first attempt and was wrong twice over: `Observation.ts` is unix SECONDS
 * against `Date`'s milliseconds (every day came out `1970-01-21`), and once
 * that was fixed the UTC date of a LOCAL day's first minute is the day before
 * during BST. `HsmmInputs.date` is the local date `decoded_days` is keyed by,
 * and the caller already holds it. The ledger's date is the only handle a live
 * divergence gives anyone for finding the day it happened on, so it has to be
 * the same string the database uses.
 */
export function resolveStationsServed(opts: ResolveStationChainOpts, date: string): Map<number, ResolvedStations> {
	const mode = leanStationChainMode();
	// ⚠ BEFORE the legs guard, which would otherwise route straight into the TS
	// resolver — the one thing `solo` exists to stop. A day with no named train
	// legs simply asks Lean and gets an empty Map back.
	if (mode === "solo") {
		stats.days += 1;
		stats.legs += namedTrainLegs(opts);
		return resolveViaLean(opts);
	}
	if (mode === "off" || namedTrainLegs(opts) === 0) return resolveStationChain(opts);

	if (mode === "on") {
		stats.days += 1;
		stats.legs += namedTrainLegs(opts);
		try {
			return resolveViaLean(opts);
		} catch (err) {
			stats.skipped += 1;
			record(date, "skip", errorText(err));
			console.warn(`[lean-stationchain] on but bridge failed for ${date} (${errorText(err)}) — serving TS resolution`);
			return resolveStationChain(opts);
		}
	}

	const ts = resolveStationChain(opts);
	stats.days += 1;
	stats.legs += namedTrainLegs(opts);
	try {
		const lean = resolveViaLean(opts);
		const tsKey = pairs(ts);
		const leanKey = pairs(lean);
		if (tsKey === leanKey) {
			console.log(`lean-stationchain ${date} EXACT ${ts.size} pair(s) / ${namedTrainLegs(opts)} leg(s)`);
		} else {
			stats.diverged += 1;
			record(date, "pairs", `ts=[${tsKey}] lean=[${leanKey}]`);
			console.log(`lean-stationchain ${date} DIVERGED ts=[${tsKey}] lean=[${leanKey}]`);
		}
	} catch (err) {
		stats.skipped += 1;
		record(date, "skip", errorText(err));
		console.log(`lean-stationchain ${date} SKIPPED: ${errorText(err)}`);
	}
	return ts;
}

/**
 * Emit the accumulating station-chain ledger and reset. Mirrors
 * `logLeanHsmmLedger`: a run is EXACT only when every shadowed day's pairs
 * matched and nothing was skipped.
 *
 * Zero days is NOT a pass (#392) — and unlike the other tenants, this one has
 * two different ways to reach zero, which the printed line distinguishes
 * because they mean opposite things. Zero DAYS is the tenant never running.
 * Zero LEGS across days that did run cannot happen here (a legless day makes no
 * call at all), which is precisely why the leg count is carried: it is the
 * evidence that the days counted had something to decide.
 */
export function logLeanStationChainLedger(label: string): LedgerVerdict | null {
	const mode = leanStationChainMode();
	if (mode === "off") return null;
	const s = stats;
	const bad = s.diverged + s.skipped;
	// ⚠ `solo` must not print EXACT: `diverged`/`skipped` are structurally zero
	// with no TS arm and nothing to skip TO. The leg count stays in the line and
	// is the useful part — it is the evidence that the days counted had
	// something to decide, which matters more once nothing is compared.
	const verdict =
		s.days === 0
			? "NOT EXERCISED"
			: mode === "solo"
				? `SOLO (no TS arm; ${s.days} day(s) / ${s.legs} leg(s) resolved)`
				: bad === 0
					? "EXACT"
					: `${bad} DIVERGED`;
	const detail = bad === 0 ? "" : ` — pairs=${s.diverged} skip=${s.skipped}`;
	const legs =
		divergences.length === 0
			? ""
			: ` — ${divergences.map((d) => `[${d.scope}] ${d.date} ${d.kind}:${d.detail}`).join("; ")}`;
	console.log(
		`lean-stationchain[${mode}] ${label} ${s.days}d/${s.legs} leg(s)${s.days === 0 ? " (no days)" : ""}${detail} ${verdict}${legs}`,
	);
	const out: LedgerVerdict = {
		tenant: "stationchain",
		mode,
		// One bridge call per shadowed day, so days ARE calls. `skipped` is a
		// subset of `days` rather than a separate tally — the two must not be
		// added — and it is this tenant's `fails`: a day whose bridge threw is a
		// day the verified arm did not run, the swallowed-failure shape the gate
		// exists to catch.
		calls: s.days,
		fails: s.skipped,
		// No per-leg fingerprint, deliberately. A divergence here could be keyed
		// by leg, but #662 is the standing lesson about what that costs: the
		// accepted-match manifest is keyed on leg CONTENT, so every upstream edit
		// re-fingerprints legs and strands the adjudication. Until that keying is
		// fixed, this tenant compares whole days and any divergence fails outright
		// — which is the right default for a resolver whose comparator is green on
		// every corpus day.
		unexplained: [],
		klass: s.days === 0 ? "not-exercised" : bad === 0 ? "exact" : "diverged",
	};
	resetLeanStationChainStats();
	return out;
}

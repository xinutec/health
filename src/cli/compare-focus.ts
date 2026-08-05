/**
 * CLI: does the Lean focus-place miner produce what the TS miner produced?
 *
 * The referee for `Verified.Geo.FocusPlaces` (800 lines) and
 * `Verified.Geo.FocusIdentity` (#435). Both were GUARD-PINNED and nothing else:
 * they port the weekly `refresh-focus-places` cron, which no day replay
 * reaches, so a drift would have been found the way #417 and #425 were — by
 * reading, or by a production run going wrong. A `#guard` is a snapshot of what
 * V8 answered when the port was written; it keeps passing while the TS moves
 * underneath it.
 *
 * # Why this is the simplest referee in the repo
 *
 * `detectFocusPlaces` takes a point list. No `OsmAdapter`, no lookup tables —
 * so there is no recorded-vs-computed oracle to get wrong (#428), no
 * demand-driven rounds, no wire budget worth measuring. Both arms get the same
 * bytes and the difference is the computation.
 *
 * # What it replays, and why each input is there
 *
 *   per day     Each golden day's PhoneTrack fixes through `detectFocusPlaces`.
 *               33 independent real inputs, so a divergence names a DAY.
 *   corpus      Every day's fixes at once, deduplicated and sorted the way
 *               `refresh-focus-places.ts` does. This is the shape the cron
 *               actually runs on, and it is the ONLY input here that can reach
 *               the long-span classification branches: `home` wants a 30-day
 *               span and 20 distinct days, `frequent` a 30-day span — no single
 *               day can produce either, so per-day runs alone would agree on
 *               `one-off` forever and prove nothing about the rest.
 *   split       The captured conflated café/residence and Home clusters, which
 *               go straight to `splitCluster`. These are months of history each
 *               and no day's points reproduce them; they are also the reason
 *               that fixture exists (`capture-focusplaces-fixture.ts`), and
 *               until now the Lean arm had never seen them, so the hardest
 *               input the TS is tested on was the one the port had not run.
 *
 * `matchClusters` rides on the corpus case: OLD is what the first half of the
 * corpus mines, NEW is what the whole corpus mines. That is a real re-mining
 * pair rather than a fabricated one — which matters, because the identity map
 * is exactly the thing whose failure mode is silent (a churned id that
 * downstream rows still reference). `firstSeenTs` is the cluster's earliest
 * stay, which is what the column means.
 *
 * # What it does NOT reach
 *
 * `pickWinningAmenity`. Its input is a vote tally over OSM venue NAMES, built
 * by `nearbyLandmarks` + `rankVenues` + `isLabelWorthyVenue`. Feeding it here
 * would mean this referee carrying another module's oracle, and a fabricated
 * tally would check nothing. It stays guard-pinned and
 * `lean/experiments/lean-coverage.mts` counts it that way.
 *
 * # The bar is ABSOLUTE
 *
 * Same as the day gate: no ratchet, no blessed baseline. Two implementations of
 * one pure function either agree or one of them is wrong. Every case must be
 * IDENTICAL.
 *
 * A difference is reported as a PATH with a count (`mined[].label: 3 differ`),
 * not as a cluster index — clusters have no identity across the two arms until
 * they are sorted, so naming an index would report a permutation as a
 * divergence (#409, the same trap at the episode level).
 *
 * Needs the local golden fixtures (gitignored, real coordinates), so CI can
 * never run this — the deploy path is the only place it can gate.
 *
 *   pnpm run focus-gate                 # every case
 *   pnpm run focus-gate 2026-05-18      # one day (skips corpus + split)
 *
 * Exit 0 = every case identical. Exit 1 = a divergence or an error.
 * Exit 2 = no corpus.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RawPhonetrackFix } from "../geo/classification-inputs.js";
import {
	assignDisplayNames,
	type Cluster,
	detectFocusPlaces,
	type RawPoint,
	type Stay,
	splitCluster,
} from "../geo/focus-places.js";
import { type ExistingPlace, matchClusters } from "../geo/focus-places-identity.js";
import { floatToBits } from "../lean/float-bits.js";
import { encodeCluster, encodeStay, type FocusRequest, report } from "../lean/focus-payload.js";
import { parseCapturedDay } from "./fixture-day.js";

const ROOT = path.join(import.meta.dirname, "../..");
const DAYS_DIR = path.join(ROOT, "tests/golden/days");
const FIXTURE = path.join(ROOT, "tests/fixtures/focusplaces/2026-05-20-pippijn.json");
const CLI = path.join(ROOT, "lean/.lake/build/bin/verified_cli");

interface SleepWindow {
	startTs: number;
	endTs: number;
}

interface DayInput {
	points: RawPoint[];
	sleepWindows: SleepWindow[];
}

/** The cron's own point loader, minus the network: every fix in the fixture's
 *  three PhoneTrack windows, deduplicated on the key `fetchAllPoints` uses and
 *  sorted by time. The windows overlap at the day boundaries, which is exactly
 *  what that dedupe is for. */
function pointsOf(fixes: RawPhonetrackFix[][]): RawPoint[] {
	const out: RawPoint[] = [];
	const seen = new Set<string>();
	for (const list of fixes) {
		for (const p of list) {
			const k = `${p.ts}/${p.lat.toFixed(6)}/${p.lon.toFixed(6)}`;
			if (seen.has(k)) continue;
			seen.add(k);
			out.push({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy });
		}
	}
	out.sort((a, b) => a.ts - b.ts);
	return out;
}

function loadDay(file: string): DayInput {
	const captured = parseCapturedDay(readFileSync(path.join(DAYS_DIR, file), "utf8"));
	const pt = captured.inputs.phonetrack;
	return {
		points: pointsOf([pt.today, pt.morning, pt.priorEvening]),
		sleepWindows: captured.inputs.sleepWindows.map((w) => ({ startTs: w.startTs, endTs: w.endTs })),
	};
}

/** Merge day inputs into the corpus-wide one, re-running the same dedupe so a
 *  fix that two days' windows both cover is counted once. */
function mergeDays(days: DayInput[]): DayInput {
	const points: RawPoint[] = [];
	const seen = new Set<string>();
	for (const d of days) {
		for (const p of d.points) {
			const k = `${p.ts}/${p.lat.toFixed(6)}/${p.lon.toFixed(6)}`;
			if (seen.has(k)) continue;
			seen.add(k);
			points.push(p);
		}
	}
	points.sort((a, b) => a.ts - b.ts);
	const windows: SleepWindow[] = [];
	const wseen = new Set<string>();
	for (const d of days) {
		for (const w of d.sleepWindows) {
			const k = `${w.startTs}/${w.endTs}`;
			if (wseen.has(k)) continue;
			wseen.add(k);
			windows.push(w);
		}
	}
	return { points, sleepWindows: windows };
}

/** A cluster from a bare stay list — dwell-weighted centroid, the shape
 *  `clusterStays` produces. The fixture stores a cluster's MEMBER STAYS, so
 *  something has to rebuild the record around them; this is input
 *  construction, not either arm's computation, and both arms receive its
 *  output rather than recomputing it. */
function toCluster(stays: Stay[], id: number): Cluster {
	let dwell = 0;
	let lat = 0;
	let lon = 0;
	for (const s of stays) {
		dwell += s.durationSec;
		lat += s.centroidLat * s.durationSec;
		lon += s.centroidLon * s.durationSec;
	}
	return { id, centroidLat: lat / dwell, centroidLon: lon / dwell, stays, totalDwellSec: dwell };
}

/** `focus_places.first_seen_ts` means "when this cluster was first observed",
 *  which for a freshly-mined cluster is its earliest stay. */
function firstSeen(c: Cluster): number {
	return c.stays.reduce((m, s) => Math.min(m, s.startTs), Number.POSITIVE_INFINITY);
}

interface Case {
	name: string;
	request: FocusRequest;
	/** What the TS arm computed, in the wire's own shape. */
	expected: Record<string, unknown>;
}

/** Run the TS arm and render both it and the request. The two are built
 *  together because the response shape mirrors the request's sections. */
function buildCase(
	name: string,
	input: DayInput,
	clusters: Cluster[],
	old: ExistingPlace[],
	splitOf: (c: Cluster) => Cluster[],
): Case {
	const { stays, clusters: mined } = detectFocusPlaces(input.points);
	const identity = matchClusters(
		old,
		mined.map((c) => ({ centroidLat: c.centroidLat, centroidLon: c.centroidLon })),
	);
	return {
		name,
		request: {
			points: input.points.map((p) => [
				p.ts,
				floatToBits(p.lat),
				floatToBits(p.lon),
				p.accuracy === null ? null : floatToBits(p.accuracy),
			]),
			sleepWindows: input.sleepWindows.map((w) => [w.startTs, w.endTs]),
			clusters: clusters.map(encodeCluster),
			old: old.map((o) => [o.id, floatToBits(o.centroidLat), floatToBits(o.centroidLon), o.firstSeenTs]),
		},
		expected: {
			stays: stays.map(encodeStay),
			mined: mined.map((c) => report(c, input.sleepWindows)),
			names: [...assignDisplayNames(mined)].map(([id, n]) => [id, n]),
			split: clusters.map((c) => splitOf(c).map((lobe) => report(lobe, input.sleepWindows))),
			identity: {
				assignments: identity.matches.map((m) => m.oldId),
				deleted: identity.deletedOldIds,
			},
		},
	};
}

/** Key-sorted JSON — `JSON.stringify` is order-sensitive on objects and the two
 *  arms build their records in their own orders. */
function canon(v: unknown): string {
	const walk = (x: unknown): unknown =>
		Array.isArray(x)
			? x.map(walk)
			: x !== null && typeof x === "object"
				? Object.fromEntries(
						Object.entries(x as Record<string, unknown>)
							.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
							.map(([k, v2]) => [k, walk(v2)]),
					)
				: x;
	return JSON.stringify(walk(v));
}

/** Leaf-path differences, array indices collapsed to `[]` and counted, so a
 *  divergence names the FIELD it is in rather than the row it first showed up
 *  on. A length mismatch is its own path — reporting per-element differences
 *  under a shifted array would name every field after the shift. */
function diffPaths(a: unknown, b: unknown, at: string, out: Map<string, number>): void {
	const bump = (p: string): void => {
		out.set(p, (out.get(p) ?? 0) + 1);
	};
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) {
			bump(`${at}.length (TS ${a.length}, Lean ${b.length})`);
			return;
		}
		for (let i = 0; i < a.length; i++) diffPaths(a[i], b[i], `${at}[]`, out);
		return;
	}
	const obj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
	if (obj(a) && obj(b)) {
		for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
			diffPaths(a[k], b[k], at === "" ? k : `${at}.${k}`, out);
		}
		return;
	}
	if (canon(a) !== canon(b)) bump(at);
}

interface Outcome {
	name: string;
	verdict: "IDENTICAL" | "DIVERGED" | "ERROR";
	detail: string;
}

function measure(c: Case): Outcome {
	let raw: string;
	const started = Date.now();
	try {
		raw = execFileSync(CLI, ["focus"], {
			input: JSON.stringify(c.request),
			env: { ...process.env, LEAN_ABORT_ON_PANIC: "1" },
			maxBuffer: 512 * 1024 * 1024,
			encoding: "utf8",
		});
	} catch (e) {
		const err = e as { stderr?: string };
		return { name: c.name, verdict: "ERROR", detail: (err.stderr ?? "").split("\n")[0] || "no stderr" };
	}
	const got = JSON.parse(raw) as Record<string, unknown>;
	if (typeof got.error === "string") return { name: c.name, verdict: "ERROR", detail: `Lean arm: ${got.error}` };

	const diffs = new Map<string, number>();
	diffPaths(c.expected, got, "", diffs);
	if (diffs.size === 0) {
		const mined = (c.expected.mined as unknown[]).length;
		const stays = (c.expected.stays as unknown[]).length;
		return {
			name: c.name,
			verdict: "IDENTICAL",
			detail: `${(c.request.points.length / 1000).toFixed(1)}k points, ${stays} stays, ${mined} clusters, ${Math.round((Date.now() - started) / 1000)}s`,
		};
	}
	return {
		name: c.name,
		verdict: "DIVERGED",
		detail: [...diffs]
			.sort((x, y) => y[1] - x[1])
			.slice(0, 6)
			.map(([p, n]) => `${p}: ${n}`)
			.join("; "),
	};
}

const only = new Set(process.argv.slice(2));
const files = readdirSync(DAYS_DIR)
	.filter((f) => f.endsWith(".json"))
	.filter((f) => only.size === 0 || only.has(f.slice(0, 10)))
	.sort();
if (files.length === 0) {
	console.error(only.size === 0 ? "no golden corpus — capture one first" : "no fixture for the requested date(s)");
	process.exit(2);
}

const noSplit = (c: Cluster): Cluster[] => [c];
const cases: Case[] = [];
const days = files.map(loadDay);
for (let i = 0; i < files.length; i++) {
	cases.push(buildCase(files[i].slice(0, 10), days[i], [], [], noSplit));
}

// The corpus and split cases only make sense over the whole corpus; a
// single-date invocation is a localisation aid and skips them.
if (only.size === 0) {
	const corpus = mergeDays(days);
	// OLD = what the first half mines, NEW = what the whole corpus mines. A real
	// re-mining pair: the same places seen through less history, so the centroids
	// have genuinely moved rather than being perturbed by hand.
	const half = mergeDays(days.slice(0, Math.ceil(days.length / 2)));
	const old: ExistingPlace[] = detectFocusPlaces(half.points).clusters.map((c) => ({
		id: c.id,
		centroidLat: c.centroidLat,
		centroidLon: c.centroidLon,
		firstSeenTs: firstSeen(c),
	}));
	cases.push(buildCase("corpus", corpus, [], old, noSplit));

	if (existsSync(FIXTURE)) {
		const fx = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
			conflated: { stays: Stay[] };
			home: { stays: Stay[] } | null;
		};
		const groups = [toCluster(fx.conflated.stays, 1)];
		if (fx.home !== null) groups.push(toCluster(fx.home.stays, 2));
		cases.push(buildCase("split", { points: [], sleepWindows: corpus.sleepWindows }, groups, [], splitCluster));
	} else {
		console.log("split        SKIPPED     no captured focus-places fixture (local-only)");
	}
}

const started = Date.now();
const outcomes = cases.map(measure);
for (const o of outcomes) console.log(`${o.name.padEnd(12)} ${o.verdict.padEnd(11)} ${o.detail}`);

const tally = new Map<string, number>();
for (const o of outcomes) tally.set(o.verdict, (tally.get(o.verdict) ?? 0) + 1);
console.log(`\n=== ${outcomes.length} case(s) in ${Math.round((Date.now() - started) / 1000)}s ===`);
for (const [v, c] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${v.padEnd(11)} ${c}`);

const failed = outcomes.filter((o) => o.verdict !== "IDENTICAL");
if (failed.length > 0) {
	console.error(`\nFOCUS GATE RED: ${failed.length} case(s) — ${failed.map((f) => f.name).join(", ")}`);
	process.exit(1);
}
console.log("\nfocus gate green: the Lean focus-place miner matches the TS miner on every field");

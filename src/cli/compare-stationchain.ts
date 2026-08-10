/**
 * Three-arm comparator for the C4.3 chained-triple resolver (#672).
 *
 * `station-chain.ts` runs on the SERVED and PERSISTED decode path, and until
 * this file it had no comparator: `Verified.Hsmm.StationChain`'s 22 guards pin
 * it against eleven synthetic outcomes from `station-chain-refs.mts`, which is
 * a snapshot of V8 agreeing with itself. What guards cannot see is the TS
 * moving underneath (#417). This drives both arms over the real decoded-day
 * corpus so a drift shows up as a divergence rather than as a stale guard.
 *
 * ## What is compared, and what deliberately is not
 *
 * The comparison is on the RESOLVED PAIRS — `segIndex → (board, alight)` — and
 * on nothing else. That is the whole output of `resolveStationChain`, and it is
 * what `decode-day.ts` writes to `decoded_days`. The internal scores are not
 * compared because they are not observable: a leg where the two arms disagree
 * about a max-marginal by 1e-15 but agree on the argmax has not diverged in any
 * sense a reader of the timeline could detect.
 *
 * A silent nothing is the failure mode to guard against here, so the run prints
 * how many train legs each day actually offered. A corpus where every day
 * resolves zero legs would otherwise report a clean sweep of nothing.
 *
 * ## Inputs are recomputed, not read from `expected`
 *
 * The fixture carries a blessed `expected: HmmSegment[]`, and using it would
 * have been cheaper than decoding. It is not used: `expected` is only equal to
 * a fresh decode while `golden-hsmm` is green, so reading it would make this
 * comparator quietly depend on another gate's colour. Both arms here are fed
 * from one freshly built model.
 *
 * ## What the first green run does and does not establish
 *
 * Ablated three ways on 2026-08-10, because "11/11 identical" is worthless from
 * a comparator that cannot fail:
 *
 *   - Truncating the Lean arm's node list to 2 → 10 of 11 days DIFF, exit 1.
 *     So the Lean arm is genuinely consulted and a difference is genuinely
 *     detected. This is the check that makes the other two readable.
 *   - REVERSING the node array changed NOTHING. Node order is read in four
 *     places (the candidate dedupe, the stable sort, the cut at
 *     MAX_CANDIDATES_PER_SIDE, the first-wins argmax), so the hazard is real in
 *     the code — but the ties it decides do not occur on this corpus. The
 *     ordering discipline is INSURANCE here, not something these days validate.
 *     A future change that came to depend on order would not be caught by this
 *     run, and should not be read as if it were.
 *   - Perturbing NOT_SERVED_PENALTY changed nothing either, and not because the
 *     served path is dead: the fixtures carry 440 relations each, so it is
 *     exercised — every winning candidate is simply a station its line really
 *     serves, so the penalty is 0 whatever its magnitude.
 *
 * Run: scripts/compare-stationchain.sh
 * Exit 0 = every day's pairs identical. Exit 1 = a divergence. Exit 2 = no corpus.
 */

import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { nodeKey, type RouteGraph } from "../geo/route-graph.js";
import { buildHsmmModel, decodeHsmm } from "../hmm/decode.js";
import type { Observation } from "../hmm/observation.js";
import { resolveStationChain } from "../hmm/station-chain.js";
import { type HsmmCapturedDay, hsmmInputsFromFixture } from "./hsmm-fixture.js";

const ROOT = path.join(import.meta.dirname, "../..");
const DECODED_DIR = path.join(ROOT, "tests/golden/decoded_days");
const CLI = path.join(ROOT, "lean/.lake/build/bin/verified_cli");

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

type Pair = [number, string | null, string | null];

const key = (p: Pair): string => `${p[0]}|${p[1] ?? "-"}|${p[2] ?? "-"}`;

interface Outcome {
	date: string;
	verdict: "IDENTICAL" | "DIVERGED" | "ERROR";
	trainLegs: number;
	resolved: number;
	detail: string;
}

async function run(): Promise<number> {
	let files: string[];
	try {
		files = (await readdir(DECODED_DIR)).filter((f) => f.endsWith(".json")).sort();
	} catch {
		console.error(`no corpus at ${DECODED_DIR} — capture one with capture-hsmm-day.js`);
		return 2;
	}
	if (files.length === 0) {
		console.error(`no fixtures in ${DECODED_DIR}`);
		return 2;
	}

	const outcomes: Outcome[] = [];
	for (const file of files) {
		const captured = JSON.parse(await readFile(path.join(DECODED_DIR, file), "utf8")) as HsmmCapturedDay;
		const date = captured.meta.date;
		const inputs = hsmmInputsFromFixture(captured);
		const model = buildHsmmModel(inputs);
		const segments = decodeHsmm(inputs);
		const trainLegs = segments.filter(
			(s) => s.mode === "train" && s.lineName !== null && s.lineName !== "unknown_rail",
		).length;

		// TS arm.
		const ts: Pair[] = [
			...resolveStationChain({
				segments,
				observations: model.tensor,
				routeGraph: inputs.routeGraph,
				railStopRelations: inputs.railStopRelations,
			}).entries(),
		].map(([i, r]) => [i, r.board, r.alight]);

		// Lean arm — the same four inputs across the wire.
		const request = {
			...encodeGraph(inputs.routeGraph),
			obs: model.tensor.map(encodeObs),
			segs: segments.map((s) => ({
				startTs: s.startTs,
				endTs: s.endTs,
				mode: s.mode,
				lineName: s.lineName,
			})),
			// `undefined` and `[]` are different requests: absent means the mirror
			// was never consulted (every servedPen is 0), empty means it was and
			// had nothing. Preserve the distinction rather than defaulting.
			relations:
				inputs.railStopRelations === undefined
					? null
					: inputs.railStopRelations.map((r) => ({
							lineRef: r.lineRef,
							lineName: r.lineName,
							stops: r.stops.map((s) => ({ name: s.name })),
						})),
		};
		let raw: string;
		try {
			raw = execFileSync(CLI, ["stationchain"], {
				input: JSON.stringify(request),
				env: { ...process.env, LEAN_ABORT_ON_PANIC: "1" },
				maxBuffer: 512 * 1024 * 1024,
				encoding: "utf8",
			});
		} catch (e) {
			const err = e as { stderr?: string };
			outcomes.push({
				date,
				verdict: "ERROR",
				trainLegs,
				resolved: ts.length,
				detail: (err.stderr ?? "").split("\n")[0] || "no stderr",
			});
			continue;
		}
		const got = JSON.parse(raw) as { resolved?: Pair[]; error?: string };
		if (typeof got.error === "string") {
			outcomes.push({ date, verdict: "ERROR", trainLegs, resolved: ts.length, detail: `Lean arm: ${got.error}` });
			continue;
		}
		const lean = got.resolved ?? [];

		const tsKeys = ts.map(key);
		const leanKeys = lean.map(key);
		const onlyTs = tsKeys.filter((k) => !leanKeys.includes(k));
		const onlyLean = leanKeys.filter((k) => !tsKeys.includes(k));
		if (onlyTs.length === 0 && onlyLean.length === 0 && tsKeys.length === leanKeys.length) {
			outcomes.push({ date, verdict: "IDENTICAL", trainLegs, resolved: ts.length, detail: "" });
		} else {
			outcomes.push({
				date,
				verdict: "DIVERGED",
				trainLegs,
				resolved: ts.length,
				detail: `ts-only=[${onlyTs.join(" ")}] lean-only=[${onlyLean.join(" ")}]`,
			});
		}
	}

	let bad = 0;
	let totalLegs = 0;
	let totalResolved = 0;
	for (const o of outcomes) {
		totalLegs += o.trainLegs;
		totalResolved += o.resolved;
		if (o.verdict !== "IDENTICAL") bad++;
		const tag = o.verdict === "IDENTICAL" ? "ok  " : o.verdict === "DIVERGED" ? "DIFF" : "ERR ";
		console.log(
			`${tag} ${o.date}  ${String(o.trainLegs).padStart(3)} train leg(s)  ${String(o.resolved).padStart(3)} resolved` +
				(o.detail ? `  ${o.detail}` : ""),
		);
	}
	// A corpus that resolves nothing would otherwise report a clean sweep of
	// nothing, which is the failure this comparator exists to make impossible.
	console.log(
		`\n${outcomes.length - bad}/${outcomes.length} day(s) identical — ` +
			`${totalResolved} pair(s) resolved across ${totalLegs} named-line train leg(s).`,
	);
	if (totalLegs === 0) {
		console.log("NO TRAIN LEGS IN THE CORPUS — this run compared nothing and must not be read as agreement.");
		return 1;
	}
	return bad > 0 ? 1 : 0;
}

process.exit(await run());

/**
 * CLI: compare-rail — TS↔Lean parity for the rail-snap shortest path.
 *
 * Phase V3 of `docs/proposals/2026-07-verified-core-lean.md`: for each
 * train segment in the captured railsnap fixture(s), build the exact
 * weighted graph production would build (fix cloud, gap bridging, vertex
 * dedup — all TS float heuristics), quantise the edge weights to ×2²⁰
 * integers, and run three shortest-path searches:
 *
 *   float  — TS `shortestPath` on the float-weighted graph (production);
 *   quant  — TS `shortestPath` on the quantised graph;
 *   lean   — `verified_cli rail` on the same quantised graph.
 *
 * The verdict demands lean ≡ quant EXACTLY (identical vertex sequence,
 * and Lean's settled distance equals the recomputed path cost); float↔quant
 * path identity is reported separately as the quantisation-fidelity
 * metric. Each segment is compared in both directions — the reverse run
 * exercises different tie patterns for free.
 *
 * Needs the local railsnap fixture (gitignored, real coordinates) — a
 * tool like golden-hsmm, not part of `npm run verify`.
 *
 * Usage: node dist/cli/compare-rail.js
 * Exit 0 = every comparison EXACT.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	buildRailGraph,
	FixCloud,
	nearestVertex,
	parseRailWayName,
	type RailGeometry,
	resolveStation,
	shortestPath,
} from "../geo/rail-snap.js";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "railsnap");
const LEAN_BIN = process.env.LEAN_CLI ?? path.join(process.cwd(), "lean", ".lake", "build", "bin", "verified_cli");

/** ×2²⁰ — the same quantisation scale as the HSMM shadow. */
const Q = 1 << 20;

interface Fixture {
	schema: string;
	segments: Array<{ startTs: number; endTs: number; mode: string; refinedMode: string | null; wayName: string | null }>;
	rawFixes: Array<{ ts: number; lat: number; lon: number }>;
	osmLines: RailGeometry["lines"];
	osmWayRoutes: RailGeometry["wayRoutes"];
	osmStations: RailGeometry["stations"];
}

/** Quantised adjacency in the exact per-vertex insertion order of the TS
 *  builder — entry order is what the tie-parity claim is about. */
type QAdj = Array<Array<[number, number]>>;

function quantiseAdj(adj: Array<Array<{ to: number; w: number }>>): QAdj {
	return adj.map((row) => row.map((e) => [e.to, Math.round(e.w * Q)]));
}

/** Cost of a vertex sequence over the quantised graph, taking the cheapest
 *  parallel edge per step (mirrors the Lean `pathCost` spec). */
function pathCostQ(qadj: QAdj, p: number[]): number | null {
	let total = 0;
	for (let i = 1; i < p.length; i++) {
		let best: number | null = null;
		for (const [to, w] of qadj[p[i - 1]]) {
			if (to === p[i] && (best === null || w < best)) best = w;
		}
		if (best === null) return null;
		total += best;
	}
	return total;
}

function decodeLeanRail(qadj: QAdj, src: number, dst: number): { path?: number[]; dist?: number; none?: boolean } {
	const res = spawnSync(LEAN_BIN, ["rail"], {
		input: JSON.stringify({ adj: qadj, src, dst }),
		encoding: "utf8",
		maxBuffer: 1 << 28,
	});
	if (res.status !== 0) throw new Error(`verified_cli rail failed: ${res.stderr || res.stdout}`);
	return JSON.parse(res.stdout);
}

function sameSeq(a: number[] | null, b: number[] | null): boolean {
	if (a === null || b === null) return a === null && b === null;
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

function main(): void {
	const files = readdirSync(FIXTURE_DIR)
		.filter((f) => f.endsWith(".json"))
		.sort();
	let failures = 0;
	let compared = 0;
	for (const file of files) {
		const fx = JSON.parse(readFileSync(path.join(FIXTURE_DIR, file), "utf8")) as Fixture;
		const day = file.replace(/\.json$/, "");
		const trainSegs = fx.segments.filter((s) => (s.refinedMode ?? s.mode) === "train" && s.wayName !== null);
		for (const seg of trainSegs) {
			const wayName = seg.wayName as string;
			const parsed = parseRailWayName(wayName);
			if (!parsed) {
				console.log(`compare-rail ${day} "${wayName}" SKIPPED: unparseable label`);
				continue;
			}
			const board = resolveStation(parsed.board, fx.osmStations);
			const alight = resolveStation(parsed.alight, fx.osmStations);
			if (!board || !alight || board.name === alight.name) {
				console.log(`compare-rail ${day} "${wayName}" SKIPPED: unresolved station`);
				continue;
			}
			const corridorFixes = fx.rawFixes.filter((f) => f.ts >= seg.startTs && f.ts <= seg.endTs);
			const cloud = new FixCloud(corridorFixes);
			const graph = buildRailGraph(fx.osmLines, cloud);
			const fromV = nearestVertex(graph, board);
			const toV = nearestVertex(graph, alight);
			if (!fromV || !toV || fromV.id === toV.id) {
				console.log(`compare-rail ${day} "${wayName}" SKIPPED: no distinct endpoint vertices`);
				continue;
			}

			const qadj = quantiseAdj(graph.adj);
			let wmax = 0;
			let edges = 0;
			for (const row of qadj) {
				edges += row.length;
				for (const [, w] of row) if (w > wmax) wmax = w;
			}
			if (wmax > 2 ** 45) throw new Error(`quantised weight ${wmax} out of the expected magnitude range`);

			for (const [src, dst, dir] of [
				[fromV.id, toV.id, "fwd"],
				[toV.id, fromV.id, "rev"],
			] as const) {
				const floatPath = shortestPath(graph, src, dst);
				const quantPath = shortestPath(
					{ vertices: graph.vertices, adj: qadj.map((r) => r.map(([to, w]) => ({ to, w }))) },
					src,
					dst,
				);
				const lean = decodeLeanRail(qadj, src, dst);
				const leanPath = lean.none ? null : (lean.path ?? null);

				const exact =
					sameSeq(leanPath, quantPath) &&
					(leanPath === null || (lean.dist !== undefined && pathCostQ(qadj, leanPath) === lean.dist));
				const fidelity = sameSeq(floatPath, quantPath) ? "float↔quant IDENTICAL" : "float↔quant DIVERGED";
				const verdict = exact ? "EXACT" : "MISMATCH";
				if (!exact) failures++;
				compared++;
				console.log(
					`compare-rail ${day} "${wayName}" ${dir} ${verdict} ${fidelity} ` +
						`V=${graph.vertices.length} E=${edges} len=${leanPath?.length ?? "none"} dist=${lean.dist ?? "none"}`,
				);
			}
		}
	}
	console.log(`compare-rail: ${compared - failures}/${compared} EXACT`);
	if (failures > 0 || compared === 0) process.exit(1);
}

main();

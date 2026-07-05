/**
 * Point-to-point routing on the walkable network — the case-2 primitive of the
 * building-escape corrector
 * (`docs/proposals/2026-07-continuous-field-walk-reconstruction.md`).
 *
 * When a drawn walk's chord cuts through a building block and no vertex sits
 * inside the block to push (sparse fixes), the honest line goes *around* the
 * block along the streets. This module answers exactly that question: the
 * shortest walkable path between two GPS-anchored points.
 *
 * Deliberately NOT the Viterbi matcher: routing between two *known* endpoints is
 * stable; it is global matching over a whole noisy fix cloud that invents wrong
 * routes. The graph is used only for what it is good for — connectivity around
 * an obstacle between two trusted points.
 *
 * Both endpoints are snapped onto the nearest way EDGE (a virtual node spliced
 * into the edge), not the nearest graph node — a mid-street start must not
 * detour to a distant junction first. Pure and deterministic; no DB, no network.
 */

import { projectPointToSegment, type RoadGeometry } from "./map-match-core.js";

interface Pt {
	lat: number;
	lon: number;
}

export interface WalkGraph {
	nodes: Pt[];
	adj: Array<Array<{ to: number; distM: number }>>;
}

/** Node key: coordinates rounded to ~1 cm, so ways that share an OSM junction
 *  node (identical coordinates in the WKT) fuse into one graph node. */
function nodeKey(lat: number, lon: number): string {
	return `${lat.toFixed(7)},${lon.toFixed(7)}`;
}

function metersBetween(a: Pt, b: Pt): number {
	const dLat = (b.lat - a.lat) * 111_320;
	const dLon = (b.lon - a.lon) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

/**
 * Build the walkable graph: one node per distinct way coordinate, an undirected
 * edge per consecutive coordinate pair. Ways connect where they share exact
 * junction coordinates (the OSM convention).
 */
export function buildWalkGraph(geo: RoadGeometry): WalkGraph {
	const nodes: Pt[] = [];
	const adj: WalkGraph["adj"] = [];
	const index = new Map<string, number>();

	const nodeAt = (lat: number, lon: number): number => {
		const key = nodeKey(lat, lon);
		const existing = index.get(key);
		if (existing !== undefined) return existing;
		const id = nodes.length;
		nodes.push({ lat, lon });
		adj.push([]);
		index.set(key, id);
		return id;
	};

	const addEdge = (a: number, b: number): void => {
		if (a === b) return;
		const d = metersBetween(nodes[a], nodes[b]);
		if (d < 1e-3) return;
		// Dedupe: ways can overlap on a shared stretch.
		if (!adj[a].some((e) => e.to === b)) adj[a].push({ to: b, distM: d });
		if (!adj[b].some((e) => e.to === a)) adj[b].push({ to: a, distM: d });
	};

	for (const w of geo.ways) {
		for (let i = 1; i < w.coords.length; i++) {
			const a = nodeAt(w.coords[i - 1][0], w.coords[i - 1][1]);
			const b = nodeAt(w.coords[i][0], w.coords[i][1]);
			addEdge(a, b);
		}
	}
	return { nodes, adj };
}

/** The nearest point on any way edge to `p`, with the edge's two graph-node ids
 *  and the distances from the projection to each — the splice needed to route
 *  from mid-edge. null when the network is empty. */
function snapToEdge(
	p: Pt,
	geo: RoadGeometry,
	graph: WalkGraph,
): { point: Pt; nodeA: number; nodeB: number; toA: number; toB: number; distM: number } | null {
	let best: { point: Pt; nodeA: number; nodeB: number; toA: number; toB: number; distM: number } | null = null;
	const index = new Map<string, number>();
	for (let i = 0; i < graph.nodes.length; i++) index.set(nodeKey(graph.nodes[i].lat, graph.nodes[i].lon), i);
	for (const w of geo.ways) {
		for (let i = 1; i < w.coords.length; i++) {
			const a = { lat: w.coords[i - 1][0], lon: w.coords[i - 1][1] };
			const b = { lat: w.coords[i][0], lon: w.coords[i][1] };
			const proj = projectPointToSegment(p, a, b);
			if (best === null || proj.distM < best.distM) {
				const nodeA = index.get(nodeKey(a.lat, a.lon));
				const nodeB = index.get(nodeKey(b.lat, b.lon));
				if (nodeA === undefined || nodeB === undefined) continue;
				const projPt = { lat: proj.lat, lon: proj.lon };
				best = {
					point: projPt,
					nodeA,
					nodeB,
					toA: metersBetween(projPt, a),
					toB: metersBetween(projPt, b),
					distM: proj.distM,
				};
			}
		}
	}
	return best;
}

/** Binary min-heap keyed on distance, for Dijkstra. */
class MinHeap {
	private ids: number[] = [];
	private keys: number[] = [];
	get size(): number {
		return this.ids.length;
	}
	push(id: number, key: number): void {
		this.ids.push(id);
		this.keys.push(key);
		let i = this.ids.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (this.keys[parent] <= this.keys[i]) break;
			this.swap(i, parent);
			i = parent;
		}
	}
	pop(): { id: number; key: number } | null {
		if (this.ids.length === 0) return null;
		const top = { id: this.ids[0], key: this.keys[0] };
		const lastId = this.ids.pop();
		const lastKey = this.keys.pop();
		if (this.ids.length > 0 && lastId !== undefined && lastKey !== undefined) {
			this.ids[0] = lastId;
			this.keys[0] = lastKey;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let smallest = i;
				if (l < this.ids.length && this.keys[l] < this.keys[smallest]) smallest = l;
				if (r < this.ids.length && this.keys[r] < this.keys[smallest]) smallest = r;
				if (smallest === i) break;
				this.swap(i, smallest);
				i = smallest;
			}
		}
		return top;
	}
	private swap(i: number, j: number): void {
		[this.ids[i], this.ids[j]] = [this.ids[j], this.ids[i]];
		[this.keys[i], this.keys[j]] = [this.keys[j], this.keys[i]];
	}
}

export interface RouteOptions {
	/** Give up when an endpoint is farther than this (m) from every way — there is
	 *  no street to route on there (case 3: trust GPS instead). */
	snapRadiusM: number;
	/** Abandon the search past this route length (m) — a longer "shortest" path is
	 *  a dishonest detour for a walk-leg gap, not a route. */
	maxRouteM: number;
}

export const DEFAULT_ROUTE_OPTIONS: RouteOptions = {
	snapRadiusM: 35,
	maxRouteM: 1200,
};

/**
 * Shortest walkable path from `a` to `b`: [snapped-a, ...graph nodes..., snapped-b].
 * Null when either endpoint has no way within `snapRadiusM`, the network is
 * disconnected between them, or the route would exceed `maxRouteM` — every null
 * is an honest "there is no street path here", and the caller falls back to
 * trusting the GPS.
 */
export function routeOnWalkable(a: Pt, b: Pt, geo: RoadGeometry, opts: Partial<RouteOptions> = {}): Pt[] | null {
	const { snapRadiusM, maxRouteM } = { ...DEFAULT_ROUTE_OPTIONS, ...opts };
	if (geo.ways.length === 0) return null;

	const graph = buildWalkGraph(geo);
	const from = snapToEdge(a, geo, graph);
	const to = snapToEdge(b, geo, graph);
	if (!from || !to || from.distM > snapRadiusM || to.distM > snapRadiusM) return null;

	// Same-edge shortcut: both points project onto the same edge → the route is
	// straight along that edge.
	if ((from.nodeA === to.nodeA && from.nodeB === to.nodeB) || (from.nodeA === to.nodeB && from.nodeB === to.nodeA)) {
		return [from.point, to.point];
	}

	// Dijkstra from the two splice nodes of `from`, seeded with the along-edge
	// distances, until both splice nodes of `to` are settled (or the bound trips).
	const n = graph.nodes.length;
	const dist = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
	const prev = new Int32Array(n).fill(-1);
	const heap = new MinHeap();
	dist[from.nodeA] = from.toA;
	dist[from.nodeB] = from.toB;
	heap.push(from.nodeA, from.toA);
	heap.push(from.nodeB, from.toB);

	const settled = new Uint8Array(n);
	while (heap.size > 0) {
		const top = heap.pop();
		if (!top) break;
		const { id, key } = top;
		if (settled[id]) continue;
		settled[id] = 1;
		if (key > maxRouteM) return null; // best remaining already too long
		if (settled[to.nodeA] && settled[to.nodeB]) break;
		for (const e of graph.adj[id]) {
			const nd = key + e.distM;
			if (nd < dist[e.to]) {
				dist[e.to] = nd;
				prev[e.to] = id;
				heap.push(e.to, nd);
			}
		}
	}

	// Total cost arriving at `to`'s edge via either of its splice nodes.
	const viaA = dist[to.nodeA] + to.toA;
	const viaB = dist[to.nodeB] + to.toB;
	if (!Number.isFinite(viaA) && !Number.isFinite(viaB)) return null;
	const last = viaA <= viaB ? to.nodeA : to.nodeB;
	const total = Math.min(viaA, viaB);
	if (total > maxRouteM) return null;

	// Backtrack the node chain, then bracket with the snapped endpoints.
	const chain: number[] = [];
	for (let cur = last; cur !== -1; cur = prev[cur]) {
		chain.push(cur);
		if (chain.length > n) return null; // cycle guard (cannot happen; belt-and-braces)
	}
	chain.reverse();
	const path: Pt[] = [from.point];
	for (const id of chain) path.push(graph.nodes[id]);
	path.push(to.point);

	// Drop degenerate duplicates (snap point coinciding with a node).
	const out: Pt[] = [];
	for (const p of path) {
		const prevPt = out[out.length - 1];
		if (!prevPt || metersBetween(prevPt, p) > 0.5) out.push(p);
	}
	return out.length >= 2 ? out : null;
}

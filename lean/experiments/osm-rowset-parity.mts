/**
 * What will the re-bless actually move?
 *
 * Step 4 of `docs/proposals/2026-07-osm-into-lean.md` re-blesses the golden
 * corpus under the pushed row-set. This measures that move BEFORE touching the
 * corpus, so the re-bless is read against a prediction rather than accepted
 * because it is what came out.
 *
 * Each golden day's fixture carries both halves of the comparison already:
 * `inputs.phonetrack` is the track the row-set is built from, and
 * `inputs.osmTrace` is every OSM call the pipeline made that day keyed
 * `lat|lon|radius`, with MariaDB's answer as the value. So the harness loads
 * the row-set from the mirror, replays each captured kernel query through
 * `RowSetOsmAdapter`, and diffs against what the DB said.
 *
 * # What a difference means
 *
 * Three known sources, and the point of the run is to see only these:
 *
 *   1. **The sphere.** R = 6371000 here vs MariaDB's 6370986 — 2.2 ppm, so a
 *      point feature can only cross its bar within `radius × 2.198e-6`
 *      (sub-millimetre). Measured separately at zero occurrences across the
 *      corpus (`osm-sphere-delta.mts`); a point-side difference here would
 *      contradict that and is a finding, not a rounding.
 *   2. **The multi-vertex line metric.** MariaDB returns the nearest-VERTEX
 *      distance for a multi-vertex linestring; this port computes the true
 *      minimum over segments. One-directional: the port is never FARTHER, so
 *      the only possible change is a way coming IN. See
 *      `osm-line-metric-vs-mariadb.mts`.
 *   3. **Mirror drift.** The fixture was captured on some earlier day and the
 *      mirror has been refreshed since. This is NOT a port difference and it
 *      contaminates the measurement — an OSM edit shows up here exactly like a
 *      metric change would. Reported separately where it can be told apart
 *      (a feature present in one side and absent in the other, at a distance
 *      nowhere near its bar, is drift; a bar-adjacent flip is the metric).
 *
 * Run: scripts/prod-db.sh nix develop . --command npx tsx \
 *        lean/experiments/osm-rowset-parity.mts [day ...]
 * With no day arguments it walks the whole corpus.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initPool } from "../../src/db/pool.js";
import { DEFAULT_RADIUS_M } from "../../src/geo/osm.js";
import type { OsmAdapter } from "../../src/geo/osm-adapter.js";
import { RowSetOsmAdapter } from "../../src/geo/osm-adapter-rowset.js";
import { loadOsmRowSet } from "../../src/geo/osm-rowset.js";

const DAYS_DIR = path.join(process.cwd(), "tests", "golden", "days");

/** The five the row-set answers. Everything else in the trace is delegated. */
const KERNEL_METHODS = ["nearbyWays", "nearbyStations", "nearbyLandmarks", "linesAtPoint", "nearbyTransitStops"] as const;
type KernelMethod = (typeof KERNEL_METHODS)[number];

/** The inner adapter must never be reached: this harness only replays kernel
 *  queries, so a delegation is a bug in the gating, not a fallback. */
const NO_INNER: OsmAdapter = new Proxy({} as OsmAdapter, {
	get(_t, prop) {
		return () => {
			throw new Error(`osm-rowset-parity: delegated to the inner adapter (${String(prop)}) — it has none`);
		};
	},
});

interface Diff {
	date: string;
	method: KernelMethod;
	key: string;
	/** Identities the DB returned more times than the row-set did, `id×n`. */
	onlyDb: string[];
	/** Identities the row-set returned more times than the DB did, `id×n`. */
	onlyRowSet: string[];
	/** Largest |Δ| in metres over the entries both sides returned. */
	worstDeltaM: number;
	/** Same multiset, different order. */
	reordered: boolean;
	/** The radius the query ran at — sets the sphere's error budget. */
	radiusM: number;
}

/** MariaDB's sphere is 6370986, this port's is 6371000. A great-circle
 *  distance is `R · f(coordinates)`, so R is a pure scale factor and a point's
 *  distance can move by at most `d × 2.198e-6` — under a millimetre at every
 *  radius the pass list uses. Anything past this on a POINT-backed method is
 *  not the sphere and must be explained separately. */
const SPHERE_REL = (6_371_000 - 6_370_986) / 6_370_986;

/** The two methods answered purely out of `osm_points`. `nearbyWays` and
 *  `nearbyLandmarks` read both tables, so the line metric is in play for them
 *  and the sphere bound does not apply. */
const POINT_BACKED = new Set<string>(["nearbyStations", "nearbyTransitStops"]);

/**
 * A feature's identity, as a MULTISET of distances per identity.
 *
 * The shaped output carries no osm_id, so `type/subtype/name` is the finest key
 * available — and it is genuinely ambiguous: a street is many way rows all
 * named "Harrow Road", and a bus stop's two sides share a name. Collapsing
 * those to one entry (say, keeping the nearest) makes a GAINED duplicate look
 * like a distance change instead of a membership change, which is the one thing
 * this harness exists to tell apart. So the count is kept and compared.
 */
function members(method: KernelMethod, value: unknown): Map<string, number[]> {
	const out = new Map<string, number[]>();
	const add = (id: string, d: number) => out.set(id, [...(out.get(id) ?? []), d]);
	if (method === "linesAtPoint") {
		// A Set of names — no duplicates possible, no distances carried.
		for (const name of value as string[]) add(name, 0);
		return out;
	}
	for (const f of value as Array<Record<string, unknown>>) {
		add([f.type ?? "", f.subtype ?? "", f.name ?? ""].join("/"), typeof f.distanceM === "number" ? f.distanceM : 0);
	}
	for (const ds of out.values()) ds.sort((a, b) => a - b);
	return out;
}

/** Identities `a` has more copies of than `b`, rendered `id×n`. */
function excess(a: Map<string, number[]>, b: Map<string, number[]>): string[] {
	const out: string[] = [];
	for (const [id, ds] of a) {
		const n = ds.length - (b.get(id)?.length ?? 0);
		if (n > 0) out.push(n === 1 ? id : `${id}×${n}`);
	}
	return out;
}

function orderOf(method: KernelMethod, value: unknown): string[] {
	if (method === "linesAtPoint") return [...(value as string[])];
	return (value as Array<Record<string, unknown>>).map((f) => [f.type ?? "", f.subtype ?? "", f.name ?? ""].join("/"));
}

async function main(): Promise<void> {
	// Only the DB half of the config: `loadConfig` also demands Fitbit creds and
	// a session secret, which `scripts/prod-db.sh` does not export and this
	// harness never touches.
	initPool({
		host: process.env.DB_HOST as string,
		port: Number(process.env.DB_PORT),
		user: process.env.DB_USER as string,
		password: process.env.DB_PASSWORD as string,
		database: process.env.DB_NAME as string,
	});

	const wanted = process.argv.slice(2);
	const files = readdirSync(DAYS_DIR)
		.filter((f) => f.endsWith(".json"))
		.filter((f) => wanted.length === 0 || wanted.some((w) => f.includes(w)))
		.sort();
	if (files.length === 0) throw new Error(`no golden days matched ${wanted.join(", ")}`);

	const diffs: Diff[] = [];
	let compared = 0;
	let uncovered = 0;

	for (const file of files) {
		const day = JSON.parse(readFileSync(path.join(DAYS_DIR, file), "utf8"));
		const date: string = day.meta.date;
		const pt = day.inputs.phonetrack;
		const track = [...(pt.today ?? []), ...(pt.morning ?? []), ...(pt.priorEvening ?? [])];
		if (track.length === 0) {
			console.log(`${date}: no fixes, skipped`);
			continue;
		}

		const t0 = Date.now();
		const rowSet = await loadOsmRowSet(track);
		const loadMs = Date.now() - t0;
		const adapter = new RowSetOsmAdapter(rowSet, NO_INNER);

		let dayDiffs = 0;
		let dayQueries = 0;
		for (const method of KERNEL_METHODS) {
			const section = day.inputs.osmTrace?.[method] as Record<string, unknown> | undefined;
			if (!section) continue;
			for (const [key, dbValue] of Object.entries(section)) {
				const [latS, lonS, radS] = key.split("|");
				const lat = Number(latS);
				const lon = Number(lonS);
				const radius = radS === "" ? DEFAULT_RADIUS_M[method] : Number(radS);
				dayQueries++;
				compared++;

				let mine: unknown;
				try {
					mine = method === "linesAtPoint" ? [...(await adapter.linesAtPoint(lat, lon, radius))] : await adapter[method](lat, lon, radius);
				} catch (e) {
					// An uncovered query is a buffer-sizing failure, reported as
					// itself rather than folded into the parity count — the two
					// have different fixes.
					uncovered++;
					console.log(`  UNCOVERED ${date} ${method} ${key}: ${(e as Error).message.split(" — ")[0]}`);
					continue;
				}

				const a = members(method, dbValue);
				const b = members(method, mine);
				const onlyDb = excess(a, b);
				const onlyRowSet = excess(b, a);
				// Distances are compared only where the counts agree — otherwise
				// there is no honest pairing, and the membership change is the
				// finding anyway.
				let worst = 0;
				for (const [k, da] of a) {
					const db2 = b.get(k);
					if (db2 === undefined || db2.length !== da.length) continue;
					for (let i = 0; i < da.length; i++) worst = Math.max(worst, Math.abs(da[i] - db2[i]));
				}
				const oa = orderOf(method, dbValue);
				const ob = orderOf(method, mine);
				const reordered =
					onlyDb.length === 0 && onlyRowSet.length === 0 && oa.length === ob.length && oa.join("|") !== ob.join("|");

				if (onlyDb.length > 0 || onlyRowSet.length > 0 || worst > 1e-9 || reordered) {
					diffs.push({ date, method, key, onlyDb, onlyRowSet, worstDeltaM: worst, reordered, radiusM: radius });
					dayDiffs++;
				}
			}
		}
		const pts = rowSet.points.length;
		const lns = rowSet.lines.length;
		console.log(
			`${date}: ${dayQueries} queries, ${dayDiffs} differ — row-set ${pts} points / ${lns} lines, loaded in ${(loadMs / 1000).toFixed(1)}s`,
		);
	}

	console.log(`\n=== ${compared} kernel queries replayed, ${diffs.length} differ, ${uncovered} uncovered ===`);
	if (uncovered > 0) console.log("UNCOVERED > 0 — the buffer is short. Fix that before reading the parity numbers.");

	const byMethod = new Map<string, Diff[]>();
	for (const d of diffs) byMethod.set(d.method, [...(byMethod.get(d.method) ?? []), d]);
	for (const [method, ds] of byMethod) {
		const memberChanges = ds.filter((d) => d.onlyDb.length > 0 || d.onlyRowSet.length > 0);
		const inOnly = memberChanges.filter((d) => d.onlyDb.length === 0);
		const outOnly = memberChanges.filter((d) => d.onlyRowSet.length === 0);
		console.log(
			`\n${method}: ${ds.length} differ — ${memberChanges.length} change membership ` +
				`(${inOnly.length} gain only, ${outOnly.length} lose only, ${memberChanges.length - inOnly.length - outOnly.length} both), ` +
				`${ds.filter((d) => d.reordered).length} reorder only, ` +
				`worst distance delta ${Math.max(0, ...ds.map((d) => d.worstDeltaM)).toFixed(4)} m`,
		);
		for (const d of ds.slice(0, 8)) {
			const bits = [
				d.onlyDb.length > 0 ? `-[${d.onlyDb.join(", ")}]` : "",
				d.onlyRowSet.length > 0 ? `+[${d.onlyRowSet.join(", ")}]` : "",
				d.worstDeltaM > 1e-9 ? `Δ${d.worstDeltaM.toFixed(4)}m` : "",
				d.reordered ? "reordered" : "",
			].filter(Boolean);
			console.log(`  ${d.date} ${d.key} ${bits.join(" ")}`);
		}
		if (ds.length > 8) console.log(`  … and ${ds.length - 8} more`);
	}

	// Prediction 1: a point-backed method can only move by the sphere, which is
	// sub-millimetre. Anything larger is a different cause wearing the same shape.
	const sphereAnomalies = diffs.filter(
		(d) => POINT_BACKED.has(d.method) && (d.worstDeltaM > d.radiusM * SPHERE_REL * 2 || d.onlyDb.length > 0 || d.onlyRowSet.length > 0),
	);
	console.log(`\nprediction 1 — a POINT-backed method moves only by the sphere: ${sphereAnomalies.length} anomal(ies)`);
	for (const d of sphereAnomalies) {
		console.log(
			`  ${d.date} ${d.method} ${d.key} Δ${d.worstDeltaM.toFixed(4)}m (budget ${(d.radiusM * SPHERE_REL).toFixed(6)}m)` +
				`${d.onlyDb.length > 0 ? ` -[${d.onlyDb.join(", ")}]` : ""}${d.onlyRowSet.length > 0 ? ` +[${d.onlyRowSet.join(", ")}]` : ""}`,
		);
	}

	// Prediction 2: the line metric is one-directional — the true minimum over
	// segments is never GREATER than the distance to the nearest vertex, so a
	// line-backed method may gain features but never lose them.
	const lineBacked = new Set(["nearbyWays", "nearbyLandmarks", "linesAtPoint"]);
	const violations = diffs.filter((d) => d.onlyDb.length > 0 && lineBacked.has(d.method));
	console.log(
		`\nprediction 2 — a line-backed method may only GAIN features: ${violations.length} violation(s)` +
			(violations.length > 0 ? " ← READ THESE, the one-directional argument does not cover them" : ""),
	);
	for (const d of violations) console.log(`  ${d.date} ${d.method} ${d.key} lost [${d.onlyDb.join(", ")}]`);

	// Everything, so a follow-up question never costs another 25-minute replay.
	const dump = path.join(process.cwd(), "lean", "experiments", "osm-rowset-parity.json");
	writeFileSync(dump, JSON.stringify(diffs, null, "\t"));
	console.log(`\nfull diff written to ${dump}`);

	process.exit(0);
}

await main();

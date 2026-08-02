/**
 * How far apart are the two OSM oracles, and does the gap reach a LABEL?
 *
 * Task #412. The golden corpus replays `RowSetOsmAdapter` (the kernel, computed
 * from pushed rows); production serves `DbOsmAdapter` (MariaDB). One day proved
 * they are not equivalent: same coordinate, same code, `nearbyLandmarks` came
 * back 35 features from both sides but in a different ORDER, with one town-hall
 * polygon at 10.81 m from the kernel and 25.39 m from the DB — and `bestPlace`
 * then took a different branch under each. This sweeps the whole corpus for
 * that shape.
 *
 * # Why this is not `osm-rowset-parity.mts`
 *
 * That harness answers a different question and pays a different price. It
 * rebuilds the row-set from the LIVE mirror (`loadOsmRowSet`), so it needs
 * `scripts/prod-db.sh`, takes ~25 minutes, and mixes mirror drift into every
 * number — a feature OSM edited since the capture reads exactly like a metric
 * change. It was the right tool for "what will the re-bless move", asked before
 * the corpus carried row-sets at all.
 *
 * This one reads `inputs.osmRowSet` straight out of the fixture. That is the
 * exact row-set the gate replays, frozen at capture time alongside the trace it
 * is being compared against, so the two halves are contemporaneous by
 * construction and drift cannot contaminate the result. No DB, no network,
 * fully deterministic, seconds per day.
 *
 * # What it measures
 *
 * 1. **Kernel parity**, per method: membership, ordering, worst distance delta.
 *    Both oracles are asked every key the capture recorded.
 * 2. **Label divergence** — the part that matters. The day is replayed END TO
 *    END under each oracle and the resulting timeline place labels are diffed.
 *    A reordering that never reaches a label is noise; one that does is an
 *    output difference a reader would see.
 *
 * The replay is deliberately the whole pipeline rather than a direct
 * `bestPlace` probe. A synthetic probe was tried first and reported ZERO
 * differences on 07-15 — the day that provably diverges — because calling
 * `bestPlace` without `opts.stay` takes the `pickBestLandmark` branch, and both
 * oracles agree there. The divergence lives in `rankVenues`, which only runs
 * with a stay window: a reordering moves the top candidate, the top candidate
 * falls below `VENUE_RANK_FLOOR_NATS`, and the chain falls through to a
 * reverseGeocode the capture never made. Only a real replay produces the stays.
 *
 * # What it found (2026-08-02, 33 fixtures)
 *
 * 3066 kernel queries, 1119 differ — and **0 of 315 comparable timeline states
 * carry a different label**. The metric gap is large in metres (37.96 m worst on
 * `nearbyWays`, 17.67 m on `nearbyLandmarks`) and reaches a served label
 * nowhere. #412's premise that "wherever they disagree the corpus measures
 * something the user never sees" is measured, and the answer is: only on 07-15,
 * where the kernel arm falls through to an uncaptured `reverseGeocode`.
 *
 * The larger finding is on the other side. 12 days cannot be compared at all,
 * and 11 of them are the TRACE arm refusing, not the kernel's. The trace stores
 * the SHAPED output of each call, so it freezes the shaping code as well as the
 * data: every fixture captured at `ce8fa80` (2026-07-27) predates the
 * `stop_position` subtype added three commits later at `6b5bcf5`, so its stored
 * stations still carry the pre-#373 shaping. That is the whole of the
 * `nearbyStations` anomaly below — 48 membership changes and a 145.20 m "worst
 * delta" on a POINT-backed method, which the sphere argument says is impossible.
 * It is not a distance at all: `dedupeStationsByName` keeps a different NODE
 * under each shaping, and the two nodes are 145 m apart.
 *
 * So the row-set is not the staler oracle — it is the fresher one. It stores raw
 * rows and re-shapes with today's code; the trace cannot. Read a `nearbyStations`
 * difference here as capture-age, not as a porting error, and re-read it after
 * any re-capture.
 *
 * Run: nix develop . --command npx tsx lean/experiments/osm-oracle-parity.mts [day ...]
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type CapturedDay, inputsFromFixture, parseCapturedDay } from "../../src/cli/fixture-day.js";
import { DEFAULT_RADIUS_M } from "../../src/geo/osm.js";
import { FixtureOsmAdapter, isUncapturedLookup } from "../../src/geo/osm-adapter-fixture.js";
import { RowSetOsmAdapter } from "../../src/geo/osm-adapter-rowset.js";
import { computeVelocityFromInputs } from "../../src/geo/velocity.js";

const DAYS_DIR = path.join(process.cwd(), "tests", "golden", "days");

/** The five the row-set answers; everything else the adapter delegates. */
const KERNEL_METHODS = ["nearbyWays", "nearbyStations", "nearbyLandmarks", "linesAtPoint", "nearbyTransitStops"] as const;
type KernelMethod = (typeof KERNEL_METHODS)[number];

interface KernelDiff {
	date: string;
	method: KernelMethod;
	key: string;
	/** Identities the trace returned more times than the row-set did, `id×n`. */
	onlyTrace: string[];
	onlyRows: string[];
	/** Largest |Δ| in metres over the entries both sides returned. */
	worstDeltaM: number;
	reordered: boolean;
	radiusM: number;
}

interface LabelDiff {
	date: string;
	/** `HH:MM-HH:MM` of the state whose label moved, in UTC. */
	window: string;
	field: "place" | "wayName";
	rows: string;
	trace: string;
}

/** A whole-day replay outcome. A throw is a RESULT, not a harness failure —
 *  07-15's kernel arm falling through to an uncaptured reverseGeocode IS the
 *  divergence, and it must be reported rather than skipped. */
type Replay = { ok: true; labels: Array<{ window: string; place: string; wayName: string }> } | { ok: false; why: string };

async function replay(captured: CapturedDay, osmSource: "rows" | "trace"): Promise<Replay> {
	try {
		const { states } = await computeVelocityFromInputs(inputsFromFixture(captured, osmSource));
		const hhmm = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 16);
		return {
			ok: true,
			labels: states.map((s) => ({
				window: `${hhmm(s.startTs)}-${hhmm(s.endTs)}`,
				place: s.place ?? "",
				wayName: s.wayName ?? "",
			})),
		};
	} catch (e) {
		if (isUncapturedLookup(e)) return { ok: false, why: `uncaptured: ${(e as Error).message.split(" — ")[0]}` };
		return { ok: false, why: (e as Error).message.split("\n")[0].slice(0, 120) };
	}
}

/** A feature's identity as a multiset of distances — see `osm-rowset-parity.mts`
 *  for why the count is kept rather than collapsed. */
function members(method: KernelMethod, value: unknown): Map<string, number[]> {
	const out = new Map<string, number[]>();
	const add = (id: string, d: number) => out.set(id, [...(out.get(id) ?? []), d]);
	if (method === "linesAtPoint") {
		for (const name of value as string[]) add(name, 0);
		return out;
	}
	for (const f of value as Array<Record<string, unknown>>) {
		add([f.type ?? "", f.subtype ?? "", f.name ?? ""].join("/"), typeof f.distanceM === "number" ? f.distanceM : 0);
	}
	for (const ds of out.values()) ds.sort((a, b) => a - b);
	return out;
}

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
	const wanted = process.argv.slice(2);
	const files = readdirSync(DAYS_DIR)
		.filter((f) => f.endsWith(".json"))
		.filter((f) => wanted.length === 0 || wanted.some((w) => f.includes(w)))
		.sort();
	if (files.length === 0) throw new Error(`no golden days matched ${wanted.join(", ")}`);

	const kernelDiffs: KernelDiff[] = [];
	const labelDiffs: LabelDiff[] = [];
	const refusals: Array<{ date: string; rows: string; trace: string }> = [];
	let compared = 0;
	let uncovered = 0;
	let labelsCompared = 0;
	let noRowSet = 0;

	for (const file of files) {
		const captured = parseCapturedDay(readFileSync(path.join(DAYS_DIR, file), "utf8"));
		const date = captured.meta.date;
		const { osmTrace, osmRowSet } = captured.inputs;
		if (osmRowSet === undefined) {
			noRowSet++;
			console.log(`${date}: no osmRowSet in the fixture, skipped`);
			continue;
		}
		const trace = new FixtureOsmAdapter(osmTrace);
		const rows = new RowSetOsmAdapter(osmRowSet, trace);

		let dayKernel = 0;
		let dayQueries = 0;
		for (const method of KERNEL_METHODS) {
			const section = osmTrace[method] as Record<string, unknown> | undefined;
			if (!section) continue;
			for (const [key, traceValue] of Object.entries(section)) {
				const [latS, lonS, radS] = key.split("|");
				const lat = Number(latS);
				const lon = Number(lonS);
				const radius = radS === "" ? DEFAULT_RADIUS_M[method] : Number(radS);
				dayQueries++;
				compared++;

				let mine: unknown;
				try {
					mine = method === "linesAtPoint" ? [...(await rows.linesAtPoint(lat, lon, radius))] : await rows[method](lat, lon, radius);
				} catch (e) {
					uncovered++;
					console.log(`  UNCOVERED ${date} ${method} ${key}: ${(e as Error).message.split(" — ")[0]}`);
					continue;
				}

				const a = members(method, traceValue);
				const b = members(method, mine);
				const onlyTrace = excess(a, b);
				const onlyRows = excess(b, a);
				let worst = 0;
				for (const [k, da] of a) {
					const db = b.get(k);
					if (db === undefined || db.length !== da.length) continue;
					for (let i = 0; i < da.length; i++) worst = Math.max(worst, Math.abs(da[i] - db[i]));
				}
				const oa = orderOf(method, traceValue);
				const ob = orderOf(method, mine);
				const reordered = onlyTrace.length === 0 && onlyRows.length === 0 && oa.length === ob.length && oa.join("|") !== ob.join("|");

				if (onlyTrace.length > 0 || onlyRows.length > 0 || worst > 1e-9 || reordered) {
					kernelDiffs.push({ date, method, key, onlyTrace, onlyRows, worstDeltaM: worst, reordered, radiusM: radius });
					dayKernel++;
				}
			}
		}

		// The label question: replay the whole day under each oracle.
		const [rRows, rTrace] = [await replay(captured, "rows"), await replay(captured, "trace")];
		let dayLabels = 0;
		let labelNote: string;
		if (!rRows.ok || !rTrace.ok) {
			// One arm refusing IS a divergence, and the loudest kind — the day
			// has no comparable output at all under that oracle.
			refusals.push({ date, rows: rRows.ok ? "ok" : rRows.why, trace: rTrace.ok ? "ok" : rTrace.why });
			labelNote = `REFUSED (rows: ${rRows.ok ? "ok" : "threw"}, trace: ${rTrace.ok ? "ok" : "threw"})`;
		} else {
			// States are compared positionally. A label change that also moves a
			// boundary shows up as a length mismatch, which is reported whole
			// rather than aligned — an alignment heuristic would invent pairings.
			if (rRows.labels.length !== rTrace.labels.length) {
				labelDiffs.push({
					date,
					window: "(whole day)",
					field: "place",
					rows: `${rRows.labels.length} states`,
					trace: `${rTrace.labels.length} states`,
				});
				dayLabels++;
			} else {
				for (let i = 0; i < rRows.labels.length; i++) {
					const a = rRows.labels[i];
					const b = rTrace.labels[i];
					for (const field of ["place", "wayName"] as const) {
						if (a[field] !== b[field]) {
							labelDiffs.push({ date, window: a.window, field, rows: a[field] || "(none)", trace: b[field] || "(none)" });
							dayLabels++;
						}
					}
				}
			}
			labelsCompared += rRows.labels.length;
			labelNote = `${dayLabels}/${rRows.labels.length} labels differ`;
		}

		console.log(`${date}: ${dayQueries} kernel queries, ${dayKernel} differ — ${labelNote}`);
	}

	console.log(`\n=== ${compared} kernel queries replayed, ${kernelDiffs.length} differ, ${uncovered} uncovered, ${noRowSet} day(s) without a row-set ===`);

	const byMethod = new Map<string, KernelDiff[]>();
	for (const d of kernelDiffs) byMethod.set(d.method, [...(byMethod.get(d.method) ?? []), d]);
	for (const [method, ds] of byMethod) {
		const memberChanges = ds.filter((d) => d.onlyTrace.length > 0 || d.onlyRows.length > 0);
		console.log(
			`${method}: ${ds.length} differ — ${memberChanges.length} change membership, ` +
				`${ds.filter((d) => d.reordered).length} reorder only, ` +
				`worst distance delta ${Math.max(0, ...ds.map((d) => d.worstDeltaM)).toFixed(2)} m`,
		);
	}

	console.log(`\n=== ${labelsCompared} timeline states compared, ${labelDiffs.length} carry a DIFFERENT LABEL ===`);
	for (const d of labelDiffs) console.log(`  ${d.date} ${d.window} ${d.field}\n      rows : ${d.rows}\n      trace: ${d.trace}`);

	console.log(`\n=== ${refusals.length} day(s) where an oracle refused the replay outright ===`);
	for (const r of refusals) console.log(`  ${r.date}\n      rows : ${r.rows}\n      trace: ${r.trace}`);

	const dump = path.join(process.cwd(), "lean", "experiments", "osm-oracle-parity.json");
	writeFileSync(dump, JSON.stringify({ kernelDiffs, labelDiffs, refusals }, null, "\t"));
	console.log(`\nfull diff written to ${dump}`);
}

await main();

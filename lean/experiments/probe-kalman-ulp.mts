/**
 * Is a large per-value ULP gap in the Kalman filter still the libm band? (#1020)
 *
 * `compare-kalman.mts` reports a per-day tally like `lon 4/924 (≤19ulp)`. Its
 * exit code judges ROW COUNTS, because the documented failure mode is "the arms
 * disagreed about which fixes are real". That leaves a question it does not
 * answer: 2026-07-14 shows ≤19 ULP on `lon` and ≤4 on `speed`, where every other
 * day in the corpus is ≤2. Ten times the next worst is either the same
 * phenomenon amplified by the recursion, or a different one wearing its clothes.
 *
 * # The measurement
 *
 * The libm hypothesis says the ONLY thing that differs between the arms is the
 * last bit of a transcendental — `Math.cos` against Lean's `Float.cos`. So
 * compute the hypothesis's own UPPER BOUND: run the TypeScript filter against
 * ITSELF with `Math.cos` displaced by exactly one ULP, and see how far the
 * output moves.
 *
 * That is deliberately STRONGER than reality. A real libm disagreement hits
 * ~7.6% of latitudes and goes in either direction; this perturbs every call, in
 * one direction. So the number it produces is a ceiling on what a 1-ULP `cos`
 * disagreement can do to this day:
 *
 *   * ceiling >= 19 → the libm band explains 07-14. Nothing to chase.
 *   * ceiling <  19 → it does not, and the gap is a real second finding.
 *
 * Both arms here are the SAME TypeScript. The Lean arm is not involved, so this
 * cannot be confounded by anything else the two implementations disagree about
 * — which is the point: it isolates `cos`.
 *
 * # It also prints WHERE
 *
 * A max hides its own shape. Four scattered singletons mean the recursion
 * re-converges after each disturbance; four consecutive rows with a growing
 * magnitude mean it amplifies. Those are different stories about the filter and
 * the tally cannot tell them apart.
 *
 * ⚠ Prints row indices, timestamps and ULP distances ONLY, never a coordinate.
 * The fixtures are real tracks (`tests/golden/` is gitignored for that reason).
 *
 * Run: pnpm exec tsx lean/experiments/probe-kalman-ulp.mts [YYYY-MM-DD …]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filterGpsTrack } from "../../src/geo/kalman.js";
import { floatFromBits, floatToBits } from "../../src/lean/float-bits.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const leanBin = path.join(here, "..", ".lake", "build", "bin", "verified_cli");
const dir = path.join(repo, "tests", "golden", "days");

const want = process.argv.slice(2);
const files = readdirSync(dir)
	.filter((f) => f.endsWith(".json"))
	.filter((f) => want.length === 0 || want.some((d) => f.includes(d)))
	.sort();
if (files.length === 0) {
	console.error(`no golden day fixtures${want.length ? ` matching ${want.join(", ")}` : ""} in ${dir}`);
	process.exit(1);
}

/** ULP distance between two doubles, via their bit patterns. */
function ulp(a: number, b: number): number {
	if (a === b) return 0;
	return Number(
		BigInt(String(floatToBits(a))) > BigInt(String(floatToBits(b)))
			? BigInt(String(floatToBits(a))) - BigInt(String(floatToBits(b)))
			: BigInt(String(floatToBits(b))) - BigInt(String(floatToBits(a))),
	);
}

/** `x` displaced by one ULP, up (`dir > 0`) or down — a last-bit libm disagreement. */
function nudge(x: number, dir: number): number {
	if (Number.isNaN(x) || x === 0 || dir === 0) return x;
	const buf = new DataView(new ArrayBuffer(8));
	buf.setFloat64(0, x);
	const bits = buf.getBigUint64(0);
	// x is a cosine, so |x| <= 1; the sign bit decides which way "up" runs in the
	// integer encoding. Zero and NaN are left alone rather than special-cased into
	// something clever: neither occurs for cos of a real latitude.
	const up = dir > 0 === x > 0;
	buf.setBigUint64(0, up ? bits + 1n : bits - 1n);
	return buf.getFloat64(0);
}

/**
 * A seeded LCG. Seeded rather than `Math.random` so a surprising sample can be
 * re-run: an adjudication nobody can reproduce is an anecdote.
 */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

/**
 * How often two libms actually disagree on `cos`: 65 of 860 real latitudes,
 * measured in `Verified/Geo/Kalman.lean`'s header. Perturbing EVERY call is not
 * the hypothesis — the hypothesis is that a minority of calls differ, in either
 * direction, and the recursion carries it.
 */
const DISAGREE_RATE = 65 / 860;

const FIELDS = ["lat", "lon", "speed_kmh", "bearing"] as const;

function read(file: string) {
	const fixture = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
	const pt = fixture.inputs.phonetrack;
	// The same widest-real-track selection compare-kalman.mts makes, so the two
	// tools are talking about the same rows.
	return [...(pt.priorEvening ?? []), ...(pt.morning ?? []), ...(pt.today ?? [])]
		.sort((a: any, b: any) => a.ts - b.ts)
		.filter((p: any) => p.accuracy === null || p.accuracy <= 200)
		.map((p: any) => ({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy ?? null }));
}

for (const file of files) {
	const points = read(file);

	const base = filterGpsTrack(points);

	// The ablation, SAMPLED. Displacing `Math.cos` reaches every call site the
	// filter has — metersToDegreesLon, the implied-distance guard, the observed
	// and state speed conversions — which is what a differing libm would do.
	//
	// ⚠ SAMPLED, and not one uniform shift, because a uniform shift is not a
	// bound. Displacing every call by +1 ULP moved `lon` by 11 ULP on 2026-07-02,
	// where the two arms themselves differ by 1 — and by only 1 ULP on 2026-07-14,
	// where they differ by 19. The response to a last-bit disagreement is wildly
	// day- and direction-dependent, so a single direction measures one point of a
	// distribution, and reporting it as a ceiling would be exactly the false
	// precision this is trying to settle.
	const SAMPLES = Number(process.env.PROBE_SAMPLES ?? 200);
	const ceiling: Record<string, number> = {};
	let rowCountMoved = 0;
	for (let s = 0; s < SAMPLES; s++) {
		const rnd = lcg(s + 1);
		const realCos = Math.cos;
		// Each CALL draws independently: two libms disagree per-input, and the
		// filter calls `cos` on many different latitudes down one day.
		Math.cos = (x: number) => {
			const r = realCos(x);
			return rnd() < DISAGREE_RATE ? nudge(r, rnd() < 0.5 ? -1 : 1) : r;
		};
		let shifted: ReturnType<typeof filterGpsTrack>;
		try {
			shifted = filterGpsTrack(points);
		} finally {
			Math.cos = realCos;
		}
		if (shifted.length !== base.length) {
			rowCountMoved += 1;
			continue;
		}
		for (let i = 0; i < base.length; i++) {
			for (const f of FIELDS) {
				const d = ulp(base[i][f] as number, shifted[i][f] as number);
				if (d > (ceiling[f] ?? 0)) ceiling[f] = d;
			}
		}
	}

	const tally =
		FIELDS.filter((f) => ceiling[f] !== undefined)
			.map((f) => `${f} ≤${ceiling[f]}ulp`)
			.join(" ") || "no movement at all";
	console.log(`${file}  out=${base.length}  cos band over ${SAMPLES} samples: ${tally}`);
	if (rowCountMoved > 0) {
		console.log(`    ⚠ ${rowCountMoved}/${SAMPLES} samples CHANGED THE ROW COUNT — a last-bit cos can flip an accept/reject on this day`);
	}

	// ⚠ THE SAME DIVERGENCE IN ABSOLUTE UNITS, which is the half the tally cannot
	// express. A ULP is a RELATIVE unit — it is the gap between adjacent doubles
	// AT THAT MAGNITUDE — so the same physical error counts as more ULP the closer
	// the value sits to zero. These are London tracks and they cross longitude 0,
	// where the exponent collapses and a ULP shrinks by orders of magnitude. So
	// "19 ULP" and "1 ULP" may be the same error measured on two different rulers,
	// and only the absolute number can say.
	const run = spawnSync(
		leanBin,
		["kalman"],
		{
			input: JSON.stringify({
				pts: points.map((p) => [p.ts, floatToBits(p.lat), floatToBits(p.lon), p.accuracy === null ? null : floatToBits(p.accuracy)]),
			}),
			encoding: "utf8",
			maxBuffer: 1 << 28,
		},
	);
	if (run.status !== 0) {
		console.log(`    (lean arm unavailable: status ${run.status}) — ceiling above still stands`);
		continue;
	}
	const lean = JSON.parse(run.stdout).pts as Array<[number, string, string, string, string]>;
	if (lean.length !== base.length) {
		console.log(`    lean kept ${lean.length} rows, ts kept ${base.length} — that is the row-count fault, not a ULP question`);
		continue;
	}
	// Degrees of longitude to metres at London's latitude. One constant, used only
	// to put a number in a unit a person can judge; nothing downstream reads it.
	const M_PER_DEG_LON = 111320 * Math.cos((51.5 * Math.PI) / 180);
	for (const [k, f] of [
		[1, "lat"],
		[2, "lon"],
		[3, "speed_kmh"],
	] as const) {
		let worstUlp = 0;
		let worstAbs = 0;
		let worstRow = -1;
		let nRows = 0;
		for (let i = 0; i < base.length; i++) {
			const a = base[i][f] as number;
			const b = floatFromBits(String(lean[i][k]));
			if (a === b) continue;
			nRows += 1;
			const d = ulp(a, b);
			if (d > worstUlp) {
				worstUlp = d;
				worstAbs = Math.abs(a - b);
				worstRow = i;
			}
		}
		if (nRows === 0) continue;
		const metres = f === "lat" ? worstAbs * 111320 : f === "lon" ? worstAbs * M_PER_DEG_LON : Number.NaN;
		const asMetres = Number.isNaN(metres) ? "" : `  = ${metres.toExponential(2)} m`;
		console.log(
			`    ts↔lean ${f}: ${nRows} row(s), worst ${worstUlp} ulp at row ${worstRow}` +
				`  abs ${worstAbs.toExponential(2)}${f === "speed_kmh" ? " km/h" : "°"}${asMetres}`,
		);
	}

}

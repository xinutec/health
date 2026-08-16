/**
 * What "the two arms agree" MEANS for a Lean day — one definition, two callers.
 *
 * `compare-day.ts` (the `day-gate`) and `lean-day.ts` (the `LEAN_DAY` tenant)
 * both ask whether the Lean chain reproduced the TS one, and before this module
 * they answered it with two different rules. The tenant's excuse list carried
 * `snappedPath`, which the gate deliberately does NOT excuse — `railSnap` reads
 * `railRouteCache` and the payload supplies it, so that field has to match. The
 * widening was inert while the gate was green, and it was exactly the shape of a
 * regression that the tenant would report as EXACT and the gate as DIVERGED.
 *
 * A shadow that disagrees with its gate about equality is worse than no shadow,
 * so the rule lives here and neither caller states one of its own.
 *
 * The excuses below are MEASURED, and each records what measured it. Widening one
 * is how a gate stops being a gate; read the provenance before touching it.
 */

import { polylineDeviationM } from "../geo/leg-compare.js";
import { floatFromBits } from "./float-bits.js";

/** Fields no `Env` supplies, so the fold cannot produce them and a difference
 *  here is structural rather than a divergence.
 *
 *  `PassFold.Env.walkEnv` / `.roadEnv` are declared SHELLS — the street-network
 *  reads and every solver leaf are stubbed (`fun _ _ _ => none`), because the
 *  matchers are the 4.31 MiB/day the wire measurement deliberately left
 *  shell-side (`lean/experiments/passfold-env-size.mts`). The passes still RUN;
 *  handed no matcher they write nothing.
 *
 *  Reported, never hidden: a day whose only differences are these gets its own
 *  verdict and still prints them. Anything outside this set is a divergence.
 *
 *  `snappedPath` is deliberately NOT here: `railSnap` reads `railRouteCache`,
 *  which the payload does supply, so that one has to match. Nor are the fields
 *  `reenrich` used to leave unwritten — it is fed now (`Verified.Geo.Enrich`),
 *  and a difference in `refinedMode` / `wayName` / `refinedReason` /
 *  `roadCorridorFraction` is a real one again. */
export const SHELLED: ReadonlySet<string> = new Set(["walkMatchedPath", "walkSmoothedPath", "matchedPath"]);

/** Episode kinds that only a solver can produce. With `walkEnv` / `roadEnv`
 *  stubbed the Lean arm has no matched path, so the renderer falls back to raw
 *  chords — and the episode says so in `kind`, which is geometry PROVENANCE.
 *
 *  MEASURED on 2026-05-18 rather than assumed: all six differing episodes were
 *  `walking`, TS `matched` against Lean `raw`, with six `walkMatchedPath`
 *  differences on the segments beneath them. Nothing else differed. */
const SOLVER_KINDS = new Set(["matched", "smoothed"]);

/** Key-sorted JSON, because `JSON.stringify` is ORDER-SENSITIVE on objects and
 *  the two arms build `biometrics` field by field in their own orders. Comparing
 *  raw renderings reported all 15 segments as differing when every value was
 *  identical — a defect in the comparator that would have been read as a
 *  divergence in the fold. */
export function canon(v: unknown): string {
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

/** Where a caller may print the first differing VALUE for a field. The gate
 *  wires `DAY_DIFF_DUMP=1` to one; the tenant passes none, because a served
 *  request is not a place to dump 600 characters of geometry. */
/** `where` identifies the SEGMENT a difference landed on — bounds and mode, so
 *  a dump says which piece of the day diverged rather than only which array
 *  slot. Deliberately not `wayName`: the label is the one field that carries a
 *  real place name, and this string is printed. */
export type Sample = (label: string, index: number, a: unknown, b: unknown, where?: string) => void;

/** `<startTs>-<endTs> <mode>` for a segment-shaped record, when it has them. */
function segWhere(r: Record<string, unknown>): string | undefined {
	const { startTs, endTs, mode, refinedMode } = r;
	if (typeof startTs !== "number" || typeof endTs !== "number") return undefined;
	const m = typeof refinedMode === "string" && refinedMode !== "" ? refinedMode : mode;
	return `${startTs}-${endTs}${typeof m === "string" ? ` ${m}` : ""}`;
}

/** A wire path (`[[latBits, lonBits, tsBits], …]`) as coordinates, or `null`
 *  when the value is not one. */
function asPath(v: unknown): Array<{ lat: number; lon: number }> | null {
	if (!Array.isArray(v) || v.length === 0) return null;
	const out: Array<{ lat: number; lon: number }> = [];
	for (const p of v) {
		if (!Array.isArray(p) || typeof p[0] !== "string" || typeof p[1] !== "string") return null;
		out.push({ lat: floatFromBits(p[0]), lon: floatFromBits(p[1]) });
	}
	return out;
}

/**
 * Which of three things a shelled field is doing on one segment.
 *
 * ⚠ THE EXCUSAL HAS TO BE CONDITIONAL NOW, and it was not. `SHELLED` names the
 * three solver-geometry fields, and {@link classify} excused every difference in
 * them by NAME — which was right for exactly as long as the Lean arm could not
 * draw: `walkEnv`/`roadEnv` were stubs, so the only possible difference was
 * "TS drew, Lean did not", and that is the shell.
 *
 * The fold can draw now (#959: it answers its own OSM lookups in-process, and
 * `LEAN_DAY_HOST` ships it). An unconditional excusal therefore says
 * "shell-only" about geometry BOTH arms produced and nobody compared — a green
 * that means the gate stopped looking, which is the failure this whole gate
 * exists to prevent. The same defect, on the same day, lived in the serve path
 * as `graftShells` preferring TS unconditionally; that half was deleted in
 * #959 once it was measured taking nothing.
 *
 *   `shell`   TS drew, Lean did not — the declared absence, still excused
 *   `extra`   LEAN drew, TS did not — never a shell: nothing declares the fold
 *             INVENTING geometry, and #395 rejects a null deviation under either
 *             basis because there is no distance to bound
 *   `drawn`   both drew — a real comparison, reported with its deviation
 */
function shelledKind(a: unknown, b: unknown): "shell" | "extra" | "drawn" {
	const tsHas = a !== undefined && a !== null;
	const leanHas = b !== undefined && b !== null;
	if (tsHas && !leanHas) return "shell";
	if (leanHas && !tsHas) return "extra";
	return "drawn";
}

/** Field-by-field, so a divergence names the field rather than the segment. */
export function diffSegs(want: readonly unknown[], got: readonly unknown[], sample?: Sample): string[] {
	const out: string[] = [];
	if (want.length !== got.length) {
		out.push(`segment count: TS ${want.length}, Lean ${got.length}`);
	}
	const n = Math.min(want.length, got.length);
	const counts = new Map<string, number>();
	/** Worst polyline deviation seen per DRAWN field, in metres. */
	const worst = new Map<string, number>();
	for (let i = 0; i < n; i++) {
		const a = want[i] as Record<string, unknown>;
		const b = got[i] as Record<string, unknown>;
		for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
			if (canon(a[k]) === canon(b[k])) continue;
			// A shelled field is only shelled while the fold leaves it alone; see
			// `shelledKind`. The suffix is what carries that into `classify`,
			// which splits on the field NAME and so must be handed a different
			// name rather than a flag.
			let key = k;
			if (SHELLED.has(k)) {
				const kind = shelledKind(a[k], b[k]);
				if (kind === "drawn") {
					key = `${k} drawn`;
					const pa = asPath(a[k]);
					const pb = asPath(b[k]);
					if (pa !== null && pb !== null) {
						worst.set(key, Math.max(worst.get(key) ?? 0, polylineDeviationM(pa, pb)));
					}
				} else if (kind === "extra") {
					key = `${k} LEAN-ONLY`;
				}
			}
			counts.set(key, (counts.get(key) ?? 0) + 1);
			sample?.(key, i, a[k], b[k], segWhere(a));
		}
	}
	for (const [field, c] of [...counts].sort((x, y) => y[1] - x[1])) {
		const dev = worst.get(field);
		// Centimetres, because the class this measures is the 1e-7 degree
		// quantisation and metres would print every one of them as "0.00".
		const how = dev === undefined ? "" : `, worst ${(dev * 100).toFixed(2)} cm`;
		out.push(`${field}: ${c}/${n} segments differ${how}`);
	}
	return out;
}

type Ep = { kind: string; points: unknown[] } & Record<string, unknown>;

/** Whether an episode's geometry is the missing solver's absence: the TS arm
 *  drew it with a solver kind and the Lean arm fell back to raw chords. */
const isFallback = (a: Ep, b: Ep): boolean => SOLVER_KINDS.has(a.kind) && b.kind === "raw";

/** Episodes, compared with TWO excuses, both measured and neither wider.
 *
 *  1. A FALLBACK episode — TS solver-drawn, Lean raw. Its `kind` and `points`
 *     are the shell's absence. Every other field is still compared.
 *
 *  2. A CONNECTOR VERTEX INHERITED from one. A `tentative` episode bridges an
 *     unobserved gap by joining its neighbours' drawn ends, so when the
 *     neighbour was drawn by the missing matcher the joint moves with it.
 *     Excused only for the specific vertex that equals that neighbour's
 *     terminal vertex IN ITS OWN ARM — a connector whose interior or free end
 *     moved is still a divergence.
 *
 *     MEASURED before it was written: on all four days where this fires
 *     (2026-04-30, 06-15, 06-16, 07-17) the connector is two points, only the
 *     first differs, and in BOTH arms it equals the previous episode's last
 *     point, whose episode is a fallback.
 *
 *  Any other kind disagreement — `anchor` against `raw`, `tentative` against
 *  `matched` — is real: the arms then disagree about what KIND of thing
 *  happened, which no missing solver explains. */
export function diffEpisodes(
	want: readonly unknown[],
	got: readonly unknown[],
	sample?: Sample,
): { real: string[]; fallback: number } {
	const out: string[] = [];
	if (want.length !== got.length) out.push(`episodes count: TS ${want.length}, Lean ${got.length}`);
	const n = Math.min(want.length, got.length);
	const A = want as Ep[];
	const B = got as Ep[];
	const counts = new Map<string, number>();
	let fallback = 0;

	/** Drop the vertices a neighbouring fallback moved, per arm. */
	const trim = (eps: Ep[], i: number): unknown[] => {
		const pts = [...eps[i].points];
		const prev = eps[i - 1];
		const next = eps[i + 1];
		const inherited = (v: unknown, from: unknown): boolean => v !== undefined && canon(v) === canon(from);
		if (next !== undefined && isFallback(A[i + 1], B[i + 1]) && inherited(pts.at(-1), next.points[0])) pts.pop();
		if (prev !== undefined && isFallback(A[i - 1], B[i - 1]) && inherited(pts[0], prev.points.at(-1))) pts.shift();
		return pts;
	};

	for (let i = 0; i < n; i++) {
		const a = A[i];
		const b = B[i];
		const excused = isFallback(a, b);
		if (excused) fallback += 1;
		for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
			if (excused && (k === "kind" || k === "points")) continue;
			if (k === "points" && a.kind === "tentative" && b.kind === "tentative") {
				if (canon(trim(A, i)) !== canon(trim(B, i))) {
					counts.set(k, (counts.get(k) ?? 0) + 1);
					sample?.(`episodes.${k}`, i, trim(A, i), trim(B, i));
				}
				continue;
			}
			if (canon(a[k]) !== canon(b[k])) {
				counts.set(k, (counts.get(k) ?? 0) + 1);
				sample?.(`episodes.${k}`, i, a[k], b[k]);
			}
		}
	}
	for (const [field, c] of [...counts].sort((x, y) => y[1] - x[1])) {
		out.push(`episodes.${field}: ${c}/${n} differ`);
	}
	return { real: out, fallback };
}

/**
 * Split a day's difference lines into the ones a declared shell explains and the
 * ones nothing does.
 *
 * The field name is the text before the first colon, which is why an INTERIOR
 * boundary's lines must carry their prefix (`pre.walkMatchedPath: …`): before
 * the fold has run there is no matcher output to be missing, so a shelled field
 * differing THERE is a real divergence and the prefix is what keeps it one.
 */
export function classify(all: readonly string[], fallback: number): { real: string[]; shell: string[] } {
	const real = all.filter((d) => !SHELLED.has(d.split(":")[0]));
	const shell = [
		...all.filter((d) => SHELLED.has(d.split(":")[0])),
		...(fallback > 0 ? [`episodes drawn raw for want of a matcher: ${fallback}`] : []),
	];
	return { real, shell };
}

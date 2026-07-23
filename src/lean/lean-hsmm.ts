/**
 * Request-path staging of the verified HSMM decoder, behind `LEAN_HSMM`.
 *
 * The decode analogue of `lean-passes.ts` / `lean-match.ts` / `lean-rail.ts`.
 * The verified decoder (`pDecodeFast`, proved equal to the packed `pDecode`)
 * has run in the cron only as a log-only per-day comparison; this gives it the
 * same `off`/`shadow`/`on` staging and an accumulating, fleetwatch-readable
 * ledger the other tenants already have, so a run of clean live days is a
 * durable signal rather than a scroll of loose log lines.
 *
 *   off    (default) — no shadow, zero cost.
 *   shadow — decode both ways, compare, record. Production keeps serving the
 *            TS FLOAT decode.
 *   on     — NOT WIRED YET. Would serve the verified QUANTISED decode; held
 *            until the decision to ship the quant decode is made (see below).
 *            For now `on` runs the shadow like `shadow` and warns that it is
 *            not serving Lean, so setting it early is safe, not silently wrong.
 *
 * Two independent things the shadow measures — BOTH must hold before a flip is
 * safe, and they answer different questions:
 *   - **lean↔tsQuant EXACT**: the verified decode equals the TS trellis on the
 *     SAME integer tensors. This is the bridge/decoder being right.
 *   - **float↔quant 100%**: the quantised decode equals the FLOAT decode
 *     production currently ships. A day under 100% is a quantisation near-tie
 *     flip — the one thing the soak must surface, because on THAT day flipping
 *     would change a minute or two of the output.
 *
 * `on` is deliberately NOT tied to `verifiedCoreOverride` (unlike the rail
 * tenant): the settings-UI master switch must not imply an HSMM serving
 * behaviour that does not exist yet.
 */

import { buildHsmmModel, type HsmmInputs } from "../hmm/decode.js";
import { shadowHsmmDay } from "../hmm/lean-shadow-core.js";
import { leanRunScope } from "./run-scope.js";

export type LeanHsmmMode = "off" | "shadow" | "on";

export function leanHsmmMode(): LeanHsmmMode {
	const v = process.env.LEAN_HSMM;
	return v === "on" || v === "shadow" ? v : "off";
}

interface HsmmStats {
	/** Days the shadow ran. */
	days: number;
	/** lean↔tsQuant diverged — the verified decode disagreed with the TS
	 *  trellis on the same integer tensors (bridge/decoder wrong). */
	bridgeDiverged: number;
	/** float↔quant under 100% — the quantised decode differed from the float
	 *  decode production ships, so a flip WOULD change that day's output. */
	quantDrift: number;
	/** Shadow threw (export refusal, bridge crash) — decode run continued. */
	skipped: number;
}

interface HsmmDivergence {
	date: string;
	kind: "bridge" | "quant" | "skip";
	detail: string;
	scope: string;
}

const MAX_DIVERGENCES = 32;
const fresh = (): HsmmStats => ({ days: 0, bridgeDiverged: 0, quantDrift: 0, skipped: 0 });
let stats = fresh();
const divergences: HsmmDivergence[] = [];

export function resetLeanHsmmStats(): void {
	stats = fresh();
	divergences.length = 0;
}

/** Test seam: the accumulated verdict without touching the ledger output. */
export function leanHsmmStats(): Readonly<HsmmStats> {
	return stats;
}

function record(date: string, kind: HsmmDivergence["kind"], detail: string): void {
	if (divergences.length >= MAX_DIVERGENCES) return;
	divergences.push({ date, kind, detail, scope: leanRunScope() });
}

/**
 * Run the per-day HSMM shadow and record it into the ledger. Uses the fast live
 * A/B (`shadowHsmmDay` without the 55M-cell class-export referee — the golden
 * corpus gate covers that offline). Never throws: a shadow error is recorded
 * and the decode run continues, exactly as the log-only version did.
 */
export function shadowHsmmViaLean(inputs: HsmmInputs, leanBin: string, date: string): void {
	const mode = leanHsmmMode();
	if (mode === "off") return;
	stats.days += 1;
	try {
		const r = shadowHsmmDay(buildHsmmModel(inputs), leanBin);
		if (!r.exact) {
			stats.bridgeDiverged += 1;
			record(date, "bridge", r.verdict);
		}
		if (r.agreeMinutes !== r.totalMinutes) {
			stats.quantDrift += 1;
			record(date, "quant", `${r.agreeMinutes}/${r.totalMinutes}min scoreΔ${r.scoreDelta.toExponential(2)}`);
		}
		console.log(
			`lean-shadow ${date} ${r.verdict} ` +
				`float↔quant ${((100 * r.agreeMinutes) / r.totalMinutes).toFixed(2)}% scoreΔ ${r.scoreDelta.toExponential(2)} ` +
				`[${r.shape} quantise ${r.quantiseMs.toFixed(0)}ms ts ${r.tsMs.toFixed(0)}ms lean ${r.leanMs.toFixed(0)}ms]`,
		);
		if (mode === "on") {
			console.warn("[lean-hsmm] LEAN_HSMM=on requested but the on-path is not wired yet — serving TS.");
		}
	} catch (err) {
		stats.skipped += 1;
		record(date, "skip", err instanceof Error ? err.message : String(err));
		console.log(`lean-shadow ${date} SKIPPED: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Emit the accumulating HSMM decode ledger and reset. Mirrors
 * `logLeanRailLedger` / `logLeanPassLedger`. A run is EXACT only when every day
 * cleared BOTH the bridge (lean↔tsQuant) and the quantisation (float↔quant) —
 * the two conditions a safe flip needs — with nothing skipped.
 */
export function logLeanHsmmLedger(label: string): void {
	const mode = leanHsmmMode();
	if (mode === "off") return;
	const s = stats;
	const bad = s.bridgeDiverged + s.quantDrift + s.skipped;
	const verdict = bad === 0 ? "EXACT" : `${bad} DIVERGED`;
	const detail = bad === 0 ? "" : ` — bridge=${s.bridgeDiverged} quantDrift=${s.quantDrift} skip=${s.skipped}`;
	const legs =
		divergences.length === 0
			? ""
			: ` — ${divergences.map((d) => `[${d.scope}] ${d.date} ${d.kind}:${d.detail}`).join("; ")}`;
	console.log(`lean-hsmm[${mode}] ${label} ${s.days}d${s.days === 0 ? " (no days)" : ""}${detail} ${verdict}${legs}`);
	resetLeanHsmmStats();
}

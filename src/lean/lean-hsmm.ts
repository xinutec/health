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
 *   on     — SERVES the verified decode via `decodeHsmmViaLean`, falling back
 *            to TS on any bridge failure. **This is a WRITE path**: the only
 *            caller of `saveDecode` is `cli/decode-day.ts`, so under `on` it is
 *            the Lean decode that gets persisted to `decoded_days`.
 *
 * (Until 2026-08-01 this block said `on` was "NOT WIRED YET… runs the shadow
 * like `shadow` and warns that it is not serving Lean". That stopped being true
 * when `decodeServed` gained its `!== "on"` branch, and the comment was not
 * moved with it. It is recorded rather than quietly deleted because of what it
 * cost: the cron has run `LEAN_HSMM=on` in production, and a reader auditing
 * "is Lean writing to the database?" from this header would have concluded no.
 * A staleness that inverts a safety-relevant answer is worth a paragraph.)
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
 * This tenant was deliberately NOT tied to the settings-UI master override,
 * unlike the rail tenant, so that the switch could not imply an HSMM serving
 * behaviour that did not exist. The override itself is gone (#975) and the
 * distinction with it; the mode is the env flag alone.
 */

import { existsSync } from "node:fs";
import { buildHsmmModel, decodeHsmm, type HsmmInputs } from "../hmm/decode.js";
import { decodeHsmmViaLean, shadowHsmmDay } from "../hmm/lean-shadow-core.js";
import type { HmmSegment } from "../hmm/persist.js";
import { errorText } from "../util/error-text.js";
import type { LedgerVerdict } from "./ledger-verdict.js";
import { leanRunScope } from "./run-scope.js";

/**
 * `solo` — the verified decode alone (#975). No TS decode, no shadow, no
 * fallback.
 *
 * ⚠ This tenant is shaped differently from its siblings and `solo` has to undo
 * MORE here. The others take the TS arm as a thunk in one place; `decodeServed`
 * calls `decodeHsmm` DIRECTLY from three separate branches — wrong mode, absent
 * `LEAN_CLI`, and a thrown bridge — and `shadowLeanHsmm` runs the TS trellis a
 * second time as measurement. `solo` closes all four, or the TS decode stays
 * reachable and nothing can be deleted.
 */
export type LeanHsmmMode = "off" | "shadow" | "on" | "solo";

export function leanHsmmMode(): LeanHsmmMode {
	// Env-only, as with the sibling tenants.
	const v = process.env.LEAN_HSMM;
	return v === "on" || v === "shadow" || v === "solo" ? v : "off";
}

/**
 * Serve the day's segments through the decoder `LEAN_HSMM` selects — the flip
 * point that makes the verified Lean decode authoritative instead of shadow.
 *   off / shadow → the TS float decode (production behaviour unchanged; a
 *                  `shadow` run still A/Bs observationally alongside).
 *   on           → the VERIFIED Lean decode (`decodeHsmmViaLean`), with a TS
 *                  fallback on ANY bridge failure (LEAN_CLI missing, spawn or
 *                  parse error, degenerate/short path). A verified-core hiccup
 *                  must never crash or corrupt the served decode — the same
 *                  fail-safe the rail/passes/match tenants use. Each fallback is
 *                  warned so a silently-degrading serve path stays visible.
 */
export function decodeServed(inputs: HsmmInputs, date: string): HmmSegment[] {
	const mode = leanHsmmMode();
	// ⚠ BEFORE the `LEAN_CLI` check, deliberately. Under `solo` an absent binary
	// is not a reason to serve TS — there is no TS to serve — so it must reach
	// `decodeHsmmViaLean` and throw there rather than be caught by a guard whose
	// only remedy is the arm being deleted. Counted here because the shadow does
	// not run under `solo`, so this is the tenant's ONLY evidence it did anything
	// (#392: a ledger that cannot tell "never ran" from "ran clean" is useless).
	if (mode === "solo") {
		stats.days += 1;
		return decodeHsmmViaLean(inputs);
	}
	if (mode !== "on") return decodeHsmm(inputs);
	const leanBin = process.env.LEAN_CLI;
	if (leanBin === undefined || leanBin === "" || !existsSync(leanBin)) {
		console.warn(`[lean-hsmm] on but LEAN_CLI missing — serving TS decode for ${date}`);
		return decodeHsmm(inputs);
	}
	try {
		return decodeHsmmViaLean(inputs);
	} catch (err) {
		console.warn(`[lean-hsmm] on but bridge failed for ${date} (${errorText(err)}) — serving TS decode`);
		return decodeHsmm(inputs);
	}
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
export function shadowHsmmViaLean(inputs: HsmmInputs, date: string): void {
	const mode = leanHsmmMode();
	// ⚠ `solo` skips the shadow, and that is the POINT rather than an omission.
	// `shadowHsmmDay` runs the TS trellis to compare against — under `solo` that
	// would keep the very implementation this mode exists to delete alive and
	// executing on every day, buying nothing: there is no serving decision to
	// inform, because Lean is already the only arm. `decodeServed` counts the
	// day instead, so the ledger still distinguishes "never ran" from "ran".
	if (mode === "off" || mode === "solo") return;
	stats.days += 1;
	try {
		const r = shadowHsmmDay(buildHsmmModel(inputs));
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
	} catch (err) {
		stats.skipped += 1;
		record(date, "skip", errorText(err));
		console.log(`lean-shadow ${date} SKIPPED: ${errorText(err)}`);
	}
}

/**
 * Emit the accumulating HSMM decode ledger and reset. Mirrors
 * `logLeanRailLedger` / `logLeanPassLedger`. A run is EXACT only when every day
 * cleared BOTH the bridge (lean↔tsQuant) and the quantisation (float↔quant) —
 * the two conditions a safe flip needs — with nothing skipped.
 */
export function logLeanHsmmLedger(label: string): LedgerVerdict | null {
	const mode = leanHsmmMode();
	if (mode === "off") return null;
	const s = stats;
	const bad = s.bridgeDiverged + s.quantDrift + s.skipped;
	// Zero days is not a pass — see the note in lean-kalman.ts (#392). This tenant
	// reads NOT EXERCISED on the golden corpus by construction: the corpus replays
	// the 11 cached decodes in `tests/golden/decoded_days` instead of decoding, so
	// the decoder never runs. That determinism is deliberate (#233); it just means
	// golden cannot gate this tenant, and a green corpus never could.
	// ⚠ Under `solo`, `days` counts SERVED decodes rather than shadowed ones, and
	// `bad` is structurally zero because the shadow that would populate it never
	// ran. EXACT would therefore assert agreement between two arms of which only
	// one exists — the same vacuous green the other tenants guard against, and
	// worse here because this tenant's EXACT is documented as meaning "cleared
	// BOTH the bridge and the quantisation", neither of which was checked.
	const verdict =
		s.days === 0
			? "NOT EXERCISED"
			: mode === "solo"
				? `SOLO (no TS decode, no shadow; ${s.days} day(s) served)`
				: bad === 0
					? "EXACT"
					: `${bad} DIVERGED`;
	const detail = bad === 0 ? "" : ` — bridge=${s.bridgeDiverged} quantDrift=${s.quantDrift} skip=${s.skipped}`;
	const legs =
		divergences.length === 0
			? ""
			: ` — ${divergences.map((d) => `[${d.scope}] ${d.date} ${d.kind}:${d.detail}`).join("; ")}`;
	console.log(`lean-hsmm[${mode}] ${label} ${s.days}d${s.days === 0 ? " (no days)" : ""}${detail} ${verdict}${legs}`);
	// This tenant counts DAYS, not bridge calls — one shadow per decoded day —
	// so that is what `calls` carries. `skipped` is its `fails`: a day whose
	// shadow threw is a day the verified arm did not run, which is exactly the
	// swallowed-failure shape the gate is looking for. It is a SUBSET of `days`
	// rather than a separate tally, so the two must not be added together.
	const out: LedgerVerdict = {
		tenant: "hsmm",
		mode,
		calls: s.days,
		fails: s.skipped,
		// No per-item fingerprint: this tenant compares whole outputs, so a
		// divergence of its own cannot be recorded in the ceiling and always fails.
		unexplained: [],
		klass: s.days === 0 ? "not-exercised" : bad === 0 ? "exact" : "diverged",
	};
	resetLeanHsmmStats();
	return out;
}

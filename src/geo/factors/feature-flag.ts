/**
 * Feature flags for the factor-decomposed classifier path.
 *
 * Both flags are read once per call (cheap) so tests can flip them
 * via `vi.stubEnv` without restarting the process.
 *
 * **USE_FACTOR_SCORER=1** — switches `refineMode` from the legacy
 * cascade to the factor-scorer path (per-segment scoring via
 * speed-emission + osm-distance + mode-coherence + mode-prior).
 * In production: set in the pod env to enable; absent or any other
 * value keeps the legacy cascade.
 *
 * **USE_BIOMETRIC_FACTOR=1** — gated *under* USE_FACTOR_SCORER:
 * passes per-segment biometric context (HR / cadence / per-user
 * mode stats) through to the factor scorer so the candidate
 * generator can filter biologically-implausible candidates (the
 * candidate-filter form of the legacy `applyBiometricSignature`
 * vetos). Enabling this also implies the migrated path is being
 * used for the biometric-corrector's work — the cascade's separate
 * `applyBiometricSignature` pass becomes a no-op when this flag is
 * on, avoiding double-correction.
 *
 * The three relevant combinations:
 *   - both unset:              legacy cascade (current production)
 *   - SCORER=1 only:           factor scorer for refineMode; biometric
 *                              cascade still runs as a separate pass
 *   - SCORER=1, BIOMETRIC=1:   factor scorer with biometric ctx;
 *                              applyBiometricSignature pass skipped
 *
 * Both flags will be removed once the factor path has been running
 * in production for at least one calibration cycle and the
 * classification-snapshot CI check is in place (synthetic CI
 * fixtures, task #103).
 */

export function useFactorScorer(): boolean {
	return process.env.USE_FACTOR_SCORER === "1";
}

/** USE_CONTINUITY_CONTINUATION=1 — Phase 3 of
 *  `docs/proposals/2026-06-presence-continuity.md`. When on, the HSMM
 *  emission function reads the prior day's end-of-day place from
 *  `presence_log` and boosts the no-fix-minute likelihood for the
 *  matching stationary state. Falls off as
 *  `decay(hours-since-last-fix)` so a multi-day no-data period
 *  attributes to the prior place but with decaying confidence. */
export function useContinuityContinuation(): boolean {
	return process.env.USE_CONTINUITY_CONTINUATION === "1";
}

export function useBiometricFactor(): boolean {
	return process.env.USE_BIOMETRIC_FACTOR === "1";
}

/** USE_CADENCE_IMPUTATION=1 — C4.1 of
 *  `docs/proposals/2026-07-continuity-c4.md`. When on, the HSMM
 *  observation tensor imputes `cadence: 0` for a rowless minute when the
 *  watch was demonstrably alive around it (measured HR/step rows within
 *  the liveness window on both sides), so the zero-inflated cadence
 *  emission can refute walking through GPS blackouts. Off keeps the
 *  pre-C4.1 tensor (rowless minute = null = factor skipped). Shadow-
 *  measured on the decoder scoreboard; flips on when the scoreboard
 *  clears (needs the C4.2 entry chain context — measured 2026-07-16:
 *  imputation alone converts phantom walks into phantom vehicle
 *  micro-rides on drift bursts). */
export function useCadenceImputation(): boolean {
	return process.env.USE_CADENCE_IMPUTATION === "1";
}

/** USE_CHAIN_CONTEXT=1 — C4.2 proper
 *  (`docs/proposals/2026-07-continuity-c4.md`): exit→entry chain
 *  context (`src/hmm/chain-context.ts`) — every new-segment transition
 *  scored for geometric feasibility from the previous segment's exit
 *  evidence (teleport cost into/out of a known place, boarding
 *  feasibility for a named line). Shadow-measured on the decoder
 *  scoreboard; flips on when the scoreboard clears. */
export function useChainContext(): boolean {
	return process.env.USE_CHAIN_CONTEXT === "1";
}

/** USE_SEGMENT_EVIDENCE=1 — C4.2 groundwork
 *  (`docs/proposals/2026-07-continuity-c4.md`): segment-scoped physics
 *  evidence (net displacement + step budget vs mode,
 *  `src/hmm/segment-evidence.ts`) composed into the HSMM duration hook.
 *  Shadow-measured on the decoder scoreboard alone and together with
 *  USE_CADENCE_IMPUTATION; flips on when the scoreboard clears. */
export function useSegmentEvidence(): boolean {
	return process.env.USE_SEGMENT_EVIDENCE === "1";
}

/**
 * The one-way CEILING on unexplained Lean divergences — the mechanism that
 * lets a tenant be STAGED in the gate while it still carries standing debt.
 *
 * The deploy gate runs five of the seven tenants `on` in its golden re-run and
 * leaves `match` and `passes` off. `deploy.sh` is explicit that this is the
 * gate's weakest point rather than a tidy scoping decision: both are already
 * `on` or `shadow` in production, both report UNEXPLAINED legs on some days,
 * and there was no way to say so. Staging them meant failing every deploy on a
 * pre-existing condition; the only other lever was to widen the accepted-delta
 * manifests — and that is the one thing `deploy.sh` tells you not to do.
 *
 * So this is the third option, and the distinction it draws is the whole point:
 *
 *   ACCEPTED (`accepted-deltas.ts`, `accepted-match-deltas.ts`)
 *       a divergence someone MEASURED, understood, and signed off as benign —
 *       a Douglas-Peucker near-tie within tolerance, a libm ULP band. It comes
 *       with a `reason` field because it is a judgement.
 *   CEILING (this module)
 *       a divergence nobody has adjudicated yet. It is not blessed, not
 *       understood, and not permitted to grow. It exists so that "we know about
 *       this and it is not getting worse" is expressible without pretending to
 *       be "we checked this and it is fine".
 *
 * Losing that line is how a ratchet turns into a rubber stamp: every awkward
 * finding becomes an accepted delta, the manifest becomes a list of things
 * nobody re-reads, and the gate goes green on a system nobody has checked.
 *
 * Keyed on the divergences' own CONTENT fingerprints — `match` uses the leg
 * hash it already computes from the quantised input, `passes` uses `op/n/note`
 * — rather than on dates, as the kinematic and rail-triple ceilings do. A
 * fingerprint is derived from the leg, so it survives a re-capture that shifts
 * every date in the corpus; a per-day count would have to be re-blessed
 * wholesale each time, which is precisely when a regression slips in unseen.
 *
 * Pure module. No IO — the caller owns the file, as with `floor-gate.ts`.
 */

/** Tenant name (`match`, `passes`, …) → its sorted unexplained fingerprints. */
export type DeltaCeiling = Record<string, string[]>;

/** One fingerprint, attributed to the tenant that produced it. */
export interface CeilingEntry {
	tenant: string;
	fingerprint: string;
}

export interface CeilingGateResult {
	/** Above the ceiling — divergences this run produced that the committed
	 *  ceiling does not cover. These are the failures. */
	fresh: CeilingEntry[];
	/** Below it — committed debt this run no longer produces. Never a failure;
	 *  re-bless to ratchet the ceiling down onto them. */
	cleared: CeilingEntry[];
}

/**
 * Judge this run's unexplained divergences against the committed ceiling.
 *
 * A tenant ABSENT from `committed` has a ceiling of zero, matching how every
 * other ratchet in the harness reads a missing key (`baseline[date] ?? 0`): a
 * newly-offending tenant must not be admitted by the ceiling simply saying
 * nothing about it.
 *
 * `committed === null` is the distinct bootstrap case — no ceiling file exists
 * yet, so there is nothing to judge against and the run passes while the caller
 * prompts for a first bless. This mirrors `loadFeasibilityBaseline` returning
 * `null`, and is deliberately NOT the same as an empty ceiling, which asserts
 * that every tenant is clean.
 */
export function gateDeltaCeiling(committed: DeltaCeiling | null, current: DeltaCeiling): CeilingGateResult {
	if (committed === null) return { fresh: [], cleared: [] };
	const fresh: CeilingEntry[] = [];
	const cleared: CeilingEntry[] = [];
	for (const tenant of [...new Set([...Object.keys(committed), ...Object.keys(current)])].sort()) {
		const was = new Set(committed[tenant] ?? []);
		const now = new Set(current[tenant] ?? []);
		for (const f of [...now].sort()) if (!was.has(f)) fresh.push({ tenant, fingerprint: f });
		for (const f of [...was].sort()) if (!now.has(f)) cleared.push({ tenant, fingerprint: f });
	}
	return { fresh, cleared };
}

/**
 * Ratchet the ceiling DOWN onto the current run — the intersection of what was
 * committed and what still occurs.
 *
 * The intersection, not the current run, and that asymmetry is the mechanism.
 * A bless that wrote the current set wholesale would record every fingerprint
 * the run produced, including ones that appeared for the first time in the very
 * run being blessed — so a change that fixed one leg and broke another would
 * launder the breakage through the fix. This is the same defect the per-day
 * ceilings carried until 2026-07-27, in set form.
 *
 * The consequence is deliberate: genuinely new standing debt cannot be blessed
 * in by any flag. Recording it means hand-editing the committed file, which
 * leaves a reviewable diff naming exactly which fingerprint someone decided to
 * tolerate — and that review is the point, not an obstacle to route around.
 */
export function ratchetDownCeiling(committed: DeltaCeiling | null, current: DeltaCeiling): DeltaCeiling {
	const out: DeltaCeiling = {};
	// Bootstrap: nothing to ratchet against, so the run establishes the first
	// ceiling. Every later bless can only shrink it.
	const source = committed === null ? current : committed;
	for (const tenant of Object.keys(source).sort()) {
		const now = new Set(current[tenant] ?? []);
		const kept =
			committed === null ? [...(current[tenant] ?? [])] : (committed[tenant] ?? []).filter((f) => now.has(f));
		// A tenant that is clean now leaves the file entirely rather than
		// lingering as an empty array, so the committed ceiling reads as a list
		// of live debt and a tenant's disappearance from it is a visible win.
		if (kept.length > 0) out[tenant] = [...new Set(kept)].sort();
	}
	return out;
}

/** Total fingerprints across every tenant — the one number worth printing. */
export function ceilingSize(c: DeltaCeiling): number {
	return Object.values(c).reduce((n, fs) => n + fs.length, 0);
}

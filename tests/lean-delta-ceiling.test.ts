/**
 * The one-way CEILING on unexplained Lean divergences (#403).
 *
 * `deploy.sh` runs five of the seven tenants `on` in its golden re-run and
 * leaves `match` and `passes` off — not as a scoping decision but because
 * there was nowhere to record their standing debt. Both are already serving or
 * shadowing in production with UNEXPLAINED legs on the ledger, so staging them
 * in the gate would have failed every deploy on a pre-existing condition, and
 * the only lever available was to widen the accepted-delta manifests, i.e. to
 * forge a sign-off. These pin the third option: record the debt, refuse to let
 * it grow, and keep it visibly distinct from an adjudicated acceptance.
 */

import { describe, expect, it } from "vitest";
import { type DeltaCeiling, gateDeltaCeiling, ratchetDownCeiling } from "../src/lean/delta-ceiling.js";
import { gateLedgers, type LedgerVerdict } from "../src/lean/ledger-verdict.js";

const v = (o: Partial<LedgerVerdict> = {}): LedgerVerdict => ({
	tenant: "match",
	mode: "on",
	calls: 32,
	fails: 0,
	klass: "exact",
	unexplained: [],
	...o,
});

describe("gateDeltaCeiling", () => {
	it("passes a run that reproduces its committed debt exactly", () => {
		const c: DeltaCeiling = { match: ["legA", "legB"] };
		expect(gateDeltaCeiling(c, { match: ["legA", "legB"] })).toEqual({ fresh: [], cleared: [] });
	});

	// The headline case: this is the thing a ceiling exists to catch, and the
	// thing a widened accepted-delta manifest would have swallowed.
	it("fails a fingerprint that is not in the ceiling, and names it", () => {
		const { fresh } = gateDeltaCeiling({ match: ["legA"] }, { match: ["legA", "legNEW"] });
		expect(fresh).toEqual([{ tenant: "match", fingerprint: "legNEW" }]);
	});

	it("reports a fingerprint that has gone away, without failing on it", () => {
		const g = gateDeltaCeiling({ match: ["legA", "legB"] }, { match: ["legA"] });
		expect(g.fresh).toEqual([]);
		expect(g.cleared).toEqual([{ tenant: "match", fingerprint: "legB" }]);
	});

	// A ceiling is per-tenant. Pooling them would let `passes` getting better
	// pay for `match` getting worse, which is exactly the trade the ratchet
	// exists to forbid.
	it("keeps tenants separate — one improving does not license another regressing", () => {
		const g = gateDeltaCeiling(
			{ match: ["legA"], passes: ["simplify/115/x"] },
			{ match: ["legA", "legNEW"], passes: [] },
		);
		expect(g.fresh).toEqual([{ tenant: "match", fingerprint: "legNEW" }]);
		expect(g.cleared).toEqual([{ tenant: "passes", fingerprint: "simplify/115/x" }]);
	});

	// A tenant with no committed entry has a ceiling of ZERO, exactly as a day
	// missing from the feasibility baseline does. Otherwise a brand-new tenant's
	// entire debt would be admitted by saying nothing about it.
	it("treats an unlisted tenant as a ceiling of zero", () => {
		const { fresh } = gateDeltaCeiling({ match: [] }, { rail: ["r1"] });
		expect(fresh).toEqual([{ tenant: "rail", fingerprint: "r1" }]);
	});

	it("bootstraps without failing when there is no committed ceiling at all", () => {
		expect(gateDeltaCeiling(null, { match: ["legA"] })).toEqual({ fresh: [], cleared: [] });
	});
});

describe("ratchetDownCeiling", () => {
	it("drops a fingerprint the run no longer produces", () => {
		expect(ratchetDownCeiling({ match: ["legA", "legB"] }, { match: ["legA"] })).toEqual({ match: ["legA"] });
	});

	// The `ratchetDown` lesson, restated for sets: a bless run that fixed one
	// leg and introduced another must not record the new one. Blessing the wins
	// must never also bless the losses — the fresh leg goes on failing the gate
	// until it is genuinely fixed or deliberately hand-recorded.
	it("refuses to admit a fresh fingerprint, even while blessing a fixed one", () => {
		expect(ratchetDownCeiling({ match: ["legA", "legB"] }, { match: ["legA", "legNEW"] })).toEqual({
			match: ["legA"],
		});
	});

	it("drops a tenant entirely once it is clean", () => {
		expect(ratchetDownCeiling({ match: ["legA"], passes: ["p1"] }, { passes: ["p1"] })).toEqual({ passes: ["p1"] });
	});

	it("cannot admit a tenant absent from the committed ceiling", () => {
		expect(ratchetDownCeiling({ match: ["legA"] }, { match: ["legA"], rail: ["r1"] })).toEqual({ match: ["legA"] });
	});

	// The distinct bootstrap case: no file yet, so there is nothing to ratchet
	// against and the current run establishes the first ceiling.
	it("establishes the first ceiling from the current run when none is committed", () => {
		expect(ratchetDownCeiling(null, { match: ["legB", "legA"] })).toEqual({ match: ["legA", "legB"] });
	});

	it("sorts fingerprints so a re-bless produces a reviewable diff", () => {
		expect(ratchetDownCeiling(null, { match: ["c", "a", "b"] }).match).toEqual(["a", "b", "c"]);
	});
});

describe("gateLedgers under a ceiling", () => {
	// Without a ceiling the behaviour is unchanged — every divergence fails.
	// That stays the default so a harness that has not opted in cannot be made
	// quieter by the mere existence of this mechanism.
	it("still fails a divergence when no ceiling is supplied", () => {
		expect(gateLedgers([v({ klass: "diverged", unexplained: ["legA"] })], {}).failures).toHaveLength(1);
	});

	it("passes a divergence that is entirely at or below the ceiling, and says so", () => {
		const g = gateLedgers([v({ klass: "diverged", unexplained: ["legA"] })], {}, { match: ["legA"] });
		expect(g.failures).toEqual([]);
		expect(g.notes[0]).toContain("standing debt");
		expect(g.notes[0]).toContain("legA");
	});

	it("fails the fingerprints above the ceiling and names only those", () => {
		const g = gateLedgers([v({ klass: "diverged", unexplained: ["legA", "legNEW"] })], {}, { match: ["legA"] });
		expect(g.failures).toHaveLength(1);
		expect(g.failures[0]).toContain("legNEW");
		expect(g.failures[0]).not.toContain("legA");
	});

	// A ceiling records DIVERGENCE debt. It says nothing about whether the
	// bridge ran, and must not become a way to keep a dead tenant green — that
	// is the #392 failure mode, one layer along.
	it("does not excuse a swallowed bridge failure", () => {
		const g = gateLedgers([v({ klass: "diverged", fails: 2, unexplained: ["legA"] })], {}, { match: ["legA"] });
		expect(g.failures).toHaveLength(1);
		expect(g.failures[0]).toContain("bridge failure");
	});

	// Five of the seven tenants compare whole outputs rather than per-leg, so a
	// divergence of theirs has no fingerprint to put in a ceiling. The empty set
	// must read as "cannot be ceilinged", never as "nothing above the ceiling" —
	// the latter would turn every unnameable divergence into a silent pass.
	it("fails a divergence that carries no fingerprints, even under a ceiling", () => {
		const g = gateLedgers([v({ tenant: "kalman", klass: "diverged", unexplained: [] })], {}, { match: ["legA"] });
		expect(g.failures).toHaveLength(1);
		expect(g.failures[0]).toContain("diverged");
	});

	it("does not excuse a tenant that never called the bridge", () => {
		const g = gateLedgers([v({ klass: "not-exercised", calls: 0 })], {}, { match: ["legA"] });
		expect(g.failures).toHaveLength(1);
		expect(g.failures[0]).toContain("zero calls");
	});
});

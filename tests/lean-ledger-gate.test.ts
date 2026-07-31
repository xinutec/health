/**
 * The gate that turns a Lean tenant's ledger into an exit code (#392).
 *
 * Until this existed, `npm run golden` could print
 * `lean-kalman[on] golden 0/32f (no calls) NOT EXERCISED` and still exit 0 —
 * every tenant's arm dead, every fixture green, because the exit code was
 * computed from the snapshot diff and the ratchets alone. These pin the four
 * ways a staged tenant can be broken while looking fine.
 */

import { describe, expect, it } from "vitest";
import { gateLedgers, type LedgerVerdict } from "../src/lean/ledger-verdict.js";

const v = (o: Partial<LedgerVerdict> = {}): LedgerVerdict => ({
	tenant: "kalman",
	mode: "on",
	calls: 32,
	fails: 0,
	klass: "exact",
	...o,
});

describe("gateLedgers", () => {
	it("passes a clean run and says nothing", () => {
		expect(gateLedgers([v(), v({ tenant: "gpsquality" })], {})).toEqual({ failures: [], notes: [] });
	});

	// `off` is the default on every tenant. Merely having the gate must not make
	// an untouched tenant a build failure, or nobody could run the corpus.
	it("ignores a tenant that is off", () => {
		expect(gateLedgers([null, null], {}).failures).toEqual([]);
	});

	// The headline case. A staged tenant with zero calls looked exactly like a
	// clean one in every ledger until #392, and its arm had not run at all.
	it("fails a staged tenant that never called the bridge", () => {
		const { failures } = gateLedgers([v({ calls: 0, klass: "not-exercised" })], {});
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("zero calls");
		expect(failures[0]).toContain("lean-kalman[on]");
	});

	// The silent one: `shadow` and `on` both swallow `LeanBridgeError`, so a
	// bridge that failed every call and fell back to TS prints no warning and
	// serves correct output. In production that is the point; in a deterministic
	// offline corpus it means the bridge is broken and the run measured nothing.
	it("fails a run whose bridge calls were swallowed, even when the surviving calls agreed", () => {
		const { failures } = gateLedgers([v({ calls: 30, fails: 2, klass: "exact" })], {});
		expect(failures[0]).toContain("2 bridge failure(s)");
	});

	it("fails a divergence, and passes an accepted class", () => {
		expect(gateLedgers([v({ klass: "diverged" })], {}).failures).toHaveLength(1);
		expect(gateLedgers([v({ klass: "accepted" })], {}).failures).toEqual([]);
	});

	// A tenant the harness structurally cannot reach — `hsmm` and `rail` on the
	// golden corpus, which replays cached decodes and preloads the route cache
	// (#233). Waived, but NAMED, so the exemption is visible in every run rather
	// than being a silence the reader has to already know about.
	it("waives zero calls for a tenant the harness cannot reach, and says why", () => {
		const g = gateLedgers([v({ tenant: "rail", calls: 0, klass: "not-exercised" })], {
			rail: "the corpus preloads rail_route_cache",
		});
		expect(g.failures).toEqual([]);
		expect(g.notes[0]).toContain("preloads rail_route_cache");
	});

	// The waiver excuses zero calls. It is not a licence to diverge — that would
	// make it the very thing it exists to avoid, a permanently green tenant.
	it("still fails a waived tenant that diverges", () => {
		const g = gateLedgers([v({ tenant: "rail", klass: "diverged" })], { rail: "cache preloaded" });
		expect(g.failures).toHaveLength(1);
	});

	// The waiver must decay. If the corpus grows a path that reaches the tenant,
	// the claim "this harness cannot reach it" has become false, and leaving it
	// standing would silently re-waive a tenant that is now gateable.
	it("reports a waiver as stale once the tenant records calls", () => {
		const g = gateLedgers([v({ tenant: "rail", calls: 4, klass: "exact" })], { rail: "cache preloaded" });
		expect(g.failures).toEqual([]);
		expect(g.notes[0]).toContain("STALE WAIVER");
	});

	// One tenant, one line: a skipped HSMM day is both a swallowed failure and a
	// divergence, and two lines would read as two problems.
	it("reports one failure line per tenant, carrying every reason", () => {
		const { failures } = gateLedgers(
			[v({ tenant: "hsmm", mode: "shadow", calls: 3, fails: 1, klass: "diverged" })],
			{},
		);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("bridge failure");
		expect(failures[0]).toContain("diverged");
	});
});

/**
 * `LEAN_HSMM` staging flag + ledger — the new request-path surface that lets
 * the verified HSMM decode soak like the rail/passes/match tenants. The shadow
 * comparison itself is covered by the golden corpus gate; here we pin the flag
 * parsing (which must fail SAFE to off) and the fleetwatch-grep ledger line.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { leanHsmmMode, logLeanHsmmLedger, resetLeanHsmmStats } from "../src/lean/lean-hsmm.js";

afterEach(() => {
	process.env.LEAN_HSMM = undefined;
	resetLeanHsmmStats();
	vi.restoreAllMocks();
});

describe("leanHsmmMode", () => {
	it("defaults to off when unset", () => {
		process.env.LEAN_HSMM = undefined;
		expect(leanHsmmMode()).toBe("off");
	});

	it("reads shadow and on verbatim", () => {
		process.env.LEAN_HSMM = "shadow";
		expect(leanHsmmMode()).toBe("shadow");
		process.env.LEAN_HSMM = "on";
		expect(leanHsmmMode()).toBe("on");
	});

	it("treats any other value as off — a typo must never enable a shadow, let alone a flip", () => {
		process.env.LEAN_HSMM = "yes";
		expect(leanHsmmMode()).toBe("off");
		process.env.LEAN_HSMM = "";
		expect(leanHsmmMode()).toBe("off");
		process.env.LEAN_HSMM = "SHADOW";
		expect(leanHsmmMode()).toBe("off");
	});
});

describe("logLeanHsmmLedger", () => {
	it("prints nothing when off — zero cost, zero noise", () => {
		process.env.LEAN_HSMM = undefined;
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		logLeanHsmmLedger("2026-07-16");
		expect(spy).not.toHaveBeenCalled();
	});

	it("reports a clean empty run in the tenant-consistent grep format", () => {
		process.env.LEAN_HSMM = "shadow";
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		logLeanHsmmLedger("2026-07-16");
		expect(spy).toHaveBeenCalledWith("lean-hsmm[shadow] 2026-07-16 0d (no days) EXACT");
	});

	it("resets after logging, so each day's ledger stands alone", () => {
		process.env.LEAN_HSMM = "shadow";
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		logLeanHsmmLedger("2026-07-16");
		logLeanHsmmLedger("2026-07-17");
		expect(spy).toHaveBeenNthCalledWith(2, "lean-hsmm[shadow] 2026-07-17 0d (no days) EXACT");
	});
});

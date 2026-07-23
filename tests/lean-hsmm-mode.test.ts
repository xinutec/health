/**
 * `LEAN_HSMM` staging flag + ledger — the new request-path surface that lets
 * the verified HSMM decode soak like the rail/passes/match tenants. The shadow
 * comparison itself is covered by the golden corpus gate; here we pin the flag
 * parsing (which must fail SAFE to off) and the fleetwatch-grep ledger line.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeHsmm, type HsmmInputs } from "../src/hmm/decode.js";
import { decodeHsmmViaLean } from "../src/hmm/lean-shadow-core.js";
import { decodeServed, leanHsmmMode, logLeanHsmmLedger, resetLeanHsmmStats } from "../src/lean/lean-hsmm.js";

// The serve path picks a decoder and falls back; stub both decoders + the
// binary-exists check so the policy is tested without a real Lean bridge.
vi.mock("../src/hmm/decode.js", async (orig) => ({
	...(await orig<typeof import("../src/hmm/decode.js")>()),
	decodeHsmm: vi.fn(),
}));
vi.mock("../src/hmm/lean-shadow-core.js", async (orig) => ({
	...(await orig<typeof import("../src/hmm/lean-shadow-core.js")>()),
	decodeHsmmViaLean: vi.fn(),
}));
vi.mock("node:fs", async (orig) => ({
	...(await orig<typeof import("node:fs")>()),
	existsSync: vi.fn(() => true),
}));

const TS_SEGS = [{ mode: "still" }] as unknown as ReturnType<typeof decodeHsmm>;
const LEAN_SEGS = [{ mode: "walk" }] as unknown as ReturnType<typeof decodeHsmm>;
const inputs = {} as HsmmInputs;

beforeEach(() => {
	vi.mocked(decodeHsmm).mockReturnValue(TS_SEGS);
	vi.mocked(decodeHsmmViaLean).mockReturnValue(LEAN_SEGS);
	process.env.LEAN_CLI = "/app/lean/verified_cli";
});

afterEach(() => {
	process.env.LEAN_HSMM = undefined;
	delete process.env.LEAN_CLI;
	resetLeanHsmmStats();
	vi.clearAllMocks();
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

describe("decodeServed", () => {
	it("serves the TS decode when off — production behaviour unchanged", () => {
		process.env.LEAN_HSMM = undefined;
		expect(decodeServed(inputs, "2026-07-16")).toBe(TS_SEGS);
		expect(decodeHsmm).toHaveBeenCalledOnce();
		expect(decodeHsmmViaLean).not.toHaveBeenCalled();
	});

	it("serves the TS decode when shadow — shadow observes, it does not serve", () => {
		process.env.LEAN_HSMM = "shadow";
		expect(decodeServed(inputs, "2026-07-16")).toBe(TS_SEGS);
		expect(decodeHsmmViaLean).not.toHaveBeenCalled();
	});

	it("serves the verified Lean decode when on", () => {
		process.env.LEAN_HSMM = "on";
		expect(decodeServed(inputs, "2026-07-16")).toBe(LEAN_SEGS);
		expect(decodeHsmmViaLean).toHaveBeenCalledOnce();
		expect(decodeHsmm).not.toHaveBeenCalled();
	});

	it("falls back to TS + warns when on but LEAN_CLI is missing", () => {
		process.env.LEAN_HSMM = "on";
		delete process.env.LEAN_CLI;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(decodeServed(inputs, "2026-07-16")).toBe(TS_SEGS);
		expect(decodeHsmmViaLean).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("LEAN_CLI missing"));
	});

	it("falls back to TS + warns when on but the bridge throws — a hiccup never crashes the decode", () => {
		process.env.LEAN_HSMM = "on";
		vi.mocked(decodeHsmmViaLean).mockImplementation(() => {
			throw new Error("lean decode degenerate");
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(decodeServed(inputs, "2026-07-16")).toBe(TS_SEGS);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("bridge failed"));
	});
});

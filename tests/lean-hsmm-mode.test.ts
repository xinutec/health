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

	// An empty run is NOT a clean one. This tenant reads zero days on the golden
	// corpus by construction — the corpus replays cached decodes — so `EXACT`
	// here was a pass reported for work that never happened (#392).
	it("reports an unexercised run as such, in the tenant-consistent grep format", () => {
		process.env.LEAN_HSMM = "shadow";
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		logLeanHsmmLedger("2026-07-16");
		expect(spy).toHaveBeenCalledWith("lean-hsmm[shadow] 2026-07-16 0d (no days) NOT EXERCISED");
	});

	it("resets after logging, so each day's ledger stands alone", () => {
		process.env.LEAN_HSMM = "shadow";
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		logLeanHsmmLedger("2026-07-16");
		logLeanHsmmLedger("2026-07-17");
		expect(spy).toHaveBeenNthCalledWith(2, "lean-hsmm[shadow] 2026-07-17 0d (no days) NOT EXERCISED");
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

/**
 * `solo` (#975) — the mode that lets `decodeHsmm` be deleted.
 *
 * This tenant needs more undone than its siblings. The others take the TS arm as
 * a thunk in ONE place; here `decodeServed` calls `decodeHsmm` directly from
 * three branches (wrong mode, absent `LEAN_CLI`, thrown bridge) and
 * `shadowLeanHsmm` runs the TS trellis again as measurement. If any of the four
 * survives, the TS decode is still reachable and nothing can be removed.
 */
describe("LEAN_HSMM=solo", () => {
	it("parses, and a typo still falls back to off", () => {
		process.env.LEAN_HSMM = "solo";
		expect(leanHsmmMode()).toBe("solo");
		process.env.LEAN_HSMM = "SOLO";
		expect(leanHsmmMode()).toBe("off");
	});

	it("serves the verified decode and never calls the TS one", () => {
		process.env.LEAN_HSMM = "solo";
		expect(decodeServed(inputs, "2026-08-17")).toBe(LEAN_SEGS);
		expect(decodeHsmm).not.toHaveBeenCalled();
	});

	// ⚠ The `LEAN_CLI` guard exists to serve TS when the binary is missing. Under
	// solo that remedy does not exist, so the guard must NOT intercept — the call
	// has to reach the bridge and fail there, loudly.
	it("does not fall back to TS when LEAN_CLI is missing", () => {
		process.env.LEAN_HSMM = "solo";
		delete process.env.LEAN_CLI;
		vi.mocked(decodeHsmmViaLean).mockImplementation(() => {
			throw new Error("no bridge");
		});
		expect(() => decodeServed(inputs, "2026-08-17")).toThrow("no bridge");
		expect(decodeHsmm).not.toHaveBeenCalled();
	});

	it("lets a bridge failure throw instead of serving TS", () => {
		process.env.LEAN_HSMM = "solo";
		vi.mocked(decodeHsmmViaLean).mockImplementation(() => {
			throw new Error("bridge died");
		});
		expect(() => decodeServed(inputs, "2026-08-17")).toThrow("bridge died");
		expect(decodeHsmm).not.toHaveBeenCalled();
	});

	// The shadow's whole job is to compare against TS. Running it under solo
	// would keep the implementation alive on every decoded day for a comparison
	// that can no longer inform anything.
	it("skips the shadow, and still counts the day it served", () => {
		process.env.LEAN_HSMM = "solo";
		decodeServed(inputs, "2026-08-17");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verdict = logLeanHsmmLedger("2026-08-17");
		const line = log.mock.calls[0]?.[0] as string;
		expect(line).toContain("lean-hsmm[solo]");
		expect(line).toContain("SOLO");
		// EXACT here is documented as "cleared BOTH the bridge and the
		// quantisation" — neither of which was checked.
		expect(line).not.toContain("EXACT");
		expect(verdict?.calls).toBe(1);
	});
});

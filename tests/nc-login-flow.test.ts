/**
 * Tests for the Nextcloud Login Flow v2 client.
 *
 * Login Flow v2 is the protocol DAVx⁵, KDE Connect, and every
 * native Nextcloud client uses to obtain a long-lived app password
 * without doing OAuth. The flow:
 *
 *   1. POST /index.php/login/v2  → { poll: { token, endpoint }, login }
 *   2. App opens `login` URL (user signs in + grants access in browser).
 *   3. App polls `poll.endpoint` with `{ token: poll.token }`.
 *      - 404 while pending.
 *      - 200 with { server, loginName, appPassword } when complete.
 *   4. App stores loginName + appPassword and uses HTTP Basic Auth
 *      on every subsequent request — no expiry, no refresh.
 *
 * This file tests the pure parts: response parsing, the Basic Auth
 * header construction, and the polling state machine.
 *
 * https://docs.nextcloud.com/server/latest/developer_manual/client_apis/LoginFlow/index.html
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	basicAuthHeader,
	type LoginFlowInitiation,
	type LoginFlowResult,
	parseInitiateResponse,
	parsePollResponse,
	pollLoginFlow,
} from "../src/nextcloud/login-flow.js";

describe("parseInitiateResponse", () => {
	it("parses the standard NC response shape into structured form", () => {
		const json = {
			poll: { token: "abc123", endpoint: "https://nc.example.com/index.php/login/v2/poll" },
			login: "https://nc.example.com/index.php/login/v2/flow/xyz",
		};
		const result = parseInitiateResponse(json);
		expect(result).toEqual({
			loginUrl: "https://nc.example.com/index.php/login/v2/flow/xyz",
			pollEndpoint: "https://nc.example.com/index.php/login/v2/poll",
			pollToken: "abc123",
		});
	});

	it("throws on a malformed response (missing fields)", () => {
		expect(() => parseInitiateResponse({})).toThrow();
		expect(() => parseInitiateResponse({ poll: {} })).toThrow();
		expect(() => parseInitiateResponse({ poll: { token: "t" }, login: "" })).toThrow();
	});

	it("throws on a non-string login URL", () => {
		const bad = { poll: { token: "t", endpoint: "e" }, login: 42 };
		expect(() => parseInitiateResponse(bad)).toThrow();
	});
});

describe("parsePollResponse", () => {
	it("returns the credentials when the poll has completed", () => {
		const json = {
			server: "https://nc.example.com",
			loginName: "pippijn",
			appPassword: "long-random-app-password-string",
		};
		expect(parsePollResponse(json)).toEqual({
			server: "https://nc.example.com",
			loginName: "pippijn",
			appPassword: "long-random-app-password-string",
		});
	});

	it("throws on a malformed completion (missing fields)", () => {
		expect(() => parsePollResponse({})).toThrow();
		expect(() => parsePollResponse({ server: "s", loginName: "x" })).toThrow();
	});
});

describe("basicAuthHeader", () => {
	it("encodes loginName:appPassword as RFC7617 Basic Auth", () => {
		// "alice:secret" → "YWxpY2U6c2VjcmV0"
		expect(basicAuthHeader("alice", "secret")).toBe("Basic YWxpY2U6c2VjcmV0");
	});

	it("handles non-ASCII login names (utf-8 → base64)", () => {
		// Verifies the encoder doesn't choke on UTF-8 and that the
		// header round-trips. Decoding back to the original string is
		// the contract.
		const header = basicAuthHeader("pippijn", "äpfel");
		const decoded = Buffer.from(header.replace(/^Basic /, ""), "base64").toString("utf-8");
		expect(decoded).toBe("pippijn:äpfel");
	});
});

describe("pollLoginFlow", () => {
	// Long-running state machine: POST to pollEndpoint repeatedly
	// until we get 200 (success) or hit the overall deadline.
	// The 404-while-pending and the success transition are the two
	// states. Errors propagate.

	const state: LoginFlowInitiation = {
		loginUrl: "https://nc.example.com/login/v2/flow/xyz",
		pollEndpoint: "https://nc.example.com/login/v2/poll",
		pollToken: "abc",
	};

	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns the credentials on the first successful poll", async () => {
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						server: "https://nc.example.com",
						loginName: "pippijn",
						appPassword: "p@ssw0rd",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		const promise = pollLoginFlow(state, {
			intervalMs: 100,
			deadlineMs: 5_000,
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		const result = await promise;
		expect(result).toEqual<LoginFlowResult>({
			server: "https://nc.example.com",
			loginName: "pippijn",
			appPassword: "p@ssw0rd",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps polling on 404 (pending) and returns once 200 arrives", async () => {
		const responses = [
			() => new Response("", { status: 404 }),
			() => new Response("", { status: 404 }),
			() =>
				new Response(JSON.stringify({ server: "s", loginName: "u", appPassword: "p" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		];
		let call = 0;
		const fetchMock = vi.fn(async () => responses[call++]());
		const promise = pollLoginFlow(state, {
			intervalMs: 100,
			deadlineMs: 5_000,
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		// Drive the timers so the polling loop advances.
		await vi.advanceTimersByTimeAsync(500);
		const result = await promise;
		expect(result.loginName).toBe("u");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("rejects with a deadline error if no completion arrives in time", async () => {
		const fetchMock = vi.fn(async () => new Response("", { status: 404 }));
		const promise = pollLoginFlow(state, {
			intervalMs: 200,
			deadlineMs: 1_000,
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		// Attach a rejection handler before advancing timers so the
		// expected error doesn't surface as an unhandled rejection.
		const result = expect(promise).rejects.toThrow(/deadline|timeout/i);
		await vi.advanceTimersByTimeAsync(2_000);
		await result;
	});
});

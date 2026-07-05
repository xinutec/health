/**
 * Tests for the OAuth callback's `return_to` validator.
 *
 * The validator decides where to redirect a user after a successful
 * OAuth callback. The previous regex (`^/[a-zA-Z0-9/_?=&%-]*$`) matches
 * `//evil.com` because `/` is in the character class — that's a
 * protocol-relative URL the browser would follow off-site.
 *
 * These tests pin down the correct contract: only single-leading-slash
 * internal paths are accepted, everything else falls back to `/`.
 *
 * The actual function lives in `src/middleware/return-to.ts` so tests
 * can exercise it without booting the full OAuth route.
 */

import { describe, expect, it } from "vitest";
import { validateReturnTo } from "../src/middleware/return-to.js";

describe("validateReturnTo", () => {
	it("accepts a simple internal path", () => {
		expect(validateReturnTo("/your-day")).toBe("/your-day");
	});

	it("accepts a path with a query string", () => {
		expect(validateReturnTo("/your-day?date=2026-05-11")).toBe("/your-day?date=2026-05-11");
	});

	it("accepts the root path", () => {
		expect(validateReturnTo("/")).toBe("/");
	});

	it("rejects a protocol-relative URL (//evil.com)", () => {
		// The classic open-redirect-adjacent bug. The browser follows
		// `//evil.com` as a same-protocol cross-origin URL — phishing.
		expect(validateReturnTo("//evil.com")).toBe("/");
	});

	it("rejects a protocol-relative URL with a path (//evil.com/path)", () => {
		expect(validateReturnTo("//evil.com/foo?token=stolen")).toBe("/");
	});

	it("rejects an absolute http(s) URL", () => {
		expect(validateReturnTo("https://evil.com/")).toBe("/");
		expect(validateReturnTo("http://evil.com/")).toBe("/");
	});

	it("rejects javascript: URIs", () => {
		expect(validateReturnTo("javascript:alert(1)")).toBe("/");
	});

	it("rejects data: URIs", () => {
		expect(validateReturnTo("data:text/html,<script>x</script>")).toBe("/");
	});

	it("rejects a backslash trick (some browsers normalise / and \\)", () => {
		expect(validateReturnTo("/\\evil.com")).toBe("/");
	});

	it("rejects paths with control characters or whitespace", () => {
		expect(validateReturnTo("/foo bar")).toBe("/");
		expect(validateReturnTo("/foo\n")).toBe("/");
		expect(validateReturnTo("/foo\t")).toBe("/");
	});

	it("rejects undefined / empty string", () => {
		expect(validateReturnTo(undefined)).toBe("/");
		expect(validateReturnTo("")).toBe("/");
	});

	it("rejects relative paths (without leading slash)", () => {
		expect(validateReturnTo("foo")).toBe("/");
		expect(validateReturnTo("foo/bar")).toBe("/");
	});

	it("preserves URL-safe punctuation in legitimate paths", () => {
		expect(validateReturnTo("/path-with-dashes_and_underscores")).toBe("/path-with-dashes_and_underscores");
		expect(validateReturnTo("/a?b=c&d=e")).toBe("/a?b=c&d=e");
		expect(validateReturnTo("/api/v1.0/resource")).toBe("/api/v1.0/resource");
	});
});

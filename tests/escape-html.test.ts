/**
 * Tests for the HTML escape helper used in server-rendered fallback
 * pages.
 *
 * The fallback landing page (src/server.ts) interpolates
 * `session.displayName` directly into an HTML template. The value
 * originates from Nextcloud, so today it's trusted — but it's still a
 * stored-XSS shape: any future change that lets a less-trusted source
 * influence displayName turns into a script-injection.
 *
 * Fix: extract `escapeHtml` to its own module and use it wherever
 * user-controlled values land in server-rendered HTML.
 */

import { describe, expect, it } from "vitest";
import { escapeHtml } from "../src/server-html.js";

describe("escapeHtml", () => {
	it("escapes the five HTML metacharacters", () => {
		expect(escapeHtml("&")).toBe("&amp;");
		expect(escapeHtml("<")).toBe("&lt;");
		expect(escapeHtml(">")).toBe("&gt;");
		expect(escapeHtml('"')).toBe("&quot;");
		expect(escapeHtml("'")).toBe("&#39;");
	});

	it("escapes a script-injection attempt", () => {
		const evil = "<script>alert('xss')</script>";
		const out = escapeHtml(evil);
		expect(out).not.toContain("<script");
		expect(out).toContain("&lt;script&gt;");
	});

	it("escapes & before < to avoid double-encoding", () => {
		// "Tom & Jerry" must not become "Tom &amp;amp; Jerry".
		expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
		expect(escapeHtml("<b>&amp;</b>")).toBe("&lt;b&gt;&amp;amp;&lt;/b&gt;");
	});

	it("leaves safe ASCII text alone", () => {
		expect(escapeHtml("Pippijn")).toBe("Pippijn");
		expect(escapeHtml("Hello, world.")).toBe("Hello, world.");
	});

	it("handles empty and unicode strings", () => {
		expect(escapeHtml("")).toBe("");
		expect(escapeHtml("naïve 北京 🚉")).toBe("naïve 北京 🚉");
	});

	it("is safe in attribute contexts (escapes quotes)", () => {
		const attack = `" onerror="alert(1)`;
		const out = escapeHtml(attack);
		// Both forms of quote must be escaped — single because some
		// renderers use single-quoted attributes.
		expect(out).not.toContain('"');
		expect(out).not.toContain("'");
	});
});

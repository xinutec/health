import { describe, expect, it } from "vitest";

import { oneLine } from "../src/routes/api.js";

describe("oneLine", () => {
	it("stops a label forging a log line", () => {
		// The attack this exists for: the label is written into the log as
		// `label=…`, so a newline inside it appends lines of the sender's
		// choosing — here a second client-event that never happened.
		const forged = "ok\nclient-event kind=tap path=/admin label=Delete everything";
		const flat = oneLine(forged, 160);
		expect(flat).not.toContain("\n");
		expect(flat).not.toContain("\r");
		expect(flat).toBe("ok client-event kind=tap path=/admin label=Delete everything");
	});

	it("flattens the separators that are not control characters", () => {
		// U+2028 and U+2029 are Zl/Zp, not Cc, and some renderers break a line on
		// both — so a check that only looked for \n would miss them.
		expect(oneLine("before\u2028after\u2029end", 160)).toBe("before after end");
	});

	it("leaves an ordinary label alone", () => {
		expect(oneLine("Refresh journeys", 160)).toBe("Refresh journeys");
	});

	it("caps a long label without splitting a glyph", () => {
		// Counted by code point, not by UTF-16 unit: slicing an emoji in half
		// emits a lone surrogate into the log.
		const flat = oneLine("😀".repeat(500), 160);
		expect([...flat]).toHaveLength(160);
		expect(flat).not.toContain("�");
	});
});

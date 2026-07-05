/**
 * Share-window enforcement — the server-side gate that stops a
 * share-link recipient reading data outside the granted N-day window.
 *
 * `shareableDateRange` (covered in share-token.test.ts) computes the
 * window; these two helpers enforce it on every date-bearing API
 * endpoint:
 *
 *   - sinceDateForSession      — floors a multi-day list query at the
 *     window start, so a large `days` parameter cannot widen it.
 *   - isDateOutsideShareWindow — rejects a single-day request whose
 *     date falls outside [from, to].
 *
 * Owner sessions (no `shareViewer`) are unrestricted by both. This is
 * a privacy boundary: without it, anyone with a share link could read
 * the whole history by hand-crafting `?date=` / `?days=`.
 */

import { describe, expect, it } from "vitest";
import { isDateOutsideShareWindow, sinceDateForSession } from "../src/routes/api.js";
import { shareableDateRange } from "../src/share/token.js";

/** A share-viewer session scoped to the inclusive window [from, to]. */
const viewer = (from: string, to: string) => ({ shareViewer: { from, to } });

describe("isDateOutsideShareWindow", () => {
	it("never restricts an owner session (no shareViewer)", () => {
		expect(isDateOutsideShareWindow({}, "1999-01-01")).toBe(false);
		expect(isDateOutsideShareWindow({}, "2099-01-01")).toBe(false);
	});

	it("rejects a date before the window start", () => {
		expect(isDateOutsideShareWindow(viewer("2026-05-08", "2026-05-14"), "2026-05-07")).toBe(true);
	});

	it("rejects a date after the window end", () => {
		expect(isDateOutsideShareWindow(viewer("2026-05-08", "2026-05-14"), "2026-05-15")).toBe(true);
	});

	it("accepts both window boundaries — the range is inclusive", () => {
		const w = viewer("2026-05-08", "2026-05-14");
		expect(isDateOutsideShareWindow(w, "2026-05-08")).toBe(false);
		expect(isDateOutsideShareWindow(w, "2026-05-14")).toBe(false);
	});

	it("accepts a date inside the window", () => {
		expect(isDateOutsideShareWindow(viewer("2026-05-08", "2026-05-14"), "2026-05-11")).toBe(false);
	});
});

describe("sinceDateForSession", () => {
	it("caps a multi-day read at the window start, however large `days`", () => {
		// A future-dated window: the owner floor (today − days) is always
		// earlier, so the window start must win for every `days` value.
		const w = viewer("2999-01-01", "2999-12-31");
		expect(sinceDateForSession(w, 1)).toBe("2999-01-01");
		expect(sinceDateForSession(w, 7)).toBe("2999-01-01");
		expect(sinceDateForSession(w, 365)).toBe("2999-01-01");
	});

	it("does not restrict an owner session — a larger `days` reaches further back", () => {
		const wide = sinceDateForSession({}, 7);
		const wider = sinceDateForSession({}, 30);
		expect(wider <= wide).toBe(true);
		expect(wider).not.toBe(wide);
	});

	it("a window wider than the owner's own range does not bind", () => {
		// `from` far in the past → the owner floor (today − days) wins, so
		// the result matches an unrestricted owner session.
		const w = viewer("2000-01-01", "2999-12-31");
		expect(sinceDateForSession(w, 30)).toBe(sinceDateForSession({}, 30));
	});
});

describe("share window end-to-end — shareableDateRange feeds the gate", () => {
	// A 7-day share created on 2026-05-14 → window [2026-05-08, 2026-05-14].
	const range = shareableDateRange("2026-05-14", 7);
	if (range === null) throw new Error("unreachable: daysBack=7 is a valid range");
	const session = { shareViewer: range };

	it("the 7th day back (window start) is inside the window", () => {
		expect(isDateOutsideShareWindow(session, "2026-05-08")).toBe(false);
	});

	it("the 8th day back is outside the window", () => {
		expect(isDateOutsideShareWindow(session, "2026-05-07")).toBe(true);
	});

	it("the window end is inside; the next day is outside", () => {
		expect(isDateOutsideShareWindow(session, "2026-05-14")).toBe(false);
		expect(isDateOutsideShareWindow(session, "2026-05-15")).toBe(true);
	});

	it("a 365-day list request is still capped to the window start", () => {
		// A far-future window so the owner floor (today − days) can never
		// reach it — keeps the assertion independent of the wall clock.
		const future = shareableDateRange("2999-05-14", 7);
		if (future === null) throw new Error("unreachable: daysBack=7 is a valid range");
		expect(sinceDateForSession({ shareViewer: future }, 365)).toBe("2999-05-08");
	});
});

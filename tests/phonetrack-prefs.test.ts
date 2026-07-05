import { describe, expect, it } from "vitest";
import { computePhoneTrackDatemin } from "../src/nextcloud/phonetrack-prefs.js";

const TS = (iso: string) => new Date(iso).getTime() / 1000;

describe("computePhoneTrackDatemin", () => {
	it("after 06:00 local: datemin is today 00:00 in tz, expressed as unix UTC", () => {
		// 14:00 Amsterdam (CEST = UTC+2) on 2026-05-10
		const now = new Date("2026-05-10T12:00:00Z");
		const ts = computePhoneTrackDatemin(now, "Europe/Amsterdam");
		// today 00:00 Amsterdam = 2026-05-09 22:00 UTC
		expect(ts).toBe(TS("2026-05-09T22:00:00Z"));
	});

	it("at 06:00 local exactly: still today (cutoff is strict less-than)", () => {
		// 06:00 Amsterdam = 04:00 UTC
		const now = new Date("2026-05-10T04:00:00Z");
		const ts = computePhoneTrackDatemin(now, "Europe/Amsterdam");
		expect(ts).toBe(TS("2026-05-09T22:00:00Z"));
	});

	it("at 05:59 local: yesterday 00:00 (still in night-mode)", () => {
		// 05:59 Amsterdam = 03:59 UTC
		const now = new Date("2026-05-10T03:59:00Z");
		const ts = computePhoneTrackDatemin(now, "Europe/Amsterdam");
		// yesterday 00:00 Amsterdam = 2026-05-08 22:00 UTC
		expect(ts).toBe(TS("2026-05-08T22:00:00Z"));
	});

	it("around midnight local: yesterday 00:00 (cumulative night)", () => {
		// 00:30 Amsterdam = 22:30 UTC previous day
		const now = new Date("2026-05-09T22:30:00Z");
		const ts = computePhoneTrackDatemin(now, "Europe/Amsterdam");
		// yesterday 00:00 Amsterdam = 2026-05-08 22:00 UTC
		expect(ts).toBe(TS("2026-05-08T22:00:00Z"));
	});

	it("Tokyo (UTC+9) — 14:00 local on May 10 → today 00:00 JST", () => {
		// 14:00 Tokyo = 05:00 UTC
		const now = new Date("2026-05-10T05:00:00Z");
		const ts = computePhoneTrackDatemin(now, "Asia/Tokyo");
		// today 00:00 Tokyo = 2026-05-09 15:00 UTC
		expect(ts).toBe(TS("2026-05-09T15:00:00Z"));
	});

	it("US Pacific (UTC-7 in May) — 23:00 local → today 00:00 PDT (still today)", () => {
		// 23:00 PDT = 06:00 UTC next day
		const now = new Date("2026-05-11T06:00:00Z");
		const ts = computePhoneTrackDatemin(now, "America/Los_Angeles");
		// today (May 10) 00:00 PDT = 2026-05-10 07:00 UTC
		expect(ts).toBe(TS("2026-05-10T07:00:00Z"));
	});

	it("custom cutoff: 04:00 instead of default 06:00", () => {
		// 05:00 Amsterdam = 03:00 UTC. With cutoff=04:00, 05:00 ≥ 04:00 → today.
		const now = new Date("2026-05-10T03:00:00Z");
		const ts = computePhoneTrackDatemin(now, "Europe/Amsterdam", 4);
		expect(ts).toBe(TS("2026-05-09T22:00:00Z"));
	});
});

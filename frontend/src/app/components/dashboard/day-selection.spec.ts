import { describe, expect, it } from "vitest";
import type { ActivityDay, SleepLog } from "../../services/health.service";
import { selectDayActivity, selectDayMainSleep } from "./day-selection";

function activity(date: string, steps = 5000): ActivityDay {
	return {
		date,
		steps,
		calories_total: 2000,
		calories_active: 500,
		distance_km: 4,
		minutes_sedentary: 600,
		minutes_lightly_active: 100,
		minutes_fairly_active: 20,
		minutes_very_active: 30,
		resting_heart_rate: 60,
	} as ActivityDay;
}

function mainSleep(date: string, minutes = 489): SleepLog {
	return {
		log_id: "1",
		date,
		start_time: `${date}T22:00:00`,
		end_time: `${date}T06:00:00`,
		duration_ms: minutes * 60_000,
		efficiency: 90,
		minutes_asleep: minutes,
		minutes_awake: 10,
		minutes_deep: 90,
		minutes_light: 250,
		minutes_rem: 100,
		minutes_wake: 30,
		is_main_sleep: true,
	} as SleepLog;
}

const TODAY = "2026-05-10";
const YESTERDAY = "2026-05-09";

describe("selectDayActivity", () => {
	it("returns the entry matching the selected day", () => {
		const window = [activity(YESTERDAY), activity(TODAY, 8000)];
		expect(selectDayActivity(window, TODAY)?.steps).toBe(8000);
	});

	it("returns null when the selected day is absent — no fallback to latest", () => {
		const window = [activity(YESTERDAY)];
		expect(selectDayActivity(window, TODAY)).toBeNull();
	});

	it("matches by prefix so a serialised DATE suffix still resolves", () => {
		const window = [activity(`${TODAY}T00:00:00.000Z`, 1234)];
		expect(selectDayActivity(window, TODAY)?.steps).toBe(1234);
	});
});

describe("selectDayMainSleep", () => {
	it("returns the main sleep matching the selected day", () => {
		const window = [mainSleep(YESTERDAY), mainSleep(TODAY, 480)];
		const got = selectDayMainSleep(window, TODAY);
		expect(got?.minutes_asleep).toBe(480);
		expect(got?.date).toBe(TODAY);
	});

	it("does NOT surface yesterday's sleep on today when today has none", () => {
		const window = [mainSleep(YESTERDAY)];
		expect(selectDayMainSleep(window, TODAY)).toBeNull();
	});

	it("ignores naps (is_main_sleep=false)", () => {
		const nap = { ...mainSleep(TODAY, 30), log_id: "2", is_main_sleep: false } as SleepLog;
		expect(selectDayMainSleep([nap], TODAY)).toBeNull();
	});
});

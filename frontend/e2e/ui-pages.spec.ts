import { test, type Page } from "@playwright/test";
// The fleet-shared harness, published as @xinutec/ui-harness (source repo
// ~/Code/ui-harness). Ships compiled JS, so it loads straight from node_modules.
import {
	expectNoTextOverlaps,
	expectNoHorizontalOverflow,
	expectViewportIsPhone,
	expectIconFontLoaded,
} from "@xinutec/ui-harness";

/**
 * L2 phone-width layout harness for the health dashboard. Render the Day and
 * Trends tabs at a Pixel viewport with the backend mocked and BUSY data, and
 * assert no text collides and nothing overflows the width. The densest,
 * highest-risk rows here are the Trends `.trend-range` (a mat-button-toggle-
 * group beside a number field — the classic too-wide toggle row) and the Day
 * summary-cards grid. (settings.spec.ts covers /settings, the other historically
 * collision-prone screen.)
 *
 * No service worker in this app, but block it anyway for parity with the fleet's
 * layout specs — SW-controlled fetches would bypass page.route.
 */
test.use({ serviceWorkers: "block" });

// The dashboard keys its day view on todayLocal(), so the day the test runs is
// the day it fetches — date the first window element to today so the summary
// cards populate (matching life's relative-date fixtures).
const day = (offset: number): string => {
	const d = new Date();
	d.setDate(d.getDate() + offset);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const ME = {
	userId: "u_test_1",
	displayName: "Test User",
	fitbitLinked: true,
	connections: { nextcloud: { status: "active" }, fitbit: { status: "active" } },
	shareWindow: null,
};

const ACTIVITY = [
	{ date: day(0), steps: 8421, calories_total: 2310, calories_active: 640, distance_km: 6.2,
		minutes_sedentary: 620, minutes_lightly_active: 180, minutes_fairly_active: 25, minutes_very_active: 35, resting_heart_rate: 58 },
	{ date: day(-1), steps: 10233, calories_total: 2455, calories_active: 720, distance_km: 7.4,
		minutes_sedentary: 560, minutes_lightly_active: 210, minutes_fairly_active: 30, minutes_very_active: 45, resting_heart_rate: 57 },
];

const SLEEP = [
	{ log_id: "1234567890", date: day(0), start_time: `${day(-1)}T23:10:00`, end_time: `${day(0)}T07:05:00`,
		duration_ms: 28500000, efficiency: 94, minutes_asleep: 445, minutes_awake: 30, minutes_deep: 82,
		minutes_light: 250, minutes_rem: 113, minutes_wake: 30, is_main_sleep: true },
	{ log_id: "1234567891", date: day(-1), start_time: `${day(-2)}T23:30:00`, end_time: `${day(-1)}T07:00:00`,
		duration_ms: 27000000, efficiency: 91, minutes_asleep: 430, minutes_awake: 20, minutes_deep: 75,
		minutes_light: 240, minutes_rem: 115, minutes_wake: 20, is_main_sleep: true },
];

const HRV = [
	{ date: day(0), daily_rmssd: 42.5, deep_rmssd: 48.1 },
	{ date: day(-1), daily_rmssd: 39.8, deep_rmssd: 45.0 },
];

const BODY = [
	{ date: day(0), weight_kg: "74.2", bmi: "22.9", body_fat_pct: "18.5" },
	{ date: day(-1), weight_kg: "74.5", bmi: "23.0", body_fat_pct: "18.7" },
];

const STAGES = [
	{ ts: `${day(-1)}T23:10:00Z`, stage: "light", duration_seconds: 1800 },
	{ ts: `${day(-1)}T23:40:00Z`, stage: "deep", duration_seconds: 2400 },
	{ ts: `${day(0)}T00:20:00Z`, stage: "rem", duration_seconds: 1500 },
	{ ts: `${day(0)}T00:45:00Z`, stage: "wake", duration_seconds: 300 },
];

const INTRADAY = [
	{ ts: `${day(0)}T08:00:00Z`, bpm: 62 },
	{ ts: `${day(0)}T08:01:00Z`, bpm: 64 },
	{ ts: `${day(0)}T08:02:00Z`, bpm: 66 },
];

/** Mock every backend call the dashboard makes on load. Catch-all FIRST —
 *  Playwright runs handlers last-registered-first, so specifics below win. The
 *  more-specific sleep/stages route is registered AFTER the sleep window route
 *  so it takes priority for that URL. */
async function mockApi(page: Page): Promise<void> {
	await page.route("**/api/**", (r) =>
		r.request().method() === "GET" ? r.fulfill({ json: [] }) : r.fulfill({ status: 204, body: "" }),
	);
	await page.route("**/api/me", (r) => r.fulfill({ json: ME }));
	await page.route("**/api/activity*", (r) => r.fulfill({ json: ACTIVITY }));
	await page.route("**/api/hrv*", (r) => r.fulfill({ json: HRV }));
	await page.route("**/api/body*", (r) => r.fulfill({ json: BODY }));
	await page.route("**/api/sleep*", (r) => r.fulfill({ json: SLEEP }));
	await page.route("**/api/sleep/stages*", (r) => r.fulfill({ json: STAGES }));
	await page.route("**/api/heartrate/intraday*", (r) => r.fulfill({ json: INTRADAY }));
	await page.route("**/api/velocity*", (r) => r.fulfill({ json: { points: [], segments: [] } }));
	await page.route("**/api/location/latest", (r) => r.fulfill({ json: null }));
}

// The checker-checker: fail loudly here if the device preset is ever lost and
// the "phone width" suite silently runs at desktop width (defect 2).
test("the suite really runs at phone geometry", async ({ page }) => {
	await mockApi(page);
	await page.goto("/");
	await expectViewportIsPhone(page);
});

test("dashboard Day tab — summary cards + charts: lays out cleanly @ phone width", async ({ page }, testInfo) => {
	await mockApi(page);
	await page.goto("/");
	await page.getByText("Steps").first().waitFor();
	await page.getByText("Resting HR").waitFor();
	await page.getByText("Sleep Stages").waitFor(); // a chart card is present → tab content laid out
	// The toolbar's mat-icons (settings/logout) must render as glyphs, not their
	// ligature words.
	await expectIconFontLoaded(page);
	await expectNoTextOverlaps(page, testInfo);
	await expectNoHorizontalOverflow(page, testInfo);
});

test("dashboard Trends tab — no text overlaps @ phone width", async ({ page }, testInfo) => {
	await mockApi(page);
	await page.goto("/");
	await page.getByRole("tab", { name: "Trends" }).click();
	// Trends-only titles (Steps/Sleep also appear on Day — disambiguate).
	await page.getByText("Resting Heart Rate").waitFor();
	await page.getByText("Heart Rate Variability (RMSSD)").waitFor();
	await page.getByText("30d", { exact: true }).waitFor(); // the range toggle row (mat-button-toggle)
	await expectNoTextOverlaps(page, testInfo);
});

test("dashboard Trends tab — charts must not overflow the phone width", async ({ page }, testInfo) => {
	await mockApi(page);
	await page.goto("/");
	// Kill CSS transitions/animations: the Material tab-slide translates the whole
	// tab-body ~55px right mid-animation, so a measurement taken during the slide
	// reads every child's right edge as past the viewport (a transient that
	// self-corrects when the slide lands at translateX(0)). We want the SETTLED
	// layout, so disable animations and let the tab switch instantly.
	await page.addStyleTag({
		content: "*,*::before,*::after{transition:none!important;animation:none!important}",
	});
	await page.getByRole("tab", { name: "Trends" }).click();
	await page.getByText("Resting Heart Rate").waitFor();
	// Also wait for chart.js's ResizeObserver to settle the canvas width.
	await page.locator("app-steps-chart canvas").waitFor();
	await page.waitForFunction(
		() => {
			const c = document.querySelector("app-steps-chart canvas");
			if (!c) return false;
			const w = Math.round(c.getBoundingClientRect().width);
			const prev = (window as unknown as { __w?: number }).__w;
			(window as unknown as { __w?: number }).__w = w;
			return w > 0 && prev === w;
		},
		null,
		{ polling: 120, timeout: 10_000 },
	);
	await expectNoHorizontalOverflow(page, testInfo);
});

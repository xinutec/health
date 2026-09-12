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
	{ log_id: "1234567890", date: day(0), start_time_utc: `${day(-1)}T22:10:00Z`, end_time_utc: `${day(0)}T06:05:00Z`, tz: "Europe/London",
		duration_ms: 28500000, efficiency: 94, minutes_asleep: 445, minutes_awake: 30, minutes_deep: 82,
		minutes_light: 250, minutes_rem: 113, minutes_wake: 30, is_main_sleep: true },
	{ log_id: "1234567891", date: day(-1), start_time_utc: `${day(-2)}T22:30:00Z`, end_time_utc: `${day(-1)}T06:00:00Z`, tz: "Europe/London",
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

// ⚠ THE INSTANT AND THE ZONE ARE THE WHOLE WIRE now (#1532): the route repairs
// a missing instant and no longer serves the wall clock. This fixture carried
// only the wall clock, so the hypnogram fell to a degraded arm and the chart
// drew while the real path went unexercised.
const STAGES = [
	{ ts_utc: `${day(-1)}T23:10:00Z`, tz: "Europe/London", stage: "light", duration_seconds: 1800 },
	{ ts_utc: `${day(-1)}T23:40:00Z`, tz: "Europe/London", stage: "deep", duration_seconds: 2400 },
	{ ts_utc: `${day(0)}T00:20:00Z`, tz: "Europe/London", stage: "rem", duration_seconds: 1500 },
	{ ts_utc: `${day(0)}T00:45:00Z`, tz: "Europe/London", stage: "wake", duration_seconds: 300 },
];

// Instant + zone, like STAGES above and for the same reason: a fixture carrying
// the wall clock exercises a path the API no longer has (#1532).
//
// ⚠ SIXTEEN POINTS, NOT THREE. The chart keeps every fifth sample, so a
// three-point fixture drew a single dot with one axis label — the #1551 shape,
// where the card renders and the code under it is never run. Sixteen gives four
// plotted points and four labels, one of which crosses the hour.
const INTRADAY = Array.from({ length: 16 }, (_, i) => {
	const at = new Date(Date.parse(`${day(0)}T07:50:00Z`) + i * 60_000);
	return { ts_utc: at.toISOString(), tz: "Europe/London", bpm: 60 + (i % 7) };
});

/** Mock every backend call the dashboard makes on load. Catch-all FIRST —
 *  Playwright runs handlers last-registered-first, so specifics below win. The
 *  more-specific sleep/stages route is registered AFTER the sleep window route
 *  so it takes priority for that URL. */
/** A day with real rows, so the timeline is actually RENDERED here.
 *
 * ⚠ This used to be `{points: [], segments: []}`, which drew an empty card and
 * made the layout assertions below pass by construction on the app's main view
 * (#1551). Overflow and collision are properties of real rows — a long
 * station-pair way name, a city header, a collapsed journey — so an empty list
 * cannot exercise them.
 *
 * The labels are deliberately among the longest the app produces: a
 * Circle-line station pair is the widest secondary line the timeline draws.
 */
// Midnight local on the day the app is showing, so the rows carry NO day-offset
// marker. Dating this to a fixed epoch put a "−1031d" badge on every row, which
// widens the time column and tests a layout the app never actually shows.
const DAY0 = (() => {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	return Math.floor(d.getTime() / 1000);
})();
const VELOCITY = {
	points: [],
	segments: [],
	states: [
		{ startTs: DAY0, endTs: DAY0 + 7 * 3600, mode: "sleeping", place: "Home",
		  city: "Greater London", tz: "Europe/London" },
		{ startTs: DAY0 + 7 * 3600, endTs: DAY0 + 7 * 3600 + 1200, mode: "stationary",
		  place: "Home", city: "Greater London", tz: "Europe/London" },
		{ startTs: DAY0 + 7 * 3600 + 1200, endTs: DAY0 + 7 * 3600 + 1800, mode: "walking",
		  wayName: "Wembley Park Boulevard", city: "Greater London", tz: "Europe/London" },
		{ startTs: DAY0 + 7 * 3600 + 1800, endTs: DAY0 + 7 * 3600 + 3000, mode: "train",
		  wayName: "Euston Square → King's Cross St Pancras · Circle Line",
		  city: "Greater London", tz: "Europe/London" },
		{ startTs: DAY0 + 7 * 3600 + 3000, endTs: DAY0 + 7 * 3600 + 3300, mode: "walking",
		  wayName: "Pancras Road", city: "Greater London", tz: "Europe/London" },
		{ startTs: DAY0 + 7 * 3600 + 3300, endTs: DAY0 + 12 * 3600, mode: "stationary",
		  place: "University College Hospital", city: "Greater London", tz: "Europe/London" },
	],
	journeys: [
		{
			startTs: DAY0 + 7 * 3600 + 1200,
			endTs: DAY0 + 7 * 3600 + 3300,
			legs: [
				{ startTs: DAY0 + 7 * 3600 + 1200, endTs: DAY0 + 7 * 3600 + 1800, mode: "walking" },
				{ startTs: DAY0 + 7 * 3600 + 1800, endTs: DAY0 + 7 * 3600 + 3000, mode: "train",
				  line: "Circle Line", board: "Euston Square", alight: "King's Cross St Pancras" },
				{ startTs: DAY0 + 7 * 3600 + 3000, endTs: DAY0 + 7 * 3600 + 3300, mode: "walking" },
			],
		},
	],
};

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
	await page.route("**/api/velocity*", (r) => r.fulfill({ json: VELOCITY }));
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

	// ⚠ PROVE THE TIMELINE ACTUALLY DREW ROWS. The mock used to be empty, and
	// the assertions below then passed on a blank card — the defect #1551
	// records. If this waits time out, the layout checks are meaningless.
	await page.getByText("Your Day").waitFor();
	await page.getByText("University College Hospital").waitFor();

	await expectNoTextOverlaps(page, testInfo);
	await expectNoHorizontalOverflow(page, testInfo);

	// EXPANDED is where the widest content is: a collapsed journey hides its
	// legs, and a leg carries the longest secondary the app draws (a Circle-line
	// station pair). Check the layout in that state too.
	await page.getByRole("button", { name: "Expand all" }).click();
	await page.getByText("Circle Line", { exact: false }).first().waitFor();
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
			// The previous width is parked on the canvas rather than on `window`:
			// `dataset` is typed, so the poll needs no assertion to say what it is
			// storing, and the value lives on the element it describes.
			const c = document.querySelector<HTMLCanvasElement>(
				"app-steps-chart canvas",
			);
			if (!c) return false;
			const w = String(Math.round(c.getBoundingClientRect().width));
			const prev = c.dataset["settledWidth"];
			c.dataset["settledWidth"] = w;
			return w !== "0" && prev === w;
		},
		null,
		{ polling: 120, timeout: 10_000 },
	);
	await expectNoHorizontalOverflow(page, testInfo);
});

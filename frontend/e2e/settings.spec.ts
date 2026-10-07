import { test, type Page } from "@playwright/test";
import { expectCleanLayout } from "@xinutec/ui-harness";

import type { LatestFix, ShareStatus, UserInfo } from "../src/app/services/health.service";

/**
 * Render /settings at a phone viewport with the backend mocked, and assert
 * no rendered text collides. This is the page that repeatedly *read* fine
 * but *rendered* with overlapping text (long mat-hint over the buttons; the
 * date line crashing into the field below). The mocks return the share-active
 * state because that's the busiest layout — every field, hint, paragraph and
 * the wrapping action row are all present at once.
 */

const USER = {
	userId: "owner",
	displayName: "Owner",
	fitbitLinked: true,
	nextcloudLinked: true,
	connections: { nextcloud: { status: "active" }, fitbit: { status: "active" } },
	shareWindow: null,
} satisfies UserInfo;

const SHARE_ACTIVE = {
	active: true,
	token: "demo-token",
	url: "http://localhost:4200/share/demo-token",
	daysBack: 7,
	shareLocation: false,
	createdAt: "2026-06-01T10:00:00.000Z",
	lastAccessedAt: "2026-06-08T21:00:03.000Z",
} satisfies ShareStatus;

const SHARE_NONE = { active: false } satisfies ShareStatus;

/** Mock every backend call the settings page (and the app shell it loads
 *  inside) makes, so it renders headlessly with no server or auth. */
async function mockApi(page: Page, share: ShareStatus): Promise<void> {
	// Register the catch-all FIRST: Playwright runs route handlers
	// last-registered-first, so the specific routes below take priority.
	await page.route("**/api/**", (r) => r.fulfill({ status: 204, body: "" }));
	await page.route("**/api/location/latest", (r) => r.fulfill({ json: null satisfies LatestFix | null }));
	await page.route("**/api/me", (r) => r.fulfill({ json: USER }));
	await page.route("**/api/share", (r) => r.fulfill({ json: share }));
}

test("settings — share active: no text overlaps @ phone width", async ({ page }, testInfo) => {
	await mockApi(page, SHARE_ACTIVE);
	await page.goto("/settings");
	await page.getByText("Share your timeline").waitFor();
	await page.getByLabel("Days to share").waitFor();
	await expectCleanLayout(page, testInfo);
});

test("settings — no share yet: no text overlaps @ phone width", async ({ page }, testInfo) => {
	await mockApi(page, SHARE_NONE);
	await page.goto("/settings");
	await page.getByText("Share your timeline").waitFor();
	await page.getByText("No share link active", { exact: false }).waitFor();
	await expectCleanLayout(page, testInfo);
});

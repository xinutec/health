/**
 * Toolbar share-link quick-copy button contract:
 *
 *   - hidden when no share link is active (shareStatus null or inactive)
 *   - shown when a share link is active
 *   - clicking it copies the share URL to the clipboard
 *   - the copied link carries the current view verbatim: whatever query
 *     string is on the dashboard URL (`?date=` / `?tab=` / `?trendDays=`
 *     / any future view param) is appended to the share URL, so the
 *     recipient lands on the same view with no per-param allowlist to
 *     keep in sync
 *
 * The button is a toolbar shortcut for the share URL otherwise only
 * reachable via Settings. Visibility tracks HealthService's
 * `shareStatus` signal, so creating or revoking a share anywhere
 * updates the toolbar without a reload.
 */

import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router, provideRouter } from "@angular/router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppComponent } from "./app.component";
import { HealthService, type ShareStatus, type UserInfo } from "./services/health.service";

const fakeUser = { userId: "u", displayName: "Test User" } as UserInfo;

function makeHealthMock(shareStatus: ShareStatus | null) {
	return {
		user: signal<UserInfo | null>(fakeUser),
		shareToken: signal<string | null>(null),
		shareStatus: signal<ShareStatus | null>(shareStatus),
		refreshShareStatus: async () => {},
		clientLog: async () => {},
	} as unknown as HealthService;
}

async function setup(shareStatus: ShareStatus | null, initialUrl = "/") {
	TestBed.configureTestingModule({
		imports: [AppComponent],
		providers: [
			// Componentless wildcard route — AppComponent's toolbar is what's
			// under test; the route only needs to resolve so the toolbar can
			// read the resulting URL (incl. its query string).
			provideRouter([{ path: "**", children: [] }]),
			{ provide: HealthService, useValue: makeHealthMock(shareStatus) },
		],
	});
	const fixture = TestBed.createComponent(AppComponent);
	await TestBed.inject(Router).navigateByUrl(initialUrl);
	fixture.detectChanges();
	return fixture;
}

describe("AppComponent toolbar — share quick-copy button", () => {
	beforeEach(() => {
		TestBed.resetTestingModule();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("hides the share button when no share status is loaded", async () => {
		const fixture = await setup(null);
		expect((fixture.nativeElement as HTMLElement).querySelector(".share-link")).toBeNull();
	});

	it("hides the share button when sharing is not active", async () => {
		const fixture = await setup({ active: false });
		expect((fixture.nativeElement as HTMLElement).querySelector(".share-link")).toBeNull();
	});

	it("shows the share button when a share link is active", async () => {
		const fixture = await setup({ active: true, url: "https://health.example/share/abc" });
		expect((fixture.nativeElement as HTMLElement).querySelector(".share-link")).not.toBeNull();
	});

	it("copies the bare share URL when no day or tab is in the URL", async () => {
		const url = "https://health.example/share/abc";
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { userAgent: "test", clipboard: { writeText } });
		const fixture = await setup({ active: true, url });
		const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".share-link")!;
		button.click();
		expect(writeText).toHaveBeenCalledWith(url);
	});

	it("carries the full current view (day, tab, trendDays) into the copied link", async () => {
		const url = "https://health.example/share/abc";
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { userAgent: "test", clipboard: { writeText } });
		const fixture = await setup({ active: true, url }, "/?date=2026-05-20&tab=trends&trendDays=60");
		const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".share-link")!;
		button.click();
		// The whole query string rides along verbatim — including trendDays,
		// which no allowlist had to be taught about.
		expect(writeText).toHaveBeenCalledWith(`${url}?date=2026-05-20&tab=trends&trendDays=60`);
	});
});

/**
 * Reauth banner contract:
 *
 *   - hidden when Nextcloud status is "active" or "unknown"
 *   - visible when status is "needs_reauth" with "Reconnect" copy
 *   - visible when status is "not_linked"   with "Connect" copy
 *
 * The actual Login Flow v2 click path is covered by manual testing
 * (it requires a real browser tab opening + NC roundtrip); these
 * tests assert only the render-state contract, which is what would
 * regress if someone re-tightened the @if condition.
 */

import { TestBed } from "@angular/core/testing";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { ReauthBannerComponent } from "./reauth-banner.component";
import { ConnectionStateService } from "../../services/connection-state.service";
import { HealthService } from "../../services/health.service";

function setup(opts: { onCheckAuth?: () => void } = {}) {
	// `checkAuth` is what re-reads /api/me and pushes the durable connection
	// status into ConnectionStateService. Stubbed so a test can say what the
	// server would have answered.
	const checkAuth = vi.fn(() => {
		opts.onCheckAuth?.();
		return Promise.resolve(true);
	});
	TestBed.configureTestingModule({
		imports: [ReauthBannerComponent],
		providers: [{ provide: HealthService, useValue: { checkAuth } }],
	});
	const fixture = TestBed.createComponent(ReauthBannerComponent);
	const connection = TestBed.inject(ConnectionStateService);
	fixture.detectChanges();
	return { fixture, connection, checkAuth };
}

/** Press the banner's button, with /api/nextcloud/connect/init stubbed. */
async function pressConnect(fixture: { nativeElement: unknown }): Promise<void> {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(JSON.stringify({ loginUrl: "https://nc.example/login/v2/flow/abc" }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	);
	vi.spyOn(window, "open").mockReturnValue(null);
	const button = (fixture.nativeElement as HTMLElement).querySelector("button");
	button?.click();
	await flush();
}

/** Let the component's awaited fetch/json chain settle. */
function flush(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}

describe("ReauthBannerComponent", () => {
	beforeEach(() => {
		TestBed.resetTestingModule();
	});

	it("renders nothing when Nextcloud status is 'unknown' (default)", () => {
		const { fixture } = setup();
		expect((fixture.nativeElement as HTMLElement).querySelector(".reauth-banner")).toBeNull();
	});

	it("renders nothing when status is 'active'", () => {
		const { fixture, connection } = setup();
		connection.setNextcloudStatus("active");
		fixture.detectChanges();
		expect((fixture.nativeElement as HTMLElement).querySelector(".reauth-banner")).toBeNull();
	});

	it("renders the banner with 'Reconnect Nextcloud' button when status is 'needs_reauth'", () => {
		const { fixture, connection } = setup();
		connection.setNextcloudStatus("needs_reauth");
		fixture.detectChanges();
		const banner = (fixture.nativeElement as HTMLElement).querySelector(".reauth-banner");
		expect(banner).not.toBeNull();
		expect(banner?.textContent ?? "").toContain("expired");
		const button = banner?.querySelector("button");
		expect(button?.textContent ?? "").toContain("Reconnect Nextcloud");
	});

	it("renders the banner with 'Connect Nextcloud' button when status is 'not_linked'", () => {
		// Regression test for the post-migration case: the user's
		// nc_credentials row doesn't exist yet (Login Flow v2 hasn't
		// been completed), so status reports "not_linked". Banner
		// must still show with a connect CTA — otherwise the user
		// gets the empty dashboard with no path to fix it.
		const { fixture, connection } = setup();
		connection.setNextcloudStatus("not_linked");
		fixture.detectChanges();
		const banner = (fixture.nativeElement as HTMLElement).querySelector(".reauth-banner");
		expect(banner).not.toBeNull();
		expect(banner?.textContent ?? "").toContain("Connect your Nextcloud");
		const button = banner?.querySelector("button");
		expect(button?.textContent ?? "").toContain("Connect Nextcloud");
		expect(button?.textContent ?? "").not.toContain("Reconnect");
	});

	it("settles when the page comes back, rather than on a timer that isn't running", async () => {
		// The defect DL-ANGULAR-OFFSITE-POLL names, and the reason this banner
		// changed. Granting access happens on NEXTCLOUD's page, which takes the
		// foreground — so the 2s poll this replaced was not running while the
		// only interesting thing happened. life shipped the same design and it
		// failed on first use: credential stored, banner still waiting, exactly
		// one status request made.
		const { fixture, connection, checkAuth } = setup({
			onCheckAuth: () => connection.setNextcloudStatus("active"),
		});
		connection.setNextcloudStatus("not_linked");
		fixture.detectChanges();
		await pressConnect(fixture);
		fixture.detectChanges();
		expect((fixture.nativeElement as HTMLElement).textContent ?? "").toContain("Opened Nextcloud");

		document.dispatchEvent(new Event("visibilitychange"));
		await flush();
		fixture.detectChanges();

		expect(checkAuth).toHaveBeenCalled();
		expect(connection.nextcloudStatus()).toBe("active");
		expect((fixture.nativeElement as HTMLElement).querySelector(".reauth-banner")).toBeNull();
	});

	it("coming back without granting returns the button rather than spinning for ever", async () => {
		// Abandoning the grant used to leave a spinner and no way out of it.
		const { fixture, connection } = setup();
		connection.setNextcloudStatus("not_linked");
		fixture.detectChanges();
		await pressConnect(fixture);

		document.dispatchEvent(new Event("visibilitychange"));
		await flush();
		fixture.detectChanges();

		const button = (fixture.nativeElement as HTMLElement).querySelector("button");
		expect(button?.textContent ?? "").toContain("Connect Nextcloud");
	});
});

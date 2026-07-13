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
import { describe, expect, it, beforeEach } from "vitest";
import { ReauthBannerComponent } from "./reauth-banner.component";
import { ConnectionStateService } from "../../services/connection-state.service";

function setup() {
	TestBed.configureTestingModule({
		imports: [ReauthBannerComponent],
	});
	const fixture = TestBed.createComponent(ReauthBannerComponent);
	const connection = TestBed.inject(ConnectionStateService);
	fixture.detectChanges();
	return { fixture, connection };
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
});

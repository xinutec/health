import { Component, DestroyRef, inject, signal, ChangeDetectionStrategy } from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { errorText, stringField } from "../../narrow";
import { ConnectionStateService } from "../../services/connection-state.service";
import { HealthService } from "../../services/health.service";

type ConnectState = "idle" | "starting" | "waiting" | "success" | "failed";

/**
 * Top-of-page banner that appears when the user's Nextcloud
 * connection has expired and needs to be re-established.
 *
 * Uses Nextcloud's Login Flow v2 (the same protocol DAVx⁵ / KDE
 * Connect / the official NC apps use) to obtain a long-lived **app
 * password** — replacing the OAuth refresh-token flow that kept
 * flagging the row needs_reauth every few hours.
 *
 * Flow when the user clicks "Reconnect Nextcloud":
 *   1. POST /api/nextcloud/connect/init   → { loginUrl }
 *   2. Open loginUrl in a new tab (user grants access in NC's UI).
 *   3. When this page comes back to the front, re-read /api/me.
 *   4. Its durable connection status flips to "active" and the banner
 *      hides itself.
 *
 * No URL redirects, no callback rebound — everything stays in the
 * SPA.
 *
 * # Why step 3 is not a poll
 *
 * It was, until 2026-08-10: a 2s `setTimeout` loop against
 * /api/nextcloud/connect/status, to a five-minute deadline. Granting
 * access happens on NEXTCLOUD's page, which on a phone takes the
 * foreground and in a PWA/WebView can replace this document — so the
 * timer doing the watching is throttled or not running at all, and the
 * grant it is waiting for is never noticed. life shipped the identical
 * design and it failed on its first real use: the credential was stored
 * server-side while the card read "Waiting for approval" indefinitely,
 * having made exactly ONE status request, the one on page load.
 * DL-ANGULAR-OFFSITE-POLL now catches this shape; it found this file.
 *
 * Coming back is the event worth listening to, and it fires whether the
 * page was backgrounded, replaced, or never left at all.
 *
 * # And why it re-reads /api/me rather than the flow endpoint
 *
 * /api/nextcloud/connect/status reports an IN-MEMORY, single-shot flow
 * state: it deletes the entry once observed and knows nothing after a
 * server restart, so a late reader is told "idle" — indistinguishable
 * from never having started. /api/me reports the stored credential,
 * which is the durable fact and survives both.
 */
@Component({
	selector: "app-reauth-banner",
	standalone: true,
	imports: [MatButtonModule, MatIconModule, MatProgressSpinnerModule],
	templateUrl: "./reauth-banner.component.html",
	changeDetection: ChangeDetectionStrategy.OnPush,
	styleUrl: "./reauth-banner.component.scss",
})
export class ReauthBannerComponent {
	readonly connectionState = inject(ConnectionStateService);
	private readonly health = inject(HealthService);
	readonly state = signal<ConnectState>("idle");
	readonly errorMessage = signal<string>("");

	constructor() {
		const onReturn = (): void => {
			if (this.state() !== "waiting") return;
			if (document.visibilityState !== "visible") return;
			void this.settle();
		};
		document.addEventListener("visibilitychange", onReturn);
		window.addEventListener("focus", onReturn);
		inject(DestroyRef).onDestroy(() => {
			document.removeEventListener("visibilitychange", onReturn);
			window.removeEventListener("focus", onReturn);
		});
	}

	async reconnect(): Promise<void> {
		this.state.set("starting");
		try {
			const initRes = await fetch("/api/nextcloud/connect/init", { method: "POST" });
			if (!initRes.ok) throw new Error(`init returned ${initRes.status}`);
			const loginUrl = stringField(await initRes.json(), "loginUrl");
			if (loginUrl === null) throw new Error("init returned no login URL");
			// Open in a new tab so the user can grant access without
			// losing the dashboard context. Pop-up blockers normally
			// allow this because it's a direct response to a click.
			//
			// `noopener` also means there is no handle to close that tab with,
			// so Nextcloud's own "you can close this window" is the honest
			// instruction — a page that can reach back through `window.opener`
			// is worse than one closed by hand.
			window.open(loginUrl, "_blank", "noopener");
			this.state.set("waiting");
		} catch (e) {
			this.state.set("failed");
			this.errorMessage.set(errorText(e));
		}
	}

	/** Back here: ask whether the grant landed. */
	private async settle(): Promise<void> {
		// checkAuth re-reads /api/me and pushes the durable connection status
		// into ConnectionStateService — which is what hides this banner.
		await this.health.checkAuth();
		if (this.connectionState.nextcloudStatus() === "active") {
			this.state.set("success");
			return;
		}
		// Still not linked: the grant was abandoned, or is unfinished. Drop back
		// to idle so the button returns — leaving a spinner on a "waiting" that
		// nothing will ever end is a dead end with no way out of it.
		this.state.set("idle");
	}
}

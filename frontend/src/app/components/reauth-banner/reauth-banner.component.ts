import { Component, inject, signal, ChangeDetectionStrategy } from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { ConnectionStateService } from "../../services/connection-state.service";

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
 *   3. Poll /api/nextcloud/connect/status every 2s.
 *   4. On state="ready", connection-state flips to "active" and the
 *      banner hides itself.
 *
 * No URL redirects, no callback rebound — everything stays in the
 * SPA.
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
	readonly state = signal<ConnectState>("idle");
	readonly errorMessage = signal<string>("");

	async reconnect(): Promise<void> {
		this.state.set("starting");
		try {
			const initRes = await fetch("/api/nextcloud/connect/init", { method: "POST" });
			if (!initRes.ok) throw new Error(`init returned ${initRes.status}`);
			const { loginUrl } = (await initRes.json()) as { loginUrl: string };
			// Open in a new tab so the user can grant access without
			// losing the dashboard context. Pop-up blockers normally
			// allow this because it's a direct response to a click.
			window.open(loginUrl, "_blank", "noopener");
			this.state.set("waiting");
			await this.pollUntilDone();
		} catch (e) {
			this.state.set("failed");
			this.errorMessage.set((e as Error).message);
		}
	}

	private async pollUntilDone(): Promise<void> {
		// 5-min ceiling matches the backend's polling deadline.
		const deadline = Date.now() + 5 * 60 * 1000;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 2000));
			const res = await fetch("/api/nextcloud/connect/status");
			if (!res.ok) continue;
			const body = (await res.json()) as
				| { state: "idle" }
				| { state: "pending" }
				| { state: "ready"; loginName: string }
				| { state: "failed"; error: string };
			if (body.state === "ready") {
				this.connectionState.setNextcloudStatus("active");
				this.state.set("success");
				return;
			}
			if (body.state === "failed") {
				throw new Error(body.error);
			}
		}
		throw new Error("Timed out waiting for Nextcloud grant");
	}
}

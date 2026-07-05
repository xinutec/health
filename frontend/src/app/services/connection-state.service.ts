/**
 * Tracks the user's external connection state (Nextcloud, Fitbit) and
 * intercepts API responses to surface reauth needs to the UI.
 *
 * # Why this owns the fetch wrapper
 *
 * Every health-data endpoint can return HTTP 409 with
 * `{ error: "nextcloud_reauth_required" }` when the backend's token
 * manager determines that the user's NC refresh token has been
 * permanently rejected. We can't predict which endpoint will be the
 * one to surface it (they call in parallel), so the interception lives
 * in a single shared wrapper. When any response carries that error,
 * the service flips `nextcloudStatus` and the global banner appears
 * regardless of which page the user is on.
 *
 * The `/api/me` payload also seeds the initial state on app-load so
 * the banner can render before the user even triggers a data request.
 */

import { Injectable, signal } from "@angular/core";

export type ConnectionStatus = "active" | "needs_reauth" | "not_linked" | "unknown";

@Injectable({ providedIn: "root" })
export class ConnectionStateService {
	readonly nextcloudStatus = signal<ConnectionStatus>("unknown");
	readonly fitbitStatus = signal<ConnectionStatus>("unknown");

	setNextcloudStatus(s: ConnectionStatus): void {
		this.nextcloudStatus.set(s);
	}

	setFitbitStatus(s: ConnectionStatus): void {
		this.fitbitStatus.set(s);
	}

	/** Wrap `fetch` to intercept connection-state signals from the API.
	 *  Any 409 carrying `error: "nextcloud_reauth_required"` flips the
	 *  Nextcloud status to `needs_reauth`; the global banner then renders.
	 *  Other responses pass through unchanged. */
	async fetch(input: string, init?: RequestInit): Promise<Response> {
		const res = await fetch(input, init);
		if (res.status === 409) {
			// Clone so callers can still read the body if they want to.
			try {
				const body = await res.clone().text();
				const parsed = body.length > 0 ? (JSON.parse(body) as { error?: string }) : null;
				if (parsed?.error === "nextcloud_reauth_required") {
					this.setNextcloudStatus("needs_reauth");
				}
			} catch {
				// 409 without parseable JSON — ignore the signal extraction.
			}
		}
		return res;
	}
}

/**
 * Nextcloud app-password credentials store.
 *
 * Replaces `token-manager.ts` for new code. App passwords (from
 * NC's Login Flow v2) are long-lived single credentials — no
 * expiry, no refresh, no token rotation. Used as HTTP Basic Auth on
 * every request.
 *
 * The old OAuth flow had a cross-pod refresh race: the auth pod
 * and the sync cron pod each independently noticed "expires soon",
 * both fired refresh, and the loser hit "invalid refresh token"
 * because NC's OAuth2 app rotates the refresh token single-use.
 * App passwords sidestep the entire problem by not refreshing.
 *
 * This module is intentionally CRUD-only — no mutex, no cache, no
 * in-flight promises. Loads are cheap (one row by PK); whatever
 * caching the velocity-cache and friends do at higher layers is
 * enough.
 *
 * # Errors
 *
 *   - `NextcloudNotLinkedError` — no row in `nc_credentials`. The
 *     user has not completed the Login Flow v2 yet.
 *   - `NextcloudReauthRequiredError` — row exists but
 *     `status='needs_reauth'`. The user revoked the app password
 *     in NC's Security settings, or our code marked it bad after
 *     a 401 from a request.
 */

import { db } from "../db/pool.js";

/** What every NC request needs to build an Authorization header. */
export interface NcCredentials {
	loginName: string;
	appPassword: string;
}

/** Thrown when the user has no `nc_credentials` row, i.e. they have
 *  not yet linked a Nextcloud account via Login Flow v2. */
export class NextcloudNotLinkedError extends Error {
	constructor() {
		super("Nextcloud not linked");
		this.name = "NextcloudNotLinkedError";
	}
}

/** Thrown when the stored credentials are flagged invalid (revoked
 *  app password, deleted from NC's Security settings, etc.). The
 *  user has to re-run Login Flow v2. */
export class NextcloudReauthRequiredError extends Error {
	constructor() {
		super("Nextcloud app password no longer valid — relink required");
		this.name = "NextcloudReauthRequiredError";
	}
}

/** Load the credentials for `userId`. Throws if absent or marked
 *  needs_reauth. Callers should let the typed errors propagate to
 *  the route handler, which surfaces them to the SPA. */
export async function getCredentials(userId: string): Promise<NcCredentials> {
	const row = await db()
		.selectFrom("nc_credentials")
		.select(["login_name", "app_password", "status"])
		.where("user_id", "=", userId)
		.executeTakeFirst();
	if (!row) throw new NextcloudNotLinkedError();
	if (row.status === "needs_reauth") throw new NextcloudReauthRequiredError();
	return { loginName: row.login_name, appPassword: row.app_password };
}

/** Upsert credentials. Used by the Login Flow v2 completion handler
 *  once NC has confirmed the user granted access. Overwrites any
 *  previous app password for the same user. */
export async function storeCredentials(userId: string, creds: NcCredentials): Promise<void> {
	await db()
		.insertInto("nc_credentials")
		.values({
			user_id: userId,
			login_name: creds.loginName,
			app_password: creds.appPassword,
			status: "active",
		})
		.onDuplicateKeyUpdate({
			login_name: creds.loginName,
			app_password: creds.appPassword,
			status: "active",
		})
		.execute();
}

/** Flag the credentials as `needs_reauth`. Called when a 401 from a
 *  NC request signals the app password was revoked. */
export async function markNeedsReauth(userId: string): Promise<void> {
	await db().updateTable("nc_credentials").set({ status: "needs_reauth" }).where("user_id", "=", userId).execute();
}

export type ConnectionStatus = "active" | "needs_reauth" | "not_linked";

/** Cheap status read for /api/me — no NC round-trip. */
export async function getConnectionStatus(userId: string): Promise<ConnectionStatus> {
	const row = await db()
		.selectFrom("nc_credentials")
		.select(["status"])
		.where("user_id", "=", userId)
		.executeTakeFirst();
	if (!row) return "not_linked";
	if (row.status === "needs_reauth") return "needs_reauth";
	return "active";
}

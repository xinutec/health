import * as crypto from "node:crypto";

export interface PendingOAuth {
	createdAt: number;
	userId?: string;
	codeVerifier?: string;
	/** Optional internal path to redirect to after a successful callback.
	 *  Validated at consume-time against an allowlist to prevent open
	 *  redirects, so it's safe to round-trip via this map even though the
	 *  caller controls the input. */
	returnTo?: string;
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const pending = new Map<string, PendingOAuth>();

export function createState(extra?: Partial<PendingOAuth>): string {
	const state = crypto.randomBytes(24).toString("hex");
	pending.set(state, { createdAt: Date.now(), ...extra });

	// Prune expired entries
	for (const [key, val] of pending) {
		if (Date.now() - val.createdAt > TTL_MS) pending.delete(key);
	}

	return state;
}

export function consumeState(state: string): PendingOAuth | null {
	const entry = pending.get(state);
	if (!entry) return null;
	pending.delete(state);
	if (Date.now() - entry.createdAt > TTL_MS) return null;
	return entry;
}

// For testing
export function clearAllStates(): void {
	pending.clear();
}

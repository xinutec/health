/**
 * Always-on front-end diagnostics that POST to /api/client-log so
 * the backend can surface them via `kubectl logs`. Two purposes:
 *
 *   - `installErrorReporting(health)` hooks the browser's `error`
 *     and `unhandledrejection` events. Anything Angular doesn't
 *     handle (component lifecycle throws, fetch failures that
 *     escape try/catch, bundle-load errors) lands on stdout where
 *     we'd otherwise never see it.
 *
 *   - `logBootContext(health)` emits a single event on app start
 *     with the user-agent, viewport, screen, tz, and locale. Lets a
 *     future "the dashboard looks weird" report be diagnosed
 *     without first asking what browser / screen / tz / language.
 *
 * Both go through `HealthService.clientLog`, which is best-effort —
 * network failures on the diagnostic path never break the UI.
 *
 * Throttling: error handlers can fire in tight loops (a render bug
 * inside a CD cycle can throw on every animation frame). We dedupe
 * by signature (message + filename + line) and emit at most one
 * event per minute per signature so a hot-loop bug can't hammer
 * the backend.
 */

import type { HealthService } from "./services/health.service";

const THROTTLE_WINDOW_MS = 60_000;

interface ErrorReporter {
	healthRef: HealthService;
	/** Signature → last-emitted ms. Drops entries older than the
	 *  throttle window so the map can't grow unbounded under a
	 *  steady stream of unique errors. */
	lastEmitted: Map<string, number>;
}

let reporter: ErrorReporter | null = null;

export function installErrorReporting(health: HealthService): void {
	// Idempotent — calling twice (e.g. due to test re-init) doesn't
	// stack listeners.
	if (reporter) {
		reporter.healthRef = health;
		return;
	}
	reporter = { healthRef: health, lastEmitted: new Map() };

	window.addEventListener("error", (e: ErrorEvent) => {
		const sig = `${truncate(e.message, 200)}|${e.filename ?? ""}|${e.lineno ?? 0}`;
		if (!shouldEmit(sig)) return;
		// `ErrorEvent.error` is `any` — anything can be thrown. Only an Error
		// carries a stack.
		const thrown: unknown = e.error;
		void reporter?.healthRef.clientLog("uncaught-error", {
			message: truncate(e.message, 200),
			filename: truncate(e.filename ?? "", 200),
			line: e.lineno ?? 0,
			col: e.colno ?? 0,
			stack: truncate(thrown instanceof Error ? (thrown.stack ?? "") : "", 1500),
		});
	});

	window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
		const reason: unknown = e.reason;
		const message = reason instanceof Error ? reason.message : String(reason);
		const stack = reason instanceof Error ? (reason.stack ?? "") : "";
		const sig = `rejection|${truncate(message, 200)}`;
		if (!shouldEmit(sig)) return;
		void reporter?.healthRef.clientLog("unhandled-rejection", {
			message: truncate(message, 200),
			stack: truncate(stack, 1500),
		});
	});
}

export function logBootContext(health: HealthService): void {
	void health.clientLog("app-boot", {
		ua: truncate(navigator.userAgent, 200),
		viewport: { w: window.innerWidth, h: window.innerHeight },
		screen: { w: window.screen.width, h: window.screen.height },
		dpr: window.devicePixelRatio,
		tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
		locale: navigator.language,
	});
}

function shouldEmit(signature: string): boolean {
	if (!reporter) return false;
	const now = Date.now();
	const last = reporter.lastEmitted.get(signature);
	if (last !== undefined && now - last < THROTTLE_WINDOW_MS) return false;
	reporter.lastEmitted.set(signature, now);
	// Periodically prune stale signatures so a long session doesn't
	// accumulate a Map entry per unique error message ever seen.
	if (reporter.lastEmitted.size > 100) {
		for (const [k, v] of reporter.lastEmitted) {
			if (now - v > THROTTLE_WINDOW_MS) reporter.lastEmitted.delete(k);
		}
	}
	return true;
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

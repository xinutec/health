import { DOCUMENT, Injectable, inject } from "@angular/core";
import { NavigationEnd, Router } from "@angular/router";
import { filter } from "rxjs";

/** One thing that happened in the client. `kind` is "nav" (a route change, no
 *  label) or "tap" (a control, `label` its visible text verbatim). `at` is the
 *  client's clock in epoch ms — a batch arrives at once, so the server's receive
 *  time cannot order the events inside it and the client's can. */
export interface TelemetryEvent {
	kind: string;
	path: string;
	label: string | null;
	at: number;
}

/**
 * The verbatim label of the nearest interactive ancestor of `node`.
 *
 * Returns null when the tap did not land on or inside a control, which is what
 * keeps the trace to things a person meant to do. Reuses the accessible name
 * already on screen — aria-label, then trimmed text, then a title — so nothing
 * needs a bespoke tracking attribute and no control can be instrumented wrongly
 * by being forgotten.
 *
 * Exported for its own test.
 */
export function labelFor(node: EventTarget | null): string | null {
	if (!(node instanceof Element)) return null;
	const el = node.closest(
		'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="switch"], input[type="submit"]',
	);
	if (!el) return null;
	const aria = el.getAttribute("aria-label")?.trim();
	if (aria) return aria;

	// Read the visible label minus the decorative parts. A Material icon renders
	// its ligature *name* as text, so an icon+label control would otherwise log
	// "refreshRefresh"; and aria-hidden content is by definition not part of what
	// the control says. Stripped on a clone, so the live DOM is untouched.
	const clone = el.cloneNode(true);
	let text = "";
	if (clone instanceof Element) {
		clone.querySelectorAll('mat-icon, [aria-hidden="true"]').forEach((n) => n.remove());
		text = (clone.textContent ?? "").replace(/\s+/g, " ").trim();
	}
	if (text) return text;
	return el.getAttribute("title")?.trim() ?? null;
}

/**
 * What the person did, folded into the backend's log beside what the API saw.
 *
 * **Distinct from `client-diagnostics`**, which reports errors and boot context.
 * This reports *activity*: a tap that hits a cache, a control that was disabled,
 * a screen that rendered wrong — none of it reaches the server otherwise, so a
 * report of "I pressed it and nothing happened" is undiagnosable. The two
 * channels answer different questions and both go to the same stdout.
 *
 * **Instrumented once, here.** Two central seams — the router's navigation
 * events, and a single capture-phase click listener — so no page knows this
 * exists and no new control can be missed by forgetting to annotate it.
 *
 * Best-effort by design: a failed send is dropped, never retried, never
 * surfaced. A trace that interferes with the app it observes is worse than no
 * trace at all.
 */
@Injectable({ providedIn: "root" })
export class Telemetry {
	private readonly router = inject(Router);
	private readonly doc = inject(DOCUMENT);

	private queue: TelemetryEvent[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;

	/** How often the queue is sent. */
	private static readonly FLUSH_MS = 5000;
	/** Queue length that forces an early flush, so a burst cannot grow it
	 *  without bound between ticks. */
	private static readonly MAX_QUEUE = 50;

	/** Wire the two capture points. Called once from the app shell; idempotent. */
	init(): void {
		if (this.timer !== null) return;

		this.router.events
			.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
			.subscribe((e) => this.enqueue("nav", e.urlAfterRedirects, null));

		// Capture phase, so the tap is seen even where a handler stops propagation.
		this.doc.addEventListener(
			"click",
			(ev) => {
				const label = labelFor(ev.target);
				if (label !== null) this.enqueue("tap", this.router.url, label);
			},
			{ capture: true },
		);

		this.timer = setInterval(() => this.flush(false), Telemetry.FLUSH_MS);

		// A last flush when the page is hidden, so the final few events are not
		// stranded in the queue by a tab being closed mid-batch.
		this.doc.addEventListener("visibilitychange", () => {
			if (this.doc.visibilityState === "hidden") this.flush(true);
		});
	}

	private enqueue(kind: string, path: string, label: string | null): void {
		this.queue.push({ kind, path, label, at: Date.now() });
		if (this.queue.length >= Telemetry.MAX_QUEUE) this.flush(false);
	}

	private flush(final: boolean): void {
		if (this.queue.length === 0) return;
		const batch = this.queue;
		this.queue = [];
		// On hiding, `sendBeacon` survives a teardown an in-flight request would
		// not; otherwise a plain fetch, matching how the rest of this frontend
		// talks to the backend. Errors swallowed on both paths.
		if (final && this.doc.defaultView?.navigator.sendBeacon) {
			this.doc.defaultView.navigator.sendBeacon(
				"/api/telemetry",
				new Blob([JSON.stringify(batch)], { type: "application/json" }),
			);
			return;
		}
		void fetch("/api/telemetry", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(batch),
		}).catch(() => {
			// Best-effort — never let the trace break the dashboard.
		});
	}
}

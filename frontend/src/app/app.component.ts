import { Component, computed, effect, inject, signal, ChangeDetectionStrategy } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { NavigationEnd, Router, RouterLink, RouterOutlet } from "@angular/router";
import { filter, map, startWith } from "rxjs/operators";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatSnackBar, MatSnackBarModule } from "@angular/material/snack-bar";
import { MatToolbarModule } from "@angular/material/toolbar";
import { MatTooltipModule } from "@angular/material/tooltip";
import { ReauthBannerComponent } from "./components/reauth-banner/reauth-banner.component";
import { HealthService } from "./services/health.service";
import { installErrorReporting } from "./client-diagnostics";

/** What kind of view the current URL maps to. Drives toolbar
 *  controls visibility (the share button, gear and Logout disappear
 *  in share mode; the reauth banner hides too — the recipient has
 *  no path to fix the owner's connection). */
type AppMode = "dashboard" | "settings" | "share";

@Component({
	selector: "app-root",
	standalone: true,
	imports: [
		MatToolbarModule,
		MatButtonModule,
		MatIconModule,
		MatSnackBarModule,
		MatTooltipModule,
		RouterLink,
		RouterOutlet,
		ReauthBannerComponent,
	],
	templateUrl: "./app.component.html",
	changeDetection: ChangeDetectionStrategy.OnPush,
	styleUrl: "./app.component.scss",
})
export class AppComponent {
	readonly health = inject(HealthService);
	private readonly router = inject(Router);

	/** Mirror of `router.url` as a signal, recomputed on every
	 *  NavigationEnd. `startWith(router.url)` seeds the value so
	 *  the toolbar renders correctly on first paint. */
	private readonly url = toSignal(
		this.router.events.pipe(
			filter((e): e is NavigationEnd => e instanceof NavigationEnd),
			map((e) => e.urlAfterRedirects),
			startWith(this.router.url),
		),
		{ initialValue: this.router.url },
	);

	readonly mode = computed<AppMode>(() => {
		const u = this.url();
		if (u.startsWith("/share/")) return "share";
		if (u === "/settings" || u.startsWith("/settings?") || u.startsWith("/settings/")) return "settings";
		return "dashboard";
	});

	private readonly snackBar = inject(MatSnackBar);

	/** The share link for the toolbar quick-copy button, or null while
	 *  no share link is active.
	 *
	 *  A share link is, by definition, "the view I'm looking at, handed to
	 *  someone else." The dashboard already round-trips its whole view
	 *  state through the URL query string and restores from it on load, so
	 *  the URL *is* the canonical view — and the share link is just that
	 *  URL with the path swapped to the share token: the current query
	 *  string carried verbatim onto `s.url`. No allowlist to maintain, so
	 *  any view param the dashboard adds (date, tab, trendDays, …) rides
	 *  along automatically and none can silently drop out of sync. */
	readonly shareUrl = computed<string | null>(() => {
		const s = this.health.shareStatus();
		if (!s?.active || !s.url) return null;
		const u = this.url();
		const qIdx = u.indexOf("?");
		return qIdx < 0 ? s.url : s.url + u.slice(qIdx);
	});

	/** Short commit SHA of the RUNNING BACKEND image (from /version), shown
	 *  in the footer so a stale deploy/client is visible at a glance — the same
	 *  bottom-note pattern as the recall web app. null until loaded; "dev" on a
	 *  local non-docker run. */
	readonly version = signal<string | null>(null);

	constructor() {
		// Install browser error/unhandledrejection listeners up-front so
		// any failure during auth or initial render still gets reported.
		installErrorReporting(this.health);

		// One unauthenticated fetch; failure just leaves the footer empty.
		fetch("/version")
			.then((r) => (r.ok ? r.json() : null))
			.then((v: { sha?: string } | null) => {
				if (v?.sha) this.version.set(v.sha.slice(0, 7));
			})
			.catch(() => {});

		// Load the owner's share status once the user is known, so the
		// toolbar can offer a quick-copy button. Skipped in share mode:
		// /api/share is owner-only and a recipient has no link to copy.
		effect(() => {
			if (this.health.user() && this.mode() !== "share" && this.health.shareStatus() === null) {
				this.health.refreshShareStatus().catch(() => {
					// Non-fatal — the Settings page remains the reliable path.
				});
			}
		});
	}

	/** Copy a share link to the clipboard with a transient
	 *  confirmation. The link carries the day and tab currently open
	 *  (see `shareUrl`) so the recipient lands on the same view. */
	async copyShareLink(url: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(url);
			this.snackBar.open("Share link copied", "Dismiss", { duration: 2000 });
		} catch {
			this.snackBar.open("Could not copy — open Settings to copy the link.", "Dismiss", { duration: 4000 });
		}
	}
}

import { Routes } from "@angular/router";
import { DashboardComponent } from "./components/dashboard/dashboard.component";
import { SettingsComponent } from "./components/settings/settings.component";

/**
 * Routes for the SPA.
 *
 *   /                  → owner's dashboard
 *   /share/:token      → recipient's dashboard (same component; reads
 *                        the token from the route param and stashes it
 *                        on HealthService so X-Share-Token is attached
 *                        to all API calls)
 *   /settings          → settings page (currently just the share-link
 *                        manager)
 *
 * The share-mode dashboard and the owner dashboard are the SAME
 * component — every visual difference is driven by `shareWindow`
 * coming back from /api/me and by what the server gates server-side.
 *
 * The server (Hono) has matching SPA-fallback rules at /share/:token
 * and /settings so the SPA shell is served on a direct hit.
 */
export const routes: Routes = [
	{ path: "", pathMatch: "full", component: DashboardComponent },
	{ path: "share/:token", component: DashboardComponent },
	{ path: "settings", component: SettingsComponent },
	{ path: "**", redirectTo: "" },
];

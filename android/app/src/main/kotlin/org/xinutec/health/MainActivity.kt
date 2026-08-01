package org.xinutec.health

import org.xinutec.shell.ShellConfig
import org.xinutec.shell.WebDebugging
import org.xinutec.shell.WebShellActivity

/**
 * The health dashboard — the Angular app served at [HEALTH_URL], in the fleet's
 * shared [WebShellActivity]. The site is behind a login (Nextcloud OAuth); the
 * WebView keeps the session cookie, so it's a one-time sign-in.
 *
 * Nothing here but what the app is: everything a wrapper does lives in the shell.
 */
class MainActivity : WebShellActivity() {
    override val shell =
        ShellConfig(
            url = HEALTH_URL,
            // The dashboard plus the Nextcloud login hop — without the second, the
            // OAuth round-trip would be ejected to the browser and the app could
            // never sign in again. Everything else opens in the real browser.
            allowedHosts = setOf("health.xinutec.org", NC_HOST),
            // Forward the web app's console (console.log/warn/error and uncaught JS
            // errors) to logcat: `adb logcat -s HealthWeb`.
            consoleTag = "HealthWeb",
            // Expose the WebView to the Chrome DevTools protocol over adb
            // (chrome://inspect, or scripts/webview-inspect.py): live console, DOM,
            // network and JS evaluation against the running dashboard. Gated to
            // debuggable builds so a release build never opens itself to inspection.
            webDebugging = WebDebugging.DEBUG_BUILDS,
        )

    private companion object {
        // The health dashboard (HTTPS, behind a Nextcloud-OAuth login).
        const val HEALTH_URL = "https://health.xinutec.org/"

        // The Nextcloud identity provider the login bounces through.
        const val NC_HOST = "dash.xinutec.org"
    }
}

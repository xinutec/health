package org.xinutec.health

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * A full-screen [WebView] onto the health dashboard — the Angular app served at
 * [HEALTH_URL]. No address bar, no tabs, a home-screen icon: the dashboard
 * presented as an app, avoiding browser chrome. The site is behind a login
 * (Nextcloud OAuth); the WebView keeps the session cookie, so it's a one-time
 * sign-in.
 *
 * Deliberately tiny — a plain Activity holding one WebView, no Compose/AppCompat.
 * `configChanges` keeps the WebView (and its route + scroll) across rotation.
 *
 * The WebView is inset from the system bars by padding a wrapper (see onCreate),
 * and the strips behind the bars are painted with the page's own surface colour.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var root: FrameLayout

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("viewer", Context.MODE_PRIVATE)
        web =
            WebView(this).apply {
                layoutParams =
                    ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                settings.javaScriptEnabled = true // Angular needs JS
                settings.domStorageEnabled = true // localStorage / sessionStorage
                settings.useWideViewPort = true
                settings.loadWithOverviewMode = true
                // Keep every navigation inside this WebView — never hand off to a
                // browser — and remember the current in-app page so a cold reopen
                // returns to it (SPA route changes fire doUpdateVisitedHistory too).
                webViewClient =
                    object : WebViewClient() {
                        override fun doUpdateVisitedHistory(
                            view: WebView,
                            url: String,
                            isReload: Boolean,
                        ) {
                            super.doUpdateVisitedHistory(view, url, isReload)
                            if (url.startsWith(HEALTH_URL)) {
                                prefs.edit().putString(KEY_LAST_URL, url).apply()
                            }
                        }

                        // Paint the strips behind the system bars with the web UI's
                        // own surface colour instead of a hardcoded black; it follows
                        // the page's light/dark theme, so read its body background.
                        override fun onPageFinished(view: WebView, url: String) {
                            super.onPageFinished(view, url)
                            view.evaluateJavascript(
                                "getComputedStyle(document.body).backgroundColor",
                            ) { result -> parseCssColor(result)?.let(root::setBackgroundColor) }
                        }
                    }
                // Forward the web app's console (console.log/warn/error and uncaught
                // JS errors) to logcat under [WEB_TAG]. WebView only surfaces these
                // through a WebChromeClient — without one, the dashboard's own
                // diagnostics never leave the WebView. Read them with:
                //   adb logcat -s HealthWeb
                webChromeClient =
                    object : WebChromeClient() {
                        override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                            val line = "${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})"
                            when (msg.messageLevel()) {
                                ConsoleMessage.MessageLevel.ERROR -> Log.e(WEB_TAG, line)
                                ConsoleMessage.MessageLevel.WARNING -> Log.w(WEB_TAG, line)
                                ConsoleMessage.MessageLevel.DEBUG -> Log.d(WEB_TAG, line)
                                else -> Log.i(WEB_TAG, line)
                            }
                            return true
                        }
                    }
                // Black until the page loads and reports its surface colour; avoids a
                // white flash on launch.
                setBackgroundColor(Color.BLACK)
            }
        // Inset the WebView from the system bars by padding a wrapper ViewGroup
        // (WebView.setPadding() doesn't offset content under wide-viewport mode).
        // Once the WebView no longer underlaps the bars its env(safe-area-inset-*)
        // collapse to 0, so the page's own safe-area CSS adds nothing on top.
        root =
            FrameLayout(this).apply {
                addView(web)
                setBackgroundColor(Color.BLACK)
            }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
        // Reopen where we left off; the hardcoded URL is only the first-run default.
        web.loadUrl(prefs.getString(KEY_LAST_URL, null) ?: HEALTH_URL)
    }

    // Back walks the SPA's history; it only leaves the app once there's nothing
    // left to go back to.
    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    // evaluateJavascript hands back the JSON-encoded result, e.g. the string
    // "rgb(18, 18, 18)" (with quotes) or "rgba(18, 18, 18, 1)". Pull out the RGB
    // triple; alpha is ignored (the surface is opaque). null if it can't be read.
    private fun parseCssColor(raw: String?): Int? {
        val m = raw?.let { Regex("""rgba?\((\d+),\s*(\d+),\s*(\d+)""").find(it) } ?: return null
        val (r, g, b) = m.destructured
        return Color.rgb(r.toInt(), g.toInt(), b.toInt())
    }

    companion object {
        // The health dashboard (HTTPS, behind a Nextcloud-OAuth login).
        private const val HEALTH_URL = "https://health.xinutec.org/"
        private const val KEY_LAST_URL = "last_url"

        // logcat tag for forwarded WebView console messages (`adb logcat -s HealthWeb`).
        private const val WEB_TAG = "HealthWeb"
    }
}

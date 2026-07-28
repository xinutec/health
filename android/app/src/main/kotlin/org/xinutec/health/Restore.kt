package org.xinutec.health

/**
 * Which pages may become the app's restore point — the URL a cold launch reopens on.
 *
 * Only pages of the app itself. The OAuth hops (`/login`, `/auth/callback`) are
 * transient: the callback carries a **one-shot** authorization code, so replaying it
 * always fails. Saving one as the restore point turns a single failed login into a
 * permanent one — every launch reloads a spent callback, is refused, and never reaches
 * the app to try again. That is not hypothetical: it happened to the fleetwatch wrapper
 * on the Pixel 9 (2026-07-28), which could not recover on its own.
 */
object Restore {
    /** First path segments that belong to the login round-trip, not to the app. */
    private val TRANSIENT = setOf("login", "logout", "auth")

    /** True if [url] is a page of the app worth reopening on. */
    fun isRestorable(base: String, url: String): Boolean {
        // Compare on a path boundary, so a look-alike host (…xinutec.org.evil.test)
        // can't pass as the app just by sharing a prefix. Tolerates a [base] written
        // with or without its trailing slash.
        val root = base.removeSuffix("/")
        if (url != root && !url.startsWith("$root/")) return false
        val path = url.removePrefix(root).removePrefix("/")
        // Match on the whole first segment, so a page called "logins" still restores.
        val head = path.substringBefore('?').substringBefore('#').substringBefore('/')
        return head !in TRANSIENT
    }
}

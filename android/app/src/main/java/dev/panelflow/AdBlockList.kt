package dev.panelflow

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * The blocked-host set, read from the same `extension/rules/adblock.json` the
 * Chrome extension loads as a declarativeNetRequest ruleset.
 *
 * Chrome consumes that file as rules; Android has no rule engine, so the hosts
 * are pulled out of it and matched by hand in [MangaWebViewClient]. One source
 * file, two consumers — updating the list updates both platforms.
 */
object AdBlockList {

    private var cached: Set<String>? = null

    fun hosts(context: Context): Set<String> = cached ?: load(context).also { cached = it }

    private fun load(context: Context): Set<String> = runCatching {
        val text = context.assets.open("rules/adblock.json").bufferedReader().use { it.readText() }
        val rules = JSONArray(text)
        buildSet {
            for (i in 0 until rules.length()) {
                val filter = rules.optJSONObject(i)
                    ?.optJSONObject("condition")
                    ?.optString("urlFilter")
                    .orEmpty()
                hostOf(filter)?.let { add(it) }
            }
        }
    }.getOrElse { emptySet() }

    /**
     * declarativeNetRequest writes a host rule as `||example.com^`. Anything
     * else in that file is a path or wildcard pattern that host matching cannot
     * express, and silently half-applying it would block more than the rule
     * meant — so those are skipped rather than approximated.
     */
    private fun hostOf(filter: String): String? {
        if (!filter.startsWith("||")) return null
        val host = filter.removePrefix("||").substringBefore('^').substringBefore('/')
        return host.takeIf { it.isNotEmpty() && !it.contains('*') && it.contains('.') }
    }

    /** Sites the user chose to stop blocking on, stored by the shared core. */
    fun whitelist(): Set<String> = Settings.adblockWhitelist
}

/**
 * The handful of settings native itself needs before, or without, the worker.
 *
 * Deliberately a cache and not a second source of truth: the shared core owns
 * every setting, and this is refreshed from it. Native reads it when it has to
 * act synchronously (a request interceptor cannot await a bridge round-trip),
 * or before the worker exists at all (WorkManager is scheduled from
 * `Application.onCreate`, which is why the interval is also written to disk).
 */
object Settings {

    /**
     * How often to look for new chapters, when nobody has said otherwise yet.
     *
     * A copy of `ACCOUNT_PREFS.checkIntervalMin.fallback` in shared/prefs.js,
     * kept because Kotlin cannot read that file at compile time — the same
     * reason `build.gradle.kts` carries the backend URL. It is anchored to the
     * shared value by `backend/test/mobile-shell.test.js`.
     */
    const val DEFAULT_CHECK_INTERVAL_MIN = 360L

    private const val STORE = "panelflow-native"
    private const val KEY_INTERVAL = "checkIntervalMin"

    @Volatile var adblockWhitelist: Set<String> = emptySet()
    @Volatile var backendUrl: String = BuildConfig.BACKEND_URL

    /** Minutes between background chapter checks. See [ChapterCheckWorker]. */
    @Volatile var checkIntervalMin: Long = DEFAULT_CHECK_INTERVAL_MIN
        private set

    /**
     * What the reader last chose, read back before the worker can say it.
     *
     * The alternative is to schedule at the default and correct it a second
     * later, which on a phone means every cold start rebuilding the schedule
     * and the check never coming due.
     */
    fun load(context: Context) {
        checkIntervalMin = store(context).getLong(KEY_INTERVAL, DEFAULT_CHECK_INTERVAL_MIN)
    }

    /**
     * Take one reply — `getSettings` or `pullAccountPrefs`.
     *
     * @return true when the check interval actually changed, i.e. when the
     *         caller has to rebuild the schedule — see [ChapterCheckWorker].
     */
    fun apply(context: Context, body: JSONObject): Boolean {
        // The hub wraps its answers, and the two wrappers are not one bag.
        // `getSettings` carries this *device's* checkIntervalMin, which is the
        // core's default and never the reader's answer; the account's copy
        // comes back in `prefs`. Read together, whichever reply landed second
        // would win, and half the time that is 360 overwriting "every hour".
        body.optJSONObject("settings")?.let { settings ->
            settings.optString("backendUrl").takeIf { it.isNotEmpty() }?.let { backendUrl = it }
        }
        val prefs = body.optJSONObject("prefs") ?: return false

        // Same key the extension's options page writes — one settings shape.
        prefs.optJSONArray("whitelist")?.let { arr ->
            adblockWhitelist = buildSet {
                for (i in 0 until arr.length()) arr.optString(i).takeIf { it.isNotEmpty() }?.let { add(it) }
            }
        }
        val minutes = prefs.optLong("checkIntervalMin", 0L)
        if (minutes <= 0L || minutes == checkIntervalMin) return false
        checkIntervalMin = minutes
        store(context).edit().putLong(KEY_INTERVAL, minutes).apply()
        return true
    }

    private fun store(context: Context) =
        context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
}

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
 * act synchronously (a request interceptor cannot await a bridge round-trip).
 */
object Settings {
    @Volatile var adblockWhitelist: Set<String> = emptySet()
    @Volatile var backendUrl: String = BuildConfig.BACKEND_URL

    fun apply(settings: JSONObject) {
        settings.optString("backendUrl").takeIf { it.isNotEmpty() }?.let { backendUrl = it }
        // Same key the extension's options page writes — one settings shape.
        settings.optJSONArray("whitelist")?.let { arr ->
            adblockWhitelist = buildSet {
                for (i in 0 until arr.length()) arr.optString(i).takeIf { it.isNotEmpty() }?.let { add(it) }
            }
        }
    }
}

package dev.panelflow

import android.content.Context

/**
 * The scripts injected into pages the user browses — the same files the Chrome
 * extension ships, in the same order its manifest lists them.
 *
 * They are read from the APK's assets, where the Gradle `bundleWebAssets` task
 * put them, straight from `extension/content/`. Nothing is forked or adapted:
 * `chrome-shim.js` provides the five `chrome.*` APIs they use and that is the
 * entire mobile-specific layer. If reader behaviour differs between the phone
 * and the browser, it is a bug in the shim, not a difference in the reader.
 */
object PageScripts {

    /**
     * Injected as early as the WebView allows. `popup-guard.js` neuters the
     * `window.open` storms scan sites fire on first tap, so it is worth
     * nothing if it lands after the page has already opened them.
     */
    private val EARLY = listOf("inject/popup-guard.js", "inject/chrome-shim.js")

    /** The engine, once there is a document for it to look at. */
    private val LATE = listOf(
        "inject/series-match.js",
        "inject/site-rules.js",
        "inject/detect.js",
        "inject/library-modal.js",
        "inject/reader.js",
    )

    private var earlyBlob: String? = null
    private var lateBlob: String? = null

    fun early(context: Context): String =
        earlyBlob ?: concat(context, EARLY).also { earlyBlob = it }

    fun late(context: Context): String =
        lateBlob ?: (concat(context, LATE) + styleInjector(read(context, "inject/reader.css")))
            .also { lateBlob = it }

    // Each file is wrapped so a failure in one does not stop the next: a scan
    // site that breaks detect.js must not also cost the user the reader.
    private fun concat(context: Context, names: List<String>): String =
        names.joinToString("\n") { name ->
            "try{\n${read(context, name)}\n}catch(e){console.warn('panelflow: $name failed',e)}"
        }

    // The extension gets reader.css from its manifest; here it has to be put in
    // by hand, and idempotently — this runs again on every SPA navigation.
    private fun styleInjector(css: String): String = """
        try{
          if(!document.getElementById('panelflow-reader-css')){
            var s=document.createElement('style');
            s.id='panelflow-reader-css';
            s.textContent=${WorkerHost.quote(css)};
            (document.head||document.documentElement).appendChild(s);
          }
        }catch(e){console.warn('panelflow: reader.css failed',e)}
    """.trimIndent()

    private fun read(context: Context, name: String): String =
        runCatching {
            context.assets.open(name).bufferedReader().use { it.readText() }
        }.getOrElse { "/* missing asset: $name */" }
}

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
     *
     * `report-failure.js` comes first because it is what every other file's
     * catch clause calls — including, at the cost of nothing but a console
     * line, its own.
     */
    private val EARLY = listOf(
        "inject/report-failure.js",
        "inject/popup-guard.js",
        "inject/chrome-shim.js",
    )

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
    //
    // A file missing from the APK is thrown, not commented out, so that the one
    // build mistake nobody would ever notice — an asset silently absent — comes
    // out of the same pipe as a script that blew up on the page.
    private fun concat(context: Context, names: List<String>): String =
        names.joinToString("\n") { name ->
            val source = read(context, name).ifEmpty { "throw new Error('missing from the build');" }
            "try{\n$source\n}catch(e){${report(name, "e")}}"
        }

    // The extension gets reader.css from its manifest; here it has to be put in
    // by hand, and idempotently — this runs again on every SPA navigation.
    private fun styleInjector(css: String): String =
        if (css.isEmpty()) {
            "try{throw new Error('missing from the build')}catch(e){${report("inject/reader.css", "e")}}"
        } else {
            """
            try{
              if(!document.getElementById('panelflow-reader-css')){
                var s=document.createElement('style');
                s.id='panelflow-reader-css';
                s.textContent=${WorkerHost.quote(css)};
                (document.head||document.documentElement).appendChild(s);
              }
            }catch(e){${report("inject/reader.css", "e")}}
            """.trimIndent()
        }

    // What the catch does: tell the user, via report-failure.js. The fallback
    // matters — this same clause guards report-failure.js itself, and a console
    // line is all that is left when the reporter is what failed.
    private fun report(name: String, error: String): String =
        "if(window.PanelFlowFailed)window.PanelFlowFailed('$name',$error);" +
            "else console.warn('panelflow: $name failed',$error)"

    /** The asset's text, or "" if it is not in the APK — see [concat]. */
    private fun read(context: Context, name: String): String =
        runCatching {
            context.assets.open(name).bufferedReader().use { it.readText() }
        }.getOrElse { "" }
}

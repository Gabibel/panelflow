package dev.panelflow

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject

/**
 * The in-app browser — where a scan site becomes readable.
 *
 * The page is loaded as-is and the extension's own content scripts are injected
 * into it, so what the user gets here is what they would get in Chrome with
 * PanelFlow installed: the detection pill, the reader, the add-to-library modal.
 * The toolbar below stands in for the extension's popup, and reaches the same
 * content-script message handlers the popup does.
 */
class BrowserActivity : AppCompatActivity(), WorkerHost.Client {

    private lateinit var web: WebView
    private lateinit var hostLabel: TextView
    private lateinit var status: TextView
    private lateinit var readerButton: Button
    private lateinit var addButton: Button

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val url = intent?.data?.toString()
            ?: intent?.getStringExtra(Intent.EXTRA_TEXT)?.let { extractUrl(it) }
        if (url.isNullOrEmpty()) { finish(); return }

        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            // Scan sites open their popunders from a synthetic click; requiring
            // a real gesture is the cheap half of what popup-guard.js does.
            settings.setSupportMultipleWindows(false)
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.mediaPlaybackRequiresUserGesture = true

            addJavascriptInterface(NativeBridge(this@BrowserActivity), "PanelFlowNative")
            webChromeClient = WebChromeClient()
            webViewClient = MangaWebViewClient(
                context = this@BrowserActivity,
                blockedHosts = AdBlockList.hosts(this@BrowserActivity),
                whitelist = { AdBlockList.whitelist() },
                assetLoader = AssetHost.loader(this@BrowserActivity),
                onPageChanged = { refreshToolbar() },
            )
        }

        setContentView(buildLayout())
        web.loadUrl(url)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // The reader is a layer over the page, so back should close it
                // before it starts unwinding history — otherwise leaving the
                // reader also leaves the chapter.
                WorkerHost.ask(web, JSONObject().put("type", "readerState")) { state ->
                    val open = (state as? JSONObject)?.optBoolean("open") == true
                    runOnUiThread {
                        when {
                            open -> toggleReader()
                            web.canGoBack() -> web.goBack()
                            else -> finish()
                        }
                    }
                }
            }
        })
    }

    private fun buildLayout(): ViewGroup {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF1C1917.toInt())
        }

        // Where you are, and the two ways out of a page that went wrong.
        //
        // Scan sites redirect. A reader who taps an ad lands somewhere else
        // entirely, and until this bar existed there was nothing on screen that
        // said so and no way back except the system button — which on a site
        // that has stacked up twenty entries of history is not a way back at
        // all. The host is the smallest true answer to "what am I looking at";
        // showing the whole URL would only put a scan site's query string on a
        // phone-width line.
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(0xFF262220.toInt())
            setPadding(24, 8, 24, 8)
        }
        val close = Button(this).apply {
            text = getString(R.string.browser_close)
            setOnClickListener { finish() }
        }
        hostLabel = TextView(this).apply {
            setTextColor(0xFFE7E5E4.toInt())
            textSize = 13f
            isSingleLine = true
            gravity = Gravity.CENTER
        }
        val reload = Button(this).apply {
            text = getString(R.string.browser_reload)
            setOnClickListener { web.reload() }
        }
        top.addView(close)
        top.addView(hostLabel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        top.addView(reload)
        root.addView(top, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        root.addView(web, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        // The extension's popup, as a bar: is there a chapter here, open the
        // reader, put it in the library.
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(0xFF262220.toInt())
            setPadding(24, 12, 24, 12)
        }
        status = TextView(this).apply {
            setTextColor(0xFFA8A29E.toInt())
            textSize = 13f
            text = getString(R.string.browser_checking)
        }
        readerButton = Button(this).apply {
            text = getString(R.string.browser_read)
            isEnabled = false
            setOnClickListener { toggleReader() }
        }
        addButton = Button(this).apply {
            text = getString(R.string.browser_add)
            isEnabled = false
            setOnClickListener { addToLibrary() }
        }
        bar.addView(status, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(addButton)
        bar.addView(readerButton)
        root.addView(bar, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        return root
    }

    /**
     * Ask the page what it found. This is the live-DOM answer, and it overrules
     * whatever `shared/compat.js` guessed from the markup in the search list —
     * the guess exists to order a list, this decides what the buttons do.
     */
    private fun refreshToolbar() {
        // Read off the WebView and not off the intent: after a redirect the two
        // are different, and the one the reader is looking at is this one.
        hostLabel.text = runCatching { Uri.parse(web.url).host }
            .getOrNull().orEmpty().ifEmpty { getString(R.string.browser_host_unknown) }
        WorkerHost.ask(web, JSONObject().put("type", "readerState")) { state ->
            val obj = state as? JSONObject
            val detected = obj?.optBoolean("detected") == true
            val open = obj?.optBoolean("open") == true
            runOnUiThread {
                readerButton.isEnabled = detected || open
                addButton.isEnabled = detected
                readerButton.text = getString(
                    if (open) R.string.browser_close_reader else R.string.browser_read)
                status.text = getString(
                    if (detected) R.string.browser_chapter_found else R.string.browser_no_chapter)
            }
        }
    }

    private fun toggleReader() =
        WorkerHost.ask(web, JSONObject().put("type", "toggleReader")) { reply ->
            val error = (reply as? JSONObject)?.optString("error").orEmpty()
            runOnUiThread {
                if (error.isNotEmpty()) Toast.makeText(this, error, Toast.LENGTH_SHORT).show()
                refreshToolbar()
            }
        }

    /**
     * Opens the extension's own add-to-library modal, in the page. Doing it
     * there rather than in a native dialog is what gets the duplicate check and
     * the migration offer for free: the modal already asks the core
     * `findSimilar`, and already offers to move an entry instead of adding a
     * second copy of the same work.
     */
    private fun addToLibrary() =
        WorkerHost.ask(web, JSONObject().put("type", "openLibraryModal"), timeoutMs = 120_000) {
            runOnUiThread { refreshToolbar() }
        }

    /** A shared link arrives as free text; the URL is the part we want. */
    private fun extractUrl(text: String): String? =
        Regex("""https?://\S+""").find(text)?.value

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    // --- WorkerHost.Client ---------------------------------------------------
    // A page in this WebView reaches the shared core through `chrome-shim.js`,
    // so its replies go back to `PanelFlowPage`, not to the shell's bridge.

    override fun deliver(requestId: Long, bodyJson: String) = runOnUiThread {
        web.evaluateJavascript(
            "window.PanelFlowPage && window.PanelFlowPage.deliver($requestId, ${WorkerHost.quote(bodyJson)})",
            null,
        )
    }

    override fun emit(event: String, payloadJson: String) = Unit
}

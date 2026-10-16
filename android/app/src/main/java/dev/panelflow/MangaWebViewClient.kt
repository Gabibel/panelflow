package dev.panelflow

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream

/**
 * The in-app browser's client: blocks ad hosts per request, and injects the
 * shared PanelFlow content scripts into every page.
 *
 * `shouldInterceptRequest` is the reason this app is native Kotlin around a
 * WebView rather than React Native — per-request blocking is not something
 * `react-native-webview` can express, and on scan sites it is the difference
 * between a readable page and a minefield.
 */
class MangaWebViewClient(
    private val context: Context,
    private val blockedHosts: Set<String>,
    /** Per-site opt-out: the user chose to let this site through. */
    private val whitelist: () -> Set<String>,
    private val assetLoader: WebViewAssetLoader,
    private val onPageChanged: (String) -> Unit = {},
) : WebViewClient() {

    private val emptyResponse =
        WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))

    /**
     * The host of the page on screen, kept from the page callbacks.
     *
     * shouldInterceptRequest runs on a background thread, and WebView refuses
     * every call made from a thread other than its own: reading `view.url`
     * there throws for any app targeting API 18 or later. The callbacks below
     * run on the WebView's thread and see every page, redirects included.
     */
    @Volatile private var pageHost: String? = null

    private fun notePage(url: String?) {
        runCatching { url?.let { Uri.parse(it).host } }.getOrNull()?.let { pageHost = it.lowercase() }
    }

    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
    ): WebResourceResponse? {
        // The app's own assets are served over https from the APK; that has to
        // be answered before anything else looks at the request.
        AssetHost.intercept(assetLoader, request)?.let { return it }

        val host = request.url.host ?: return null
        val pageHost = pageHost
        // The site itself or one of its subdomains, and never a host that merely
        // ends with the same letters: `example.com` on the whitelist must not
        // excuse `notexample.com`. The same test the blocked list uses below.
        if (pageHost != null && whitelist().any { pageHost == it || pageHost.endsWith(".$it") }) return null
        if (blockedHosts.any { host == it || host.endsWith(".$it") }) return emptyResponse
        return null
    }

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        notePage(url)
        // popup-guard has to beat the site's own first-tap window.open, and the
        // shim has to exist before anything calls chrome.runtime.
        view.evaluateJavascript(PageScripts.early(context), null)
        onPageChanged(url)
    }

    override fun onPageFinished(view: WebView, url: String) {
        // Idempotent by design — each script guards on its own
        // `window.__panelflow*Loaded` flag — so re-running this after an SPA
        // navigation costs nothing and covers pages that never fire onPageStarted.
        view.evaluateJavascript(PageScripts.early(context), null)
        view.evaluateJavascript(PageScripts.late(context), null)
        onPageChanged(url)
    }

    override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
        notePage(url)
        // Scan sites that navigate chapter-to-chapter without a page load never
        // reach onPageFinished; this is the only signal that the URL moved.
        view.evaluateJavascript(PageScripts.late(context), null)
        onPageChanged(url)
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val scheme = request.url.scheme?.lowercase()
        // Anything that is not the web is a site trying to leave the WebView —
        // `intent://`, `market://`, a deep link into another app. On scan sites
        // that is an ad, never a navigation the user asked for.
        return scheme != "http" && scheme != "https"
    }
}

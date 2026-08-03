package dev.panelflow

import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader

/**
 * Serves the bundled web layer over https instead of `file://`.
 *
 * This is not cosmetic. A `file://` page has an opaque origin: localStorage is
 * unreliable across WebView versions, `fetch` is blocked outright on newer ones,
 * and the store the whole app is built on would live somewhere the platform
 * feels free to discard. `WebViewAssetLoader` gives the shell and the worker a
 * stable https origin backed by the APK's own assets, which is the origin their
 * data is then keyed to — so a user's library survives app updates.
 */
object AssetHost {
    const val DOMAIN = "appassets.androidplatform.net"
    const val ORIGIN = "https://$DOMAIN"

    const val SHELL_URL = "$ORIGIN/assets/www/index.html"

    /** The worker's URL carries the backend so `worker.js` can default to it. */
    fun workerUrl(backendUrl: String): String =
        "$ORIGIN/assets/www/worker.html?backend=" + java.net.URLEncoder.encode(backendUrl, "UTF-8")

    fun loader(context: Context): WebViewAssetLoader =
        WebViewAssetLoader.Builder()
            .setDomain(DOMAIN)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .build()

    fun intercept(loader: WebViewAssetLoader, request: WebResourceRequest): WebResourceResponse? =
        loader.shouldInterceptRequest(request.url)
}

package dev.panelflow

import android.annotation.SuppressLint
import android.os.Build
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject

/**
 * The app itself: tap the icon and you are in your library.
 *
 * The whole UI is `mobile/www/index.html`, served from the APK over https. That
 * is not a shortcut around writing Compose — it is what makes the phone and the
 * browser extension the same product. The library grid, the folders, the search
 * tab and the account panel are one implementation talking to one store, so a
 * feature added in either place exists in both.
 *
 * Native's share of the work is small and specific: hosting the WebViews,
 * owning notifications, owning the browser, and running the chapter check while
 * the app is closed.
 */
class MainActivity : AppCompatActivity(), WorkerHost.Client {

    private lateinit var shell: WebView

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* declined is fine */ }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val loader = AssetHost.loader(this)
        shell = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // The shell only ever shows bundled assets and covers proxied
            // through the backend; it has no reason to reach the filesystem.
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mediaPlaybackRequiresUserGesture = true
            setBackgroundColor(0xFF1C1917.toInt()) // matches app.css --bg, so no white flash

            addJavascriptInterface(NativeBridge(this@MainActivity), "PanelFlowNative")
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? = AssetHost.intercept(loader, request)

                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean {
                    // The shell never navigates. Anything that tries to is a
                    // link, and links belong in the in-app browser.
                    val url = request.url.toString()
                    if (url.startsWith(AssetHost.ORIGIN)) return false
                    NativeMessages.handle(this@MainActivity, JSONObject().put("type", "openUrl").put("url", url))
                    return true
                }
            }
        }
        setContentView(shell)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }

        WorkerHost.addListener(this)
        shell.loadUrl(AssetHost.SHELL_URL)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Let the shell take back first — it uses it to close the
                // bottom sheet and to leave the search tab. Only when it has
                // nothing to close does back mean "leave the app".
                shell.evaluateJavascript("window.PanelFlowShell && window.PanelFlowShell.back()") { r ->
                    if (r != "true") {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            }
        })
    }

    override fun onResume() {
        super.onResume()
        // Coming back from the browser, or from the phone being asleep: the
        // library may have moved on, here or on another device.
        WorkerHost.resync()
    }

    override fun onDestroy() {
        WorkerHost.removeListener(this)
        shell.destroy()
        super.onDestroy()
    }

    // --- WorkerHost.Client ---------------------------------------------------

    override fun deliver(requestId: Long, bodyJson: String) = runOnUiThread {
        shell.evaluateJavascript(
            "window.PanelFlowBridge.deliver($requestId, ${WorkerHost.quote(bodyJson)})",
            null,
        )
    }

    override fun emit(event: String, payloadJson: String) = runOnUiThread {
        shell.evaluateJavascript(
            "window.PanelFlowBridge.emit(${WorkerHost.quote(event)}, ${WorkerHost.quote(payloadJson)})",
            null,
        )
    }
}

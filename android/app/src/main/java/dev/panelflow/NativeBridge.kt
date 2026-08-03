package dev.panelflow

import android.webkit.JavascriptInterface

/**
 * `window.PanelFlowNative.post(json)` — the single opening in the wall between
 * JavaScript and Kotlin.
 *
 * One method, one string argument, and the string is parsed as JSON before
 * anything looks at it. That is the whole attack surface, which matters because
 * this same interface is attached to WebViews showing pages PanelFlow does not
 * control: the in-app browser loads whatever scan site the user chose, and that
 * site's own scripts can call anything reachable from `window`. Exposing an
 * object with getters, or a method taking a callback, would hand a hostile page
 * a foothold; a JSON string cannot be more than a message.
 *
 * The messages themselves are still untrusted — see [NativeMessages], which
 * decides what a page is allowed to ask for.
 */
class NativeBridge(private val client: WorkerHost.Client) {
    @JavascriptInterface
    fun post(json: String) = WorkerHost.post(client, json)
}

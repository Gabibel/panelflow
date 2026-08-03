package dev.panelflow

import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONObject

/**
 * The messages native answers itself, instead of relaying to the worker.
 *
 * Returns the reply body, or `null` to mean "not mine — forward it". Keeping
 * this list short is the point: every type here is a capability the worker
 * cannot express, and every one of them can be reached by a page the user
 * browsed to, not just by the app's own shell. So each is validated on its own
 * terms rather than trusted because it arrived over the bridge.
 */
object NativeMessages {

    fun handle(context: Context, msg: JSONObject): JSONObject? = when (msg.optString("type")) {
        "openUrl" -> openUrl(context, msg.optString("url"))
        "share" -> share(context, msg.optString("url"), msg.optString("title"))
        "nativeInfo" -> JSONObject()
            .put("platform", "android")
            .put("version", BuildConfig.VERSION_NAME)
            .put("buildBackendUrl", BuildConfig.BACKEND_URL)
        else -> null
    }

    /**
     * Open a page in the in-app browser. A scheme check, not a host check: the
     * user is allowed to browse anywhere, but `intent://`, `file://` and
     * `javascript:` are not browsing — they are ways for a page to reach out of
     * the WebView into other apps, the filesystem, or back into this one.
     */
    private fun openUrl(context: Context, raw: String): JSONObject {
        val url = raw.trim()
        val scheme = runCatching { Uri.parse(url).scheme?.lowercase() }.getOrNull()
        if (scheme != "http" && scheme != "https") {
            return JSONObject().put("ok", false).put("error", "unsupported url")
        }
        context.startActivity(
            Intent(context, BrowserActivity::class.java)
                .setAction(Intent.ACTION_VIEW)
                .setData(Uri.parse(url))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        return JSONObject().put("ok", true)
    }

    private fun share(context: Context, url: String, title: String): JSONObject {
        val scheme = runCatching { Uri.parse(url).scheme?.lowercase() }.getOrNull()
        if (scheme != "http" && scheme != "https") {
            return JSONObject().put("ok", false).put("error", "unsupported url")
        }
        val send = Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, if (title.isEmpty()) url else "$title\n$url")
        context.startActivity(
            Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        return JSONObject().put("ok", true)
    }
}

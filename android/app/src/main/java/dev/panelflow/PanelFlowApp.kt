package dev.panelflow

import android.app.Application
import android.os.Build
import android.webkit.WebView
import org.json.JSONObject

/**
 * Starts the offscreen worker before anything asks it for the library.
 *
 * Doing this in `Application` rather than in `MainActivity` is deliberate: the
 * background chapter check runs in a process with no Activity at all, and the
 * store has to be reachable there too.
 */
class PanelFlowApp : Application() {

    override fun onCreate() {
        super.onCreate()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // Two WebViews in one process must not share a data directory, and
            // the browser Activity may run in its own process later.
            val process = getProcessName()
            if (process != packageName) WebView.setDataDirectorySuffix(process)
        }

        Notifications.createChannel(this)
        WorkerHost.start(this, Settings.backendUrl)
        ChapterCheckWorker.schedule(this)

        // Native needs a couple of settings synchronously — the ad-block
        // whitelist is read inside a request interceptor, which cannot wait on
        // a bridge round-trip. The core still owns them; this is a cache.
        WorkerHost.post(
            object : WorkerHost.Client {
                override fun deliver(requestId: Long, bodyJson: String) {
                    runCatching { Settings.apply(JSONObject(bodyJson)) }
                }
                override fun emit(event: String, payloadJson: String) = Unit
            },
            JSONObject()
                .put("id", 1)
                .put("msg", JSONObject().put("type", "getSettings"))
                .toString(),
        )
    }
}

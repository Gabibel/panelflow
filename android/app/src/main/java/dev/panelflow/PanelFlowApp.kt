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
        // Before the schedule, not after: the check interval is a setting, and
        // the worker that owns it is not up yet.
        Settings.load(this)
        WorkerHost.start(this, Settings.backendUrl)
        ChapterCheckWorker.schedule(this)

        // Native needs a few settings synchronously — the ad-block whitelist is
        // read inside a request interceptor, which cannot wait on a bridge
        // round-trip, and the check interval schedules WorkManager in a process
        // that may have no worker at all. The core still owns them; this is a
        // cache. Two questions because they live in two places: the backend URL
        // is this device's, the whitelist and the interval are the account's.
        for (type in listOf("getSettings", "pullAccountPrefs")) ask(type)
    }

    private fun ask(type: String) {
        WorkerHost.post(
            object : WorkerHost.Client {
                override fun deliver(requestId: Long, bodyJson: String) {
                    runCatching {
                        // Only a changed interval rebuilds the schedule — see
                        // the KEEP/UPDATE argument in ChapterCheckWorker.
                        if (Settings.apply(this@PanelFlowApp, JSONObject(bodyJson))) {
                            ChapterCheckWorker.schedule(this@PanelFlowApp, replace = true)
                        }
                    }
                }
                override fun emit(event: String, payloadJson: String) = Unit
            },
            JSONObject()
                .put("id", 1)
                .put("msg", JSONObject().put("type", type))
                .toString(),
        )
    }
}

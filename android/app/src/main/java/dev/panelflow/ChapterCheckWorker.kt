package dev.panelflow

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * "Is there a new chapter?", asked while the app is closed.
 *
 * The extension does this with `chrome.alarms`; here it is WorkManager, and in
 * both cases the actual work is `core.checkNewChapters()` — one implementation
 * of what counts as a new chapter, what gets remembered, and what is worth
 * waking the user for.
 *
 * The worker WebView has to exist for that, which means starting it in a
 * process that may have no Activity. That is fine: it is offscreen by design
 * and never needed a window.
 */
class ChapterCheckWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        // A WebView can only be built on the main thread, and CoroutineWorker
        // does not run there.
        withContext(Dispatchers.Main) { WorkerHost.start(applicationContext, Settings.backendUrl) }

        // A library of forty series is forty outbound page fetches, each of
        // which may be a slow site behind Cloudflare. The cap is generous, and
        // whatever finished before it still counted — the core stores each
        // entry's new chapter as it goes.
        withTimeoutOrNull(8 * 60 * 1000L) {
            suspendCancellableCoroutine { cont ->
                val client = object : WorkerHost.Client {
                    override fun deliver(requestId: Long, bodyJson: String) {
                        if (cont.isActive) cont.resume(Unit)
                    }
                    override fun emit(event: String, payloadJson: String) = Unit
                }
                WorkerHost.post(client, JSONObject()
                    .put("id", 1)
                    .put("msg", JSONObject().put("type", "checkNow"))
                    .toString())
            }
        }

        // Always success, never retry. A failed check means some sites were
        // unreachable; retrying would re-request every site in the library for
        // a result the next scheduled run gets anyway.
        return Result.success()
    }

    companion object {
        private const val NAME = "panelflow-chapter-check"

        /**
         * @param replace the reader changed the interval, so the schedule
         *                standing right now is the wrong one.
         */
        fun schedule(context: Context, replace: Boolean = false) {
            // Minutes, not hours: `checkIntervalMin` offers 60 through 1440 and
            // the shortest of those is WorkManager's own floor. The value is
            // the account preference the extension builds its alarm from — one
            // question, asked once, obeyed by every client.
            val request = PeriodicWorkRequestBuilder<ChapterCheckWorker>(
                Settings.checkIntervalMin,
                TimeUnit.MINUTES,
            )
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                NAME,
                // KEEP, not UPDATE: every cold start would otherwise reset the
                // period and a phone opened often would never reach the check.
                // The one case that has to overrule that is the reader saying
                // "every hour" — KEEP would answer by ignoring them until the
                // app is reinstalled, which is the bug this argument exists for.
                if (replace) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }
    }
}

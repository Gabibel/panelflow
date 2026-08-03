package dev.panelflow

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/**
 * "Chapter 110 is out." — the one thing the shared core cannot do for itself,
 * because a WebView has no access to the notification tray.
 *
 * The core decides *whether* to notify (and remembers, so a chapter never
 * announces itself twice); this only renders what it decided.
 */
object Notifications {

    private const val CHANNEL = "chapters"

    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL,
            context.getString(R.string.channel_chapters),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply { description = context.getString(R.string.channel_chapters_desc) }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    fun chapter(context: Context, notification: JSONObject) {
        val title = notification.optString("title").ifEmpty {
            context.getString(R.string.app_name)
        }
        val message = notification.optString("message")
        if (message.isEmpty()) return

        // Tapping it should land on the chapter, not on a generic home screen.
        val url = notification.optJSONObject("entry")?.optString("sourceUrl").orEmpty()
        val intent = if (url.startsWith("http")) {
            Intent(context, BrowserActivity::class.java)
                .setAction(Intent.ACTION_VIEW)
                .setData(Uri.parse(url))
        } else {
            Intent(context, MainActivity::class.java)
        }
        val pending = PendingIntent.getActivity(
            context,
            notification.optString("id").hashCode(),
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val built = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()

        runCatching {
            // Denied notification permission throws on 13+; the check already
            // happened in the core, so there is nothing to fall back to.
            NotificationManagerCompat.from(context)
                .notify(notification.optString("id").hashCode(), built)
        }
    }
}

package dev.panelflow

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * The offscreen WebView that runs the shared store core, and the switchboard in
 * front of it.
 *
 * This is the mobile twin of the extension's MV3 service worker, and it exists
 * for the same reason: the library, progress, dedupe and migration logic is one
 * body of code (`shared/panelflow-core.js`) that Chrome, Android and iOS all
 * execute unchanged. Reimplementing it in Kotlin would mean a merge behaves one
 * way on the phone and another in the browser — which is the bug this whole
 * design exists to make impossible.
 *
 * Keeping it in a WebView also keeps the store (localStorage) on the same side
 * of the native bridge as the code that mutates it. A Room-backed store would
 * turn every merge into a dozen async hops across JNI.
 *
 * Everything the app sends flows through [post]: native answers the handful of
 * messages only native can, and relays the rest here.
 */
object WorkerHost {

    /** Anything that can be sent a reply or an unprompted event. */
    interface Client {
        /** Completes one pending request this client made. `body` is raw JSON. */
        fun deliver(requestId: Long, bodyJson: String)

        /** Unprompted push: `ready`, `notify`, `resumed`. */
        fun emit(event: String, payloadJson: String)
    }

    private val main = Handler(Looper.getMainLooper())
    private val ids = AtomicLong(1)

    /** Requests forwarded to the worker, waiting on its reply. */
    private val inFlight = ConcurrentHashMap<Long, Pair<Client, Long>>()

    /** Replies native itself is waiting on (asking a page for its state). */
    private val nativeWaiters = ConcurrentHashMap<Long, (Any?) -> Unit>()

    /** Shell clients that want `ready`/`notify`; browser pages do not. */
    private val listeners = mutableSetOf<Client>()

    private var worker: WebView? = null
    private var loaded = false

    /** Messages that arrived before the worker finished loading. */
    private val queued = ArrayDeque<Pair<Long, String>>()

    private lateinit var appContext: Context

    // --- lifecycle -----------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    fun start(context: Context, backendUrl: String) {
        if (worker != null) return
        appContext = context.applicationContext
        val loader = AssetHost.loader(appContext)
        val view = WebView(appContext)
        view.settings.javaScriptEnabled = true
        view.settings.domStorageEnabled = true
        // No user-visible content ever loads here, so nothing else is needed —
        // and every capability left off is one the store cannot be reached by.
        view.settings.allowFileAccess = false
        view.settings.allowContentAccess = false
        view.settings.mediaPlaybackRequiresUserGesture = true

        view.addJavascriptInterface(NativeBridge(WorkerClient), "PanelFlowNative")
        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                v: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = AssetHost.intercept(loader, request)
        }
        worker = view
        view.loadUrl(AssetHost.workerUrl(backendUrl))
    }

    fun addListener(client: Client) = synchronized(listeners) { listeners.add(client) }
    fun removeListener(client: Client) = synchronized(listeners) { listeners.remove(client) }

    /** Settle the local store against the account — called once per cold start. */
    fun boot() = eval("window.PanelFlowWorker.boot()")

    /** The shell asks for this on resume: the library may have changed elsewhere. */
    fun resync() {
        send(object : Client {
            override fun deliver(requestId: Long, bodyJson: String) = broadcast("resumed", "{}")
            override fun emit(event: String, payloadJson: String) = Unit
        }, 0, JSONObject(mapOf("type" to "pullNow")))
    }

    // --- inbound -------------------------------------------------------------

    /**
     * One raw envelope from a WebView. Three shapes arrive here:
     * `{id, msg}` a request, `{reply:{id, body}}` an answer to something we
     * asked for, and `{event, …}` an unprompted push from the worker.
     */
    fun post(client: Client, json: String) {
        val envelope = try { JSONObject(json) } catch (e: Exception) { return }

        // Both the worker answering a forwarded request and a browser page
        // answering a `dispatch` come back as a reply, and both draw their id
        // from the same counter — so one id space, two destinations.
        envelope.optJSONObject("reply")?.let { reply ->
            val id = reply.optLong("id")
            nativeWaiters.remove(id)?.invoke(reply.opt("body")) ?: onWorkerReply(id, reply.opt("body"))
            return
        }
        envelope.optString("event").takeIf { it.isNotEmpty() }?.let { event ->
            onWorkerEvent(event, envelope)
            return
        }
        val msg = envelope.optJSONObject("msg") ?: return
        send(client, envelope.optLong("id"), msg)
    }

    /** Route one message: native handles what only native can, worker gets the rest. */
    private fun send(client: Client, requestId: Long, msg: JSONObject) {
        val handled = NativeMessages.handle(appContext, msg)
        if (handled != null) {
            client.deliver(requestId, handled.toString())
            return
        }
        val workerId = ids.getAndIncrement()
        inFlight[workerId] = client to requestId
        forward(workerId, msg.toString())
    }

    private fun forward(workerId: Long, msgJson: String) = main.post {
        if (!loaded) { queued.addLast(workerId to msgJson); return@post }
        eval("window.PanelFlowWorker.handle($workerId, ${quote(msgJson)})")
    }

    private fun onWorkerEvent(event: String, envelope: JSONObject) = main.post {
        when (event) {
            "loaded" -> {
                loaded = true
                while (queued.isNotEmpty()) {
                    val (id, json) = queued.removeFirst()
                    eval("window.PanelFlowWorker.handle($id, ${quote(json)})")
                }
                boot()
            }
            "ready" -> broadcast("ready", "{}")
            "notify" -> {
                val n = envelope.optJSONObject("notification") ?: JSONObject()
                Notifications.chapter(appContext, n)
                broadcast("notify", n.toString())
            }
            else -> broadcast(event, envelope.toString())
        }
    }

    /** The worker replying: hand the body to whoever originally asked. */
    private object WorkerClient : Client {
        override fun deliver(requestId: Long, bodyJson: String) = Unit
        override fun emit(event: String, payloadJson: String) = Unit
    }

    private fun broadcast(event: String, payloadJson: String) {
        val snapshot = synchronized(listeners) { listeners.toList() }
        for (c in snapshot) c.emit(event, payloadJson)
    }

    // --- native → a page -----------------------------------------------------

    /**
     * Ask an in-app browser page something the extension would ask the active
     * tab (`readerState`, `toggleReader`, `getSeriesMeta`) and await its answer.
     * `onReply` gets null if the page never answers.
     */
    fun ask(page: WebView, msg: JSONObject, timeoutMs: Long = 5_000, onReply: (Any?) -> Unit) {
        val id = ids.getAndIncrement()
        val done = java.util.concurrent.atomic.AtomicBoolean(false)
        nativeWaiters[id] = { body -> if (done.compareAndSet(false, true)) onReply(body) }
        main.post {
            page.evaluateJavascript(
                "window.PanelFlowPage && window.PanelFlowPage.dispatch(${quote(msg.toString())}, $id)",
                null,
            )
        }
        main.postDelayed({
            nativeWaiters.remove(id)
            if (done.compareAndSet(false, true)) onReply(null)
        }, timeoutMs)
    }

    // --- worker replies ------------------------------------------------------

    /** Called by [NativeBridge] when the worker answers a forwarded request. */
    internal fun onWorkerReply(workerId: Long, body: Any?) {
        val (client, requestId) = inFlight.remove(workerId) ?: return
        client.deliver(requestId, body?.toString() ?: "null")
    }

    private fun eval(js: String) = main.post { worker?.evaluateJavascript(js, null) }

    /** JSON-quote a string for embedding in a JS expression. */
    internal fun quote(s: String): String = JSONObject.quote(s)
}

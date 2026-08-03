import WebKit

/// The offscreen `WKWebView` that runs the shared store core, and the
/// switchboard in front of it.
///
/// This is the iOS twin of the Chrome extension's MV3 service worker and of
/// Android's `WorkerHost`, and all three exist for the same reason: the
/// library, progress, dedupe and migration logic is one body of code
/// (`shared/panelflow-core.js`) that every platform executes unchanged.
/// Reimplementing it in Swift would mean a merge behaves one way on the phone
/// and another in the browser — the exact failure this design prevents.
///
/// Keeping it in a web view also keeps the store (`localStorage`) on the same
/// side of the bridge as the code that mutates it. A Core Data store would turn
/// every merge into a dozen async hops across the message handler.
///
/// The view is never added to a window. WebKit throttles timers in views that
/// are off-screen but it does not stop them, and nothing here is timer-driven:
/// every action is a message that arrives and is answered.
/// Anything that can be sent a reply or an unprompted event.
///
/// Top level rather than nested in `WorkerHost` so it names the same thing
/// Android's `WorkerHost.Client` does without depending on a Swift version that
/// allows nested protocols.
@MainActor
protocol PanelFlowClient: AnyObject {
    /// Completes one pending request this client made. `bodyJSON` is raw JSON.
    func deliver(requestID: Int, bodyJSON: String)
    /// Unprompted push: `ready`, `notify`, `resumed`.
    func emit(event: String, payloadJSON: String)
}

@MainActor
final class WorkerHost: NSObject {

    static let shared = WorkerHost()

    typealias Client = PanelFlowClient

    private var worker: WKWebView?
    private var loaded = false
    private var nextID = 1

    /// Requests forwarded to the worker, waiting on its reply.
    private var inFlight: [Int: (client: Client, requestID: Int)] = [:]
    /// Replies native itself is waiting on — asking a page for its state.
    private var nativeWaiters: [Int: (Any?) -> Void] = [:]
    /// Shell clients that want `ready`/`notify`; browser pages do not.
    private var listeners: [WeakClient] = []
    /// Messages that arrived before the worker finished loading.
    private var queued: [(Int, String)] = []

    private struct WeakClient { weak var value: Client? }

    // MARK: - lifecycle

    func start(backendURL: String) {
        guard worker == nil else { return }

        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(MessageProxy(client: WorkerReplyClient()), name: "panelflow")
        config.userContentController = controller
        // The store lives here, so it must be the persistent store and not a
        // per-launch one — a non-persistent data store would hand the user an
        // empty library after every cold start.
        config.websiteDataStore = .default()

        let view = WKWebView(frame: .zero, configuration: config)
        worker = view

        guard let base = Bundle.main.url(forResource: "worker", withExtension: "html",
                                         subdirectory: "www")
        else { return }
        // The backend is passed on the URL rather than baked into worker.js:
        // both platforms set it the same way, and it stays a *default* that the
        // user's own stored setting overrides.
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "backend", value: backendURL)]
        let target = components?.url ?? base
        view.loadFileURL(target, allowingReadAccessTo: base.deletingLastPathComponent())
    }

    func addListener(_ client: Client) {
        listeners.removeAll { $0.value == nil || $0.value === client }
        listeners.append(WeakClient(value: client))
    }

    func removeListener(_ client: Client) {
        listeners.removeAll { $0.value == nil || $0.value === client }
    }

    /// The shell asks for this on foreground: the library may have moved on.
    func resync() {
        send(client: ResyncClient(host: self), requestID: 0, msg: ["type": "pullNow"])
    }

    // MARK: - inbound

    /// One raw envelope from a web view. Three shapes arrive here: `{id, msg}`
    /// a request, `{reply: {id, body}}` an answer to something we asked for,
    /// and `{event, …}` an unprompted push from the worker.
    func post(client: Client, json: String) {
        guard let data = json.data(using: .utf8),
              let envelope = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return }

        // Both the worker answering a forwarded request and a browser page
        // answering a `dispatch` come back as a reply, and both draw their id
        // from the same counter — one id space, two destinations.
        if let reply = envelope["reply"] as? [String: Any], let id = reply["id"] as? Int {
            if let waiter = nativeWaiters.removeValue(forKey: id) {
                waiter(reply["body"])
            } else {
                onWorkerReply(id, body: reply["body"])
            }
            return
        }
        if let event = envelope["event"] as? String {
            onWorkerEvent(event, envelope: envelope)
            return
        }
        guard let msg = envelope["msg"] as? [String: Any] else { return }
        send(client: client, requestID: envelope["id"] as? Int ?? 0, msg: msg)
    }

    /// Route one message: native handles what only native can, worker gets the rest.
    private func send(client: Client, requestID: Int, msg: [String: Any]) {
        if let handled = NativeMessages.handle(msg) {
            client.deliver(requestID: requestID, bodyJSON: encode(handled))
            return
        }
        let workerID = nextID; nextID += 1
        inFlight[workerID] = (client, requestID)
        forward(workerID, msgJSON: encode(msg))
    }

    private func forward(_ workerID: Int, msgJSON: String) {
        guard loaded else { queued.append((workerID, msgJSON)); return }
        eval("window.PanelFlowWorker.handle(\(workerID), \(quote(msgJSON)))")
    }

    private func onWorkerEvent(_ event: String, envelope: [String: Any]) {
        switch event {
        case "loaded":
            loaded = true
            let pending = queued; queued = []
            for (id, json) in pending {
                eval("window.PanelFlowWorker.handle(\(id), \(quote(json)))")
            }
            eval("window.PanelFlowWorker.boot()")
        case "ready":
            broadcast("ready", payloadJSON: "{}")
        case "notify":
            let n = envelope["notification"] as? [String: Any] ?? [:]
            Notifications.chapter(n)
            broadcast("notify", payloadJSON: encode(n))
        default:
            broadcast(event, payloadJSON: encode(envelope))
        }
    }

    private func onWorkerReply(_ workerID: Int, body: Any?) {
        guard let pending = inFlight.removeValue(forKey: workerID) else { return }
        pending.client.deliver(requestID: pending.requestID,
                               bodyJSON: body.map(encodeAny) ?? "null")
    }

    private func broadcast(_ event: String, payloadJSON: String) {
        listeners.removeAll { $0.value == nil }
        for entry in listeners { entry.value?.emit(event: event, payloadJSON: payloadJSON) }
    }

    // MARK: - native → a page

    /// Ask an in-app browser page something the extension would ask the active
    /// tab (`readerState`, `toggleReader`, `getSeriesMeta`) and await its
    /// answer. `onReply` gets nil if the page never answers.
    func ask(page: WKWebView, msg: [String: Any], timeout: TimeInterval = 5,
             onReply: @escaping (Any?) -> Void) {
        let id = nextID; nextID += 1
        var answered = false
        nativeWaiters[id] = { body in
            guard !answered else { return }
            answered = true
            onReply(body)
        }
        page.evaluateJavaScript(
            "window.PanelFlowPage && window.PanelFlowPage.dispatch(\(quote(encode(msg))), \(id))"
        )
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            self?.nativeWaiters.removeValue(forKey: id)
            guard !answered else { return }
            answered = true
            onReply(nil)
        }
    }

    // MARK: - helpers

    private func eval(_ js: String) { worker?.evaluateJavaScript(js) }

    /// The worker's own replies land here; the routing already happened in `post`.
    private final class WorkerReplyClient: Client {
        func deliver(requestID: Int, bodyJSON: String) {}
        func emit(event: String, payloadJSON: String) {}
    }

    private final class ResyncClient: Client {
        private weak var host: WorkerHost?
        init(host: WorkerHost) { self.host = host }
        func deliver(requestID: Int, bodyJSON: String) {
            MainActor.assumeIsolated { host?.broadcast("resumed", payloadJSON: "{}") }
        }
        func emit(event: String, payloadJSON: String) {}
    }
}

// MARK: - JSON helpers

func encode(_ value: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: value),
          let s = String(data: data, encoding: .utf8) else { return "{}" }
    return s
}

func encodeAny(_ value: Any) -> String {
    if JSONSerialization.isValidJSONObject(value),
       let data = try? JSONSerialization.data(withJSONObject: value),
       let s = String(data: data, encoding: .utf8) { return s }
    return "null"
}

/// JSON-quote a string for embedding in a JS expression.
func quote(_ s: String) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: [s]),
          let wrapped = String(data: data, encoding: .utf8) else { return "\"\"" }
    return String(wrapped.dropFirst().dropLast())
}

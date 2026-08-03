import WebKit

/// `webkit.messageHandlers.panelflow.postMessage(json)` — the single opening in
/// the wall between JavaScript and Swift.
///
/// One handler, one string argument, parsed as JSON before anything looks at
/// it. That is the whole attack surface, which matters because this handler is
/// attached to web views showing pages PanelFlow does not control: the in-app
/// browser loads whatever scan site the user chose, and that site's own scripts
/// can post to any handler the app installed. A message that can only ever be a
/// JSON string cannot be more than a message.
///
/// The messages themselves are still untrusted — `NativeMessages` decides what
/// a page is allowed to ask for.
///
/// It also breaks a retain cycle. `WKUserContentController` retains its message
/// handlers, and a web view retains its controller, so a handler that is also
/// the view's owner keeps the whole view alive forever. This proxy holds its
/// client weakly.
final class MessageProxy: NSObject, WKScriptMessageHandler {

    private weak var client: PanelFlowClient?

    init(client: PanelFlowClient) {
        self.client = client
        super.init()
    }

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let json = message.body as? String, let client else { return }
        MainActor.assumeIsolated {
            WorkerHost.shared.post(client: client, json: json)
        }
    }
}

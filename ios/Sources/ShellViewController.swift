import Foundation
import UIKit
import WebKit

/// The app itself: tap the icon and you are in your library.
///
/// The whole UI is `mobile/www/index.html`, loaded from the bundle. That is not
/// a shortcut around writing SwiftUI — it is what makes the phone and the
/// browser extension the same product. The library grid, the folders, the
/// search tab and the account panel are one implementation talking to one
/// store, so a feature added in either place exists in both.
///
/// Native's share of the work is small and specific: hosting the web views,
/// owning notifications, owning the browser, and running the chapter check
/// while the app is closed.
final class ShellViewController: UIViewController {

    private var shell: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.11, green: 0.098, blue: 0.09, alpha: 1) // app.css --bg

        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(MessageProxy(client: self), name: "panelflow")
        config.userContentController = controller
        config.websiteDataStore = .default()

        shell = WKWebView(frame: .zero, configuration: config)
        shell.isOpaque = false
        shell.backgroundColor = view.backgroundColor
        // The shell is an app, not a document: rubber-banding the whole library
        // grid past its edges reads as a bug on a fixed-layout screen.
        shell.scrollView.bounces = false
        shell.navigationDelegate = self
        shell.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(shell)
        NSLayoutConstraint.activate([
            shell.topAnchor.constraint(equalTo: view.topAnchor),
            shell.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            shell.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            shell.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        WorkerHost.shared.addListener(self)

        // `www/index.html` is the app. It is copied in by
        // ios/Scripts/bundle-assets.sh, so the way it goes missing is a build
        // mistake — and this `return` used to make that mistake indistinguishable
        // from everything working: the shell simply stayed blank, with nothing
        // on screen, in the console, or anywhere else to say the file was not
        // there. A blank first screen is the single most expensive silent
        // failure in the app, because it is also what a reader reports as
        // "it doesn't open".
        guard let index = Bundle.main.url(forResource: "index", withExtension: "html",
                                          subdirectory: "www") else {
            NSLog("[panelflow] www/index.html is missing from the bundle — the shell has "
                + "nothing to load. Check ios/Scripts/bundle-assets.sh ran.")
            return
        }
        shell.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Coming back from the browser, or from the phone being asleep: the
        // library may have moved on, here or on another device.
        WorkerHost.shared.resync()
    }

    deinit { MainActor.assumeIsolated { WorkerHost.shared.removeListener(self) } }
}

extension ShellViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView,
                 decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // The shell never navigates. Anything that tries to is a link, and
        // links belong in the in-app browser.
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.isFileURL { return decisionHandler(.allow) }
        _ = NativeMessages.handle(["type": "openUrl", "url": url.absoluteString])
        decisionHandler(.cancel)
    }
}

extension ShellViewController: PanelFlowClient {
    func deliver(requestID: Int, bodyJSON: String) {
        shell.evaluateJavaScript("window.PanelFlowBridge.deliver(\(requestID), \(quote(bodyJSON)))")
    }

    func emit(event: String, payloadJSON: String) {
        shell.evaluateJavaScript(
            "window.PanelFlowBridge.emit(\(quote(event)), \(quote(payloadJSON)))")
    }
}

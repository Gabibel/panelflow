import UIKit
import WebKit

/// The in-app browser — where a scan site becomes readable.
///
/// The page is loaded as-is and the extension's own content scripts are
/// injected into it, so what the user gets here is what they would get in
/// Chrome with PanelFlow installed: the detection pill, the reader, the
/// add-to-library modal. The toolbar at the bottom stands in for the
/// extension's popup, and reaches the same content-script message handlers the
/// popup does.
final class BrowserViewController: UIViewController {

    private let startURL: URL
    private var web: WKWebView!
    private let statusLabel = UILabel()
    private let readerButton = UIButton(type: .system)
    private let addButton = UIButton(type: .system)

    init(url: URL) {
        self.startURL = url
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.11, green: 0.098, blue: 0.09, alpha: 1)

        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        for script in PageScripts.userScripts() { controller.addUserScript(script) }
        controller.add(MessageProxy(client: self), name: "panelflow")
        // Compiled, process-level ad blocking. This is the deciding reason the
        // app is native around WKWebView rather than React Native: no
        // JS-level blocker can match a WKContentRuleList on a scan site.
        ContentBlocker.shared.attach(to: controller)
        config.userContentController = controller
        // Scan sites open their popunders from a synthetic click; requiring a
        // real gesture is the cheap half of what popup-guard.js does.
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.mediaTypesRequiringUserActionForPlayback = .all

        web = WKWebView(frame: .zero, configuration: config)
        web.allowsBackForwardNavigationGestures = true
        web.navigationDelegate = self

        layout()
        web.load(URLRequest(url: startURL))
    }

    private func layout() {
        let toolbar = UIStackView()
        toolbar.axis = .horizontal
        toolbar.alignment = .center
        toolbar.spacing = 12
        toolbar.isLayoutMarginsRelativeArrangement = true
        toolbar.layoutMargins = .init(top: 8, left: 16, bottom: 8, right: 16)
        toolbar.backgroundColor = UIColor(red: 0.149, green: 0.133, blue: 0.125, alpha: 1)

        statusLabel.text = NSLocalizedString("browser.checking", value: "Checking this page…", comment: "")
        statusLabel.textColor = UIColor(red: 0.658, green: 0.635, blue: 0.616, alpha: 1)
        statusLabel.font = .systemFont(ofSize: 13)
        statusLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let close = UIButton(type: .system)
        close.setTitle(NSLocalizedString("browser.done", value: "Done", comment: ""), for: .normal)
        close.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .touchUpInside)

        addButton.setTitle(NSLocalizedString("browser.add", value: "Add", comment: ""), for: .normal)
        addButton.isEnabled = false
        addButton.addAction(UIAction { [weak self] _ in self?.addToLibrary() }, for: .touchUpInside)

        readerButton.setTitle(NSLocalizedString("browser.read", value: "Read", comment: ""), for: .normal)
        readerButton.isEnabled = false
        readerButton.addAction(UIAction { [weak self] _ in self?.toggleReader() }, for: .touchUpInside)

        for v in [close, statusLabel, addButton, readerButton] { toolbar.addArrangedSubview(v) }

        let stack = UIStackView(arrangedSubviews: [web, toolbar])
        stack.axis = .vertical
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.topAnchor),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ])
    }

    /// Ask the page what it found. This is the live-DOM answer, and it overrules
    /// whatever `shared/compat.js` guessed from the markup in the search list —
    /// the guess exists to order a list, this decides what the buttons do.
    private func refreshToolbar() {
        WorkerHost.shared.ask(page: web, msg: ["type": "readerState"]) { [weak self] state in
            guard let self else { return }
            let obj = state as? [String: Any]
            let detected = obj?["detected"] as? Bool ?? false
            let open = obj?["open"] as? Bool ?? false
            self.readerButton.isEnabled = detected || open
            self.addButton.isEnabled = detected
            self.readerButton.setTitle(
                open ? NSLocalizedString("browser.closeReader", value: "Close", comment: "")
                     : NSLocalizedString("browser.read", value: "Read", comment: ""),
                for: .normal)
            self.statusLabel.text = detected
                ? NSLocalizedString("browser.found", value: "Chapter detected", comment: "")
                : NSLocalizedString("browser.none", value: "No chapter on this page", comment: "")
        }
    }

    private func toggleReader() {
        WorkerHost.shared.ask(page: web, msg: ["type": "toggleReader"]) { [weak self] _ in
            self?.refreshToolbar()
        }
    }

    /// Opens the extension's own add-to-library modal, in the page. Doing it
    /// there rather than in a native sheet is what gets the duplicate check and
    /// the migration offer for free: the modal already asks the core
    /// `findSimilar`, and already offers to move an entry instead of adding a
    /// second copy of the same work.
    private func addToLibrary() {
        WorkerHost.shared.ask(page: web, msg: ["type": "openLibraryModal"], timeout: 120) {
            [weak self] _ in self?.refreshToolbar()
        }
    }
}

extension BrowserViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { refreshToolbar() }

    func webView(_ webView: WKWebView,
                 decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let scheme = action.request.url?.scheme?.lowercased()
        // Anything that is not the web is a site trying to leave the web view —
        // a deep link into another app. On scan sites that is an ad, never a
        // navigation the user asked for.
        decisionHandler(scheme == "http" || scheme == "https" ? .allow : .cancel)
    }
}

extension BrowserViewController: PanelFlowClient {
    // A page in this web view reaches the shared core through `chrome-shim.js`,
    // so its replies go back to `PanelFlowPage`, not to the shell's bridge.
    func deliver(requestID: Int, bodyJSON: String) {
        web.evaluateJavaScript(
            "window.PanelFlowPage && window.PanelFlowPage.deliver(\(requestID), \(quote(bodyJSON)))")
    }

    func emit(event: String, payloadJSON: String) {}
}

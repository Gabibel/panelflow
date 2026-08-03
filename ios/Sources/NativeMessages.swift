import UIKit

/// The messages native answers itself, instead of relaying to the worker.
///
/// Returns the reply body, or nil to mean "not mine — forward it". Keeping this
/// list short is the point: every type here is a capability the worker cannot
/// express, and every one of them can be reached by a page the user browsed to,
/// not just by the app's own shell. So each is validated on its own terms
/// rather than trusted because it arrived over the bridge.
@MainActor
enum NativeMessages {

    /// Set by the app on launch; the browser presents from here.
    static weak var presenter: UIViewController?

    static func handle(_ msg: [String: Any]) -> [String: Any]? {
        switch msg["type"] as? String {
        case "openUrl":  return openURL(msg["url"] as? String ?? "")
        case "share":    return share(msg["url"] as? String ?? "", title: msg["title"] as? String ?? "")
        case "nativeInfo":
            return [
                "platform": "ios",
                "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0",
                "buildBackendUrl": AppConfig.buildBackendURL,
            ]
        default: return nil
        }
    }

    /// Open a page in the in-app browser. A scheme check, not a host check: the
    /// user is allowed to browse anywhere, but `file:`, `javascript:` and the
    /// custom schemes scan-site ads use are not browsing — they are ways for a
    /// page to reach out of the web view, into the filesystem or another app.
    private static func openURL(_ raw: String) -> [String: Any] {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else { return ["ok": false, "error": "unsupported url"] }

        guard let presenter else { return ["ok": false, "error": "no window"] }
        let browser = BrowserViewController(url: url)
        browser.modalPresentationStyle = .fullScreen
        presenter.present(browser, animated: true)
        return ["ok": true]
    }

    private static func share(_ raw: String, title: String) -> [String: Any] {
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else { return ["ok": false, "error": "unsupported url"] }
        guard let presenter else { return ["ok": false, "error": "no window"] }

        let items: [Any] = title.isEmpty ? [url] : [title, url]
        let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
        // iPad presents this as a popover and crashes without an anchor.
        sheet.popoverPresentationController?.sourceView = presenter.view
        sheet.popoverPresentationController?.sourceRect = CGRect(
            x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY, width: 0, height: 0)
        presenter.present(sheet, animated: true)
        return ["ok": true]
    }
}

/// Build-time configuration. The user can point the app somewhere else from the
/// account tab at any time; this is only where it starts.
enum AppConfig {
    static var buildBackendURL: String {
        Bundle.main.infoDictionary?["PanelFlowBackendURL"] as? String
            ?? "https://panelflow.vercel.app"
    }
}

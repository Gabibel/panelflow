import Foundation

/// The handful of settings native itself needs before, or without, the worker.
///
/// The twin of Android's `Settings` object, and there for the same reason:
/// the shared core owns every setting, but two of them are needed where a
/// bridge round-trip cannot go. The ad-block whitelist is compiled into a
/// `WKContentRuleList` before the first page loads, and the background check
/// interval is used by `BGTaskScheduler` at launch — both before the worker has
/// finished starting, and the background task runs when the app is not there to
/// ask at all. So this is a cache, written to `UserDefaults`, never a second
/// source of truth: it only ever holds what the core last said.
@MainActor
enum Settings {

    /// How often to look for new chapters, when nobody has said otherwise yet.
    ///
    /// A copy of `ACCOUNT_PREFS.checkIntervalMin.fallback` in shared/prefs.js,
    /// kept because Swift cannot read that file at compile time — the same
    /// reason `project.yml` carries the backend URL. It is anchored to the
    /// shared value by `backend/test/mobile-shell.test.js`.
    static let defaultCheckIntervalMin = 360

    private static let intervalKey = "panelflow.checkIntervalMin"
    private static let whitelistKey = "panelflow.whitelist"

    /// Sites the reader chose to stop blocking on. See `ContentBlocker`.
    private(set) static var whitelist: [String] =
        UserDefaults.standard.stringArray(forKey: whitelistKey) ?? []

    /// Minutes between background chapter checks. See `ChapterCheck`.
    private(set) static var checkIntervalMin: Int = {
        let stored = UserDefaults.standard.integer(forKey: intervalKey)
        return stored > 0 ? stored : defaultCheckIntervalMin
    }()

    /// What one settings reply turned out to change.
    struct Changes {
        var interval = false
        var whitelist = false
        var any: Bool { interval || whitelist }
    }

    /// Ask the core for the account's answers and take them.
    ///
    /// Android does this from `Application.onCreate`; here it is the app
    /// delegate. `onChange` is called only when something actually moved, so a
    /// launch that confirms what was already stored rebuilds nothing.
    ///
    /// `pullAccountPrefs` and not `getSettings`: these two are the account's,
    /// and `getSettings` would answer with this device's defaults for both.
    /// (Android asks the other question as well, for the backend URL. Here
    /// that one is in Info.plist — see `AppConfig`.)
    static func pull(_ onChange: @escaping @MainActor (Changes) -> Void) {
        let client = PullClient { json in
            let changes = apply(bodyJSON: json)
            if changes.any { onChange(changes) }
        }
        // Held until the reply lands: nothing else refers to it. The client
        // drops itself in `deliver`, which is why this is not a `weak` box.
        holders.append(client)
        WorkerHost.shared.post(
            client: client, json: #"{"id":1,"msg":{"type":"pullAccountPrefs"}}"#)
    }

    fileprivate static func release(_ client: PullClient) {
        holders.removeAll { $0 === client }
    }

    /// Take one `pullAccountPrefs` reply, as raw JSON.
    @discardableResult
    static func apply(bodyJSON: String) -> Changes {
        guard let data = bodyJSON.data(using: .utf8),
              let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return Changes() }

        // The hub wraps its answers, and the two wrappers are not one bag.
        // `getSettings` carries this *device's* checkIntervalMin, which is the
        // core's default and never the reader's answer; the account's copy
        // comes back in `prefs`. Read together, whichever reply landed second
        // would win, and half the time that is 360 overwriting "every hour".
        // Nothing here reads `backendUrl` — `AppConfig` already has it.
        guard let prefs = body["prefs"] as? [String: Any] else { return Changes() }

        var changes = Changes()

        if let hosts = prefs["whitelist"] as? [Any] {
            let cleaned = hosts.compactMap { cleanHost("\($0)") }
            if cleaned != whitelist {
                whitelist = cleaned
                UserDefaults.standard.set(cleaned, forKey: whitelistKey)
                changes.whitelist = true
            }
        }

        if let minutes = number(prefs["checkIntervalMin"]), minutes > 0,
           minutes != checkIntervalMin {
            checkIntervalMin = minutes
            UserDefaults.standard.set(minutes, forKey: intervalKey)
            changes.interval = true
        }

        return changes
    }

    /// A host as the reader meant it, not as they typed it — the same
    /// normalisation `allowRules()` in shared/adblock.js does for Chrome, so a
    /// whitelist entry cannot mean one thing on the desktop and another here.
    static func cleanHost(_ raw: String) -> String? {
        var host = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        for scheme in ["https://", "http://"] where host.hasPrefix(scheme) {
            host = String(host.dropFirst(scheme.count))
        }
        if host.hasPrefix("www.") { host = String(host.dropFirst(4)) }
        if let cut = host.firstIndex(where: { $0 == "/" || $0 == ":" }) {
            host = String(host[host.startIndex..<cut])
        }
        return host.isEmpty ? nil : host
    }

    /// JSON numbers arrive as `NSNumber`, but a settings page that wrote the
    /// select's value straight through sends `"60"`.
    private static func number(_ value: Any?) -> Int? {
        if let n = value as? NSNumber { return n.intValue }
        if let s = value as? String { return Int(s) }
        return nil
    }

    private static var holders: [PullClient] = []
}

/// File scope for the same reason `CheckClient` is: a nested type would have to
/// reach back out by full name anyway.
@MainActor
private final class PullClient: PanelFlowClient {
    private var done: (@MainActor (String) -> Void)?
    init(done: @escaping @MainActor (String) -> Void) { self.done = done }
    func deliver(requestID: Int, bodyJSON: String) {
        let finish = done
        done = nil
        Settings.release(self)
        finish?(bodyJSON)
    }
    func emit(event: String, payloadJSON: String) {}
}

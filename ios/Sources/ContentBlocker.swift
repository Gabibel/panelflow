import WebKit

/// Compiles the bundled Safari content-blocker JSON into a WKContentRuleList
/// and attaches it to web views.
///
/// `blocker-rules.json` is generated from `shared/adblock-list.json`, the same
/// list the extension and the Android shell block from, so the three cannot
/// disagree about what an ad is.
///
/// It is the *bundled* list, and only that: the backend serves a newer one at
/// `/api/adblock` and the Chrome extension installs it without an update, but
/// nothing here fetches it yet. Until it does, a filter-list change reaches iOS
/// on the App Store's schedule.
final class ContentBlocker {
    static let shared = ContentBlocker()
    private var compiled: WKContentRuleList?

    func compile(completion: @escaping (Error?) -> Void) {
        guard let url = Bundle.main.url(forResource: "blocker-rules", withExtension: "json"),
              let json = try? String(contentsOf: url) else {
            completion(nil); return
        }
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "panelflow-adblock",
            encodedContentRuleList: json
        ) { [weak self] list, error in
            self?.compiled = list
            completion(error)
        }
    }

    func attach(to controller: WKUserContentController) {
        if let list = compiled { controller.add(list) }
    }
}

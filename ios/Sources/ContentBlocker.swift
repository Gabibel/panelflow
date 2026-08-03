import WebKit

/// Compiles the bundled Safari content-blocker JSON into a WKContentRuleList
/// and attaches it to web views. Rules are refreshed from the backend's
/// remote config endpoint; a bundled copy ships as fallback.
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

import Foundation
import WebKit

/// The generated rule file was not in the bundle, so nothing is being blocked.
///
/// A distinct type rather than `nil`: both callers today discard the result, but
/// "there is no list" and "the list compiled" must not stay the same answer —
/// that is how Safari ended up reporting success while blocking nothing.
struct MissingRules: Error {
    var localizedDescription: String { "blocker-rules.json is missing from the app bundle" }
}

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
///
/// The reader's whitelist is not bundled — it is an account setting, it changes
/// without a release, and it is compiled in on top of the list. See
/// `exemptions(for:)`.
final class ContentBlocker {
    static let shared = ContentBlocker()
    private var compiled: WKContentRuleList?
    /// The whitelist the current `compiled` was built from, so a `getSettings`
    /// reply that confirms it does not recompile the list for nothing.
    private var builtFor: [String]?

    /// - Parameter whitelist: hosts to stop blocking on, already normalised by
    ///   `Settings.cleanHost`. Passed in rather than read, because `Settings`
    ///   is main-actor and this is not.
    func compile(whitelist: [String] = [], completion: @escaping (Error?) -> Void) {
        if builtFor == whitelist, compiled != nil { completion(nil); return }
        // `blocker-rules.json` is generated (scripts/build-adblock.mjs) and
        // bundled by ios/Scripts/bundle-assets.sh, so the way it goes missing is
        // a build mistake, not a runtime one — and this used to answer
        // `completion(nil)`, which means *success*. The reader then browsed with
        // no ad blocking at all and every layer above was told it worked.
        //
        // docs/ARCHITECTURE.md states the rule for Chrome in as many words: "an
        // empty list must never be mistaken for a list that blocks nothing."
        // Safari was quietly exempt from it. It still cannot block anything
        // without the file — there is no bundled fallback to fall back to — but
        // it no longer claims otherwise.
        guard let url = Bundle.main.url(forResource: "blocker-rules", withExtension: "json"),
              let json = try? String(contentsOf: url) else {
            NSLog("[panelflow] blocker-rules.json is missing from the bundle — "
                + "nothing is being blocked. Check ios/Scripts/bundle-assets.sh ran.")
            completion(MissingRules())
            return
        }
        let rules = merge(json, with: exemptions(for: whitelist))
        // The identifier has to move with the whitelist. WKContentRuleListStore
        // is a cache keyed by it: compiling twice under one name hands back the
        // first build, which is exactly the whitelist the reader just changed.
        let identifier = "panelflow-adblock-\(fingerprint(whitelist))"
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: identifier,
            encodedContentRuleList: rules
        ) { [weak self] list, error in
            if let list = list {
                self?.compiled = list
                self?.builtFor = whitelist
                self?.evict(keeping: identifier)
            }
            completion(error)
        }
    }

    func attach(to controller: WKUserContentController) {
        if let list = compiled { controller.add(list) }
    }

    // MARK: - the whitelist

    /// One `ignore-previous-rules` per whitelisted host.
    ///
    /// `if-domain` is matched against the *top-level* document, not against the
    /// host the request is going to, which is the same thing the extension's
    /// `allowAllRequests` on `main_frame`/`sub_frame` means: the reader is
    /// saying "on this site, stop blocking", not "stop blocking this server".
    /// The leading `*` is WebKit's spelling of "and its subdomains".
    ///
    /// They go last on purpose. `ignore-previous-rules` only cancels what was
    /// declared above it, so an exemption placed first would cancel nothing.
    private func exemptions(for whitelist: [String]) -> [String] {
        whitelist.map { host in
            let escaped = host.replacingOccurrences(of: "\"", with: "")
            return #"{"trigger":{"url-filter":".*","if-domain":["*\#(escaped)"]},"# +
                   #""action":{"type":"ignore-previous-rules"}}"#
        }
    }

    /// Append rules to the bundled array without parsing it.
    ///
    /// The generated file is written one rule per line and ends in `]`, and the
    /// rules being added are already JSON text. Decoding a few hundred rules
    /// into `[Any]` and re-encoding them would be a lot of work to produce the
    /// same string.
    private func merge(_ json: String, with extra: [String]) -> String {
        guard !extra.isEmpty else { return json }
        guard let close = json.lastIndex(of: "]") else { return json }
        let head = json[json.startIndex..<close].trimmingCharacters(in: .whitespacesAndNewlines)
        // An empty list is `[]`; anything else needs a comma before the additions.
        let separator = head == "[" ? "\n  " : ",\n  "
        return head + separator + extra.joined(separator: ",\n  ") + "\n]\n"
    }

    /// A stable short name for one whitelist.
    ///
    /// FNV-1a rather than the standard library's hashing: Swift seeds its
    /// hasher per process, so the identifier would change on every launch and
    /// every launch would recompile the whole list.
    private func fingerprint(_ whitelist: [String]) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in whitelist.joined(separator: ",").utf8 {
            hash = (hash ^ UInt64(byte)) &* 0x100000001b3
        }
        return String(hash, radix: 16)
    }

    /// Drop the builds this one replaced. Left alone, the store keeps every
    /// whitelist the reader ever had.
    private func evict(keeping identifier: String) {
        WKContentRuleListStore.default().getAvailableContentRuleListIdentifiers { ids in
            for stale in ids ?? []
            where stale != identifier && stale.hasPrefix("panelflow-adblock") {
                WKContentRuleListStore.default().removeContentRuleList(forIdentifier: stale) { _ in }
            }
        }
    }
}

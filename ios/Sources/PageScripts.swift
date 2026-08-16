import WebKit

/// The scripts injected into pages the user browses — the same files the Chrome
/// extension ships, in the same order its manifest lists them.
///
/// They are read from the app bundle, where `Scripts/bundle-assets.sh` put them
/// straight from `extension/content/`. Nothing is forked or adapted:
/// `chrome-shim.js` provides the five `chrome.*` APIs they use and that is the
/// entire mobile-specific layer. If reader behaviour differs between the phone
/// and the browser, it is a bug in the shim, not a difference in the reader.
enum PageScripts {

    /// Injected at document start. `popup-guard.js` neuters the `window.open`
    /// storms scan sites fire on first tap, so it is worth nothing if it lands
    /// after the page has already opened them.
    ///
    /// `report-failure.js` comes first because it is what every other file's
    /// catch clause calls — including, at the cost of nothing but a console
    /// line, its own.
    private static let early = ["report-failure", "popup-guard", "chrome-shim"]

    /// The engine, once there is a document for it to look at.
    private static let late = ["series-match", "site-rules", "detect", "library-modal", "reader"]

    /// Every user script, in injection order, ready for a content controller.
    static func userScripts() -> [WKUserScript] {
        var scripts = early.map { script(name: "\($0).js", source: read($0), at: .atDocumentStart) }
        scripts += late.map { script(name: "\($0).js", source: read($0), at: .atDocumentEnd) }
        scripts.append(script(name: "reader.css",
                              source: readFile("reader", ext: "css").map(styleInjector),
                              at: .atDocumentEnd))
        return scripts
    }

    /// One file, wrapped so a failure in it does not stop the next: a scan site
    /// that breaks detect.js must not also cost the user the reader.
    ///
    /// A `nil` source is a file missing from the bundle, and it is thrown rather
    /// than dropped. Dropping it is what used to happen, and it made the one
    /// build mistake nobody would ever notice — an asset silently absent —
    /// indistinguishable from everything working.
    private static func script(name: String, source: String?,
                               at time: WKUserScriptInjectionTime) -> WKUserScript {
        let body = (source?.isEmpty == false) ? source! : "throw new Error('missing from the bundle');"
        // The fallback in the catch matters: this same clause guards
        // report-failure.js itself, and a console line is all that is left when
        // the reporter is what failed.
        return WKUserScript(
            source: """
            try{
            \(body)
            }catch(e){if(window.PanelFlowFailed)window.PanelFlowFailed('\(name)',e);\
            else console.warn('panelflow: \(name) failed',e)}
            """,
            injectionTime: time,
            forMainFrameOnly: true
        )
    }

    /// The extension gets reader.css from its manifest; here it has to be put
    /// in by hand, and idempotently — user scripts re-run on every navigation.
    private static func styleInjector(_ css: String) -> String {
        """
        if(!document.getElementById('panelflow-reader-css')){
          var s=document.createElement('style');
          s.id='panelflow-reader-css';
          s.textContent=\(quote(css));
          (document.head||document.documentElement).appendChild(s);
        }
        """
    }

    private static func read(_ name: String) -> String? { readFile(name, ext: "js") }

    private static func readFile(_ name: String, ext: String) -> String? {
        guard let url = Bundle.main.url(forResource: name, withExtension: ext,
                                        subdirectory: "inject")
        else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }
}

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
    private static let early = ["popup-guard", "chrome-shim"]

    /// The engine, once there is a document for it to look at.
    private static let late = ["series-match", "detect", "library-modal", "reader"]

    /// Every user script, in injection order, ready for a content controller.
    static func userScripts() -> [WKUserScript] {
        var scripts = early.compactMap { script(source: read($0), at: .atDocumentStart) }
        scripts += late.compactMap { script(source: read($0), at: .atDocumentEnd) }
        if let css = readFile("reader", ext: "css"),
           let style = script(source: styleInjector(css), at: .atDocumentEnd) {
            scripts.append(style)
        }
        return scripts
    }

    private static func script(source: String?, at time: WKUserScriptInjectionTime) -> WKUserScript? {
        guard let source, !source.isEmpty else { return nil }
        // Each file is wrapped so a failure in one does not stop the next: a
        // scan site that breaks detect.js must not also cost the user the reader.
        return WKUserScript(
            source: "try{\n\(source)\n}catch(e){console.warn('panelflow: injected script failed',e)}",
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

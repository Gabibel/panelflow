// The in-app browser: a WebView with the extension inside it.
//
// This is the whole architectural bet, on a third platform. The scripts
// injected below are `extension/content/*.js` — byte for byte the files Chrome
// loads as content scripts — and the only mobile-specific line in the set is
// `chrome-shim.js`, which answers the five `chrome.*` calls they make. So if
// the reader behaves differently here than in the browser, that is a bug in the
// shim or in this file, not a fork of the reader.
//
// What crosses between the page and the app, both ways:
//
//   { id, msg }                 the page asking (chrome.runtime.sendMessage)
//   { event, ... }              unprompted: a script that failed, a state poll
//
// The same protocol the Kotlin and Swift shells speak, because it is the same
// JavaScript on the other side of it. Those two also carry a third envelope —
// `{ reply: { id, body } }`, the page answering something the shell asked it —
// and this shell no longer needs it: the toolbar buttons that used to ask
// questions of the page are gone, and back is told rather than asked. The shim
// still supports it if a screen here ever wants an answer again.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, BackHandler, Platform, Pressable, Share, StyleSheet, Text, View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { early, late } from '../../generated/injected.js';
import { sendFromPage } from '../core.js';
import { currentLang, t } from '../i18n.js';

/**
 * Ask the page's content scripts something — the phone's version of the
 * extension popup messaging the active tab.
 */
const dispatchScript = (json, replyId) =>
  `try{window.PanelFlowPage&&window.PanelFlowPage.dispatch(${json},${replyId})}catch(e){};true;`;

// The toolbar needs to know two things the page owns: whether a chapter was
// detected here, and whether the reader is already open. There is no event for
// either, so the page is asked — cheaply, and only while the browser is up.
// One more look at a page whose strip may have arrived after the verdict did.
// A no-op while the reader is open — see detect.js, which refuses it there.
const RESCAN = `try{window.__panelflowDetect&&window.__panelflowDetect.rescan&&window.__panelflowDetect.rescan()}catch(e){};true;`;

const POLL = `(function(){try{
  var s=window.PanelFlowPage&&window.PanelFlowPage.state&&window.PanelFlowPage.state();
  if(s&&window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({event:'state',state:s}));
}catch(e){}})();true;`;

export default function BrowserScreen({ initial, colors, onClose, onChanged, whitelist }) {
  const web = useRef(null);

  // `mobile/inject/i18n.js` reads this before `detect.js` draws its first
  // label. It can also find the answer on its own, by asking the store through
  // the shim — but that is a round trip, and the pill is drawn on a timer that
  // does not wait for it. This shell holds the account's language in its own
  // memory, so it can simply say so.
  const injected = useMemo(
    () => `window.PanelFlowLang=${JSON.stringify(currentLang())};
${late}`,
    [],
  );
  // The URL the late scripts were last put into, so an in-page navigation is
  // told apart from the load that already injected them.
  const injectedAt = useRef(initial);
  const rescanTimer = useRef(null);

  // Two URLs, on purpose. `source` is what the WebView is *told* to load and
  // only ever changes when something deliberately navigates it — a page asking
  // for another page. `url` is where it actually is, for the title bar. Feeding
  // the second back into the first is the classic way to get a WebView that
  // reloads itself forever: every in-page navigation would hand the component a
  // new `source` prop, which it answers by loading it again.
  const [source, setSource] = useState({ uri: initial });
  const [url, setUrl] = useState(initial);
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [page, setPage] = useState({ detected: false, readerOpen: false });

  // Android's back button is the browser's back button first, and only closes
  // the browser once there is no page behind. Anything else and back becomes a
  // way to lose your place by accident.
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // Innermost first: the reader, then the page's own history, then this
      // screen. Any other order and back is a way to lose your place.
      if (page.readerOpen) {
        web.current?.injectJavaScript(dispatchScript(JSON.stringify({ type: 'toggleReader' }), null));
        return true;
      }
      if (canGoBack) { web.current?.goBack(); return true; }
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [canGoBack, onClose, page.readerOpen]);

  useEffect(() => {
    const timer = setInterval(() => web.current?.injectJavaScript(POLL), 2000);
    return () => {
      clearInterval(timer);
      clearTimeout(rescanTimer.current);
    };
  }, []);

  const onMessage = async (event) => {
    let payload;
    try { payload = JSON.parse(event.nativeEvent.data); } catch { return; }

    if (payload.event) {
      if (payload.event === 'state') setPage(payload.state || {});
      // A script that did not survive this page. `report-failure.js` already
      // says so on the page itself; this is the half that reaches someone
      // reading a log rather than looking at a phone.
      if (payload.event === 'scriptFailed') {
        console.warn(`[panelflow] ${payload.file} failed on ${url}: ${payload.error}`);
      }
      return;
    }

    if (payload.id != null && payload.msg) {
      // Not `send`: this one came from a page the reader browsed to, and in a
      // WebView that page shares the shim's world. `sendFromPage` is the same
      // hub through a narrower door — see core.js, which says what it keeps out.
      const body = await sendFromPage(payload.msg, {
        // A page is allowed to ask for another page: that is how the reader's
        // "next chapter" and the library modal's links work. It lands in this
        // same WebView rather than opening a second browser.
        openUrl: (next) => setSource({ uri: next }),
        share: (link, name) => Share.share({ message: name ? `${name}\n${link}` : link }),
      });
      web.current?.injectJavaScript(
        `try{window.PanelFlowPage&&window.PanelFlowPage.deliver(${payload.id},${JSON.stringify(JSON.stringify(body ?? null))})}catch(e){};true;`,
      );
      // Anything that writes to the library has just changed what the shelf
      // behind this screen should be showing.
      if (/^(addToLibrary|removeFromLibrary|updateEntry|saveProgress|recordRead)$/.test(payload.msg.type)) {
        onChanged?.();
      }
    }
  };

  const bar = (label, onPress, disabled) => (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={8} style={styles.barButton}>
      <Text style={{ color: disabled ? colors.line : colors.text, fontSize: 15 }}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      {/* The reader is the whole screen, because that is what it is for. Its
          own chrome carries a ✕ (reader.js), and Android's back button closes
          it too — so hiding these two bars cannot strand anybody. */}
      {!page.readerOpen && (
        <View style={[styles.top, { borderColor: colors.line, backgroundColor: colors.surface }]}>
          {bar(t('actionBack'), onClose)}
          <Text numberOfLines={1} style={[styles.title, { color: colors.muted }]}>
            {title || url}
          </Text>
          {loading
            ? <ActivityIndicator color={colors.muted} />
            : bar('↻', () => web.current?.reload())}
        </View>
      )}

      <WebView
        ref={web}
        source={source}
        originWhitelist={['http://*', 'https://*']}
        // The injection split both native shells make: the guard and the shim
        // before the page's own scripts, the engine once there is a document.
        injectedJavaScriptBeforeContentLoaded={`window.PanelFlowAdblockWhitelist=${
          JSON.stringify(whitelist || [])};
${early}`}
        injectedJavaScript={injected}
        onMessage={onMessage}
        // A scan site's first tap is a popunder. Chrome's declarativeNetRequest
        // is not available here and `popup-guard.js` handles what the page
        // opens itself; this is the other half — the schemes that are not
        // browsing at all.
        onShouldStartLoadWithRequest={(req) => {
          if (/^https?:/i.test(req.url) || req.url === 'about:blank') return true;
          console.warn(`[panelflow] blocked ${req.url.slice(0, 60)}`);
          return false;
        }}
        setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures
        pullToRefreshEnabled
        mediaPlaybackRequiresUserAction
        onLoadStart={() => setLoading(true)}
        onLoadEnd={(e) => {
          setLoading(false);
          // The WebView has just run `injectedJavaScript` for this document on
          // its own. Recording it here is what stops the in-page-navigation
          // branch below from parsing 350 kB of engine a second time, on the
          // one page load where it is guaranteed to be redundant.
          injectedAt.current = e.nativeEvent?.url ?? injectedAt.current;
          // Themesia, MangaStream and most of the rest build their strip from a
          // blob of JSON after the document is done. detect.js takes its verdict
          // once and then stops watching (see `accept`), so a strip that lands a
          // second late leaves a manga chapter judged as prose — the reader then
          // opens it as text, which is exactly what a phone reported. One more
          // look, once, and only while nobody is reading.
          clearTimeout(rescanTimer.current);
          rescanTimer.current = setTimeout(
            () => web.current?.injectJavaScript(RESCAN), 2500,
          );
        }}
        onNavigationStateChange={(nav) => {
          setUrl(nav.url);
          setTitle(nav.title || '');
          setCanGoBack(nav.canGoBack);
          // A site that changes chapter without loading a document gets no
          // `injectedJavaScript` of its own, and the reader would simply stop
          // appearing halfway through a series. Both native shells re-inject on
          // every in-page navigation for this reason, and every file in the set
          // is written to tolerate running twice — `report-failure.js` says so
          // in its first line.
          if (!nav.loading && nav.url && nav.url !== injectedAt.current) {
            injectedAt.current = nav.url;
            web.current?.injectJavaScript(`${late}\ntrue;`);
          }
        }}
        style={{ backgroundColor: colors.bg }}
      />

      {!page.readerOpen && (
      <View style={[styles.bottom, { borderColor: colors.line, backgroundColor: colors.surface }]}>
        {bar('‹', () => web.current?.goBack(), !canGoBack)}
        {bar('›', () => web.current?.goForward())}
        {/* No Read and no Add here any more. Both were the popup's buttons
            under another name, and on a phone they were the wrong shape: the
            reader now opens by itself on a chapter page (see
            `native/src/prefs.js`), and adding a series is what the pill and the
            reader's own bookmark button are for — in the page, where the series
            is. A toolbar button that is grey four times out of five is a
            toolbar button that teaches nothing. */}
        {bar('⇧', () => Share.share({ message: title ? `${title}\n${url}` : url }))}
      </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  top: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1, fontSize: 12 },
  bottom: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth,
  },
  barButton: { paddingVertical: 4, paddingHorizontal: 4 },
});

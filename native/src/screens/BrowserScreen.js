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
//   { reply: { id, body } }     the page answering something the toolbar asked
//   { event, ... }              unprompted: a script that failed, a state poll
//
// One id space, the same protocol the Kotlin and Swift shells speak, because it
// is the same JavaScript on the other side of it.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, BackHandler, Platform, Pressable, Share, StyleSheet, Text, View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { early, late } from '../../generated/injected.js';
import { send } from '../core.js';
import { t } from '../i18n.js';

/**
 * Ask the page's content scripts something — the phone's version of the
 * extension popup messaging the active tab.
 */
const dispatchScript = (json, replyId) =>
  `try{window.PanelFlowPage&&window.PanelFlowPage.dispatch(${json},${replyId})}catch(e){};true;`;

// The toolbar needs to know two things the page owns: whether a chapter was
// detected here, and whether the reader is already open. There is no event for
// either, so the page is asked — cheaply, and only while the browser is up.
const POLL = `(function(){try{
  var s=window.PanelFlowPage&&window.PanelFlowPage.state&&window.PanelFlowPage.state();
  if(s&&window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({event:'state',state:s}));
}catch(e){}})();true;`;

export default function BrowserScreen({ initial, colors, onClose, toast, onChanged }) {
  const web = useRef(null);
  const pending = useRef(new Map());
  const nextId = useRef(1);
  // The URL the late scripts were last put into, so an in-page navigation is
  // told apart from the load that already injected them.
  const injectedAt = useRef(initial);

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

  /** Ask the page, and wait for the answer the shim routes back. */
  const ask = useCallback((msg) => new Promise((resolve) => {
    const id = nextId.current++;
    // The reader can take a moment to decide; a lost reply must not leave a
    // button spinning for the rest of the session.
    const timer = setTimeout(() => {
      if (pending.current.delete(id)) resolve(null);
    }, 15000);
    pending.current.set(id, { resolve, timer });
    web.current?.injectJavaScript(dispatchScript(JSON.stringify(msg), id));
  }), []);

  // Android's back button is the browser's back button first, and only closes
  // the browser once there is no page behind. Anything else and back becomes a
  // way to lose your place by accident.
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack) { web.current?.goBack(); return true; }
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [canGoBack, onClose]);

  useEffect(() => {
    const timer = setInterval(() => web.current?.injectJavaScript(POLL), 1500);
    return () => clearInterval(timer);
  }, []);

  const onMessage = async (event) => {
    let payload;
    try { payload = JSON.parse(event.nativeEvent.data); } catch { return; }

    if (payload.reply) {
      const entry = pending.current.get(payload.reply.id);
      if (!entry) return;
      pending.current.delete(payload.reply.id);
      clearTimeout(entry.timer);
      entry.resolve(payload.reply.body);
      return;
    }

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
      const body = await send(payload.msg, {
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
      <View style={[styles.top, { borderColor: colors.line, backgroundColor: colors.surface }]}>
        {bar(t('actionBack'), onClose)}
        <Text numberOfLines={1} style={[styles.title, { color: colors.muted }]}>
          {title || url}
        </Text>
        {loading ? <ActivityIndicator color={colors.muted} /> : bar('↻', () => web.current?.reload())}
      </View>

      <WebView
        ref={web}
        source={source}
        originWhitelist={['http://*', 'https://*']}
        // The injection split both native shells make: the guard and the shim
        // before the page's own scripts, the engine once there is a document.
        injectedJavaScriptBeforeContentLoaded={early}
        injectedJavaScript={late}
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
        onLoadEnd={() => setLoading(false)}
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

      <View style={[styles.bottom, { borderColor: colors.line, backgroundColor: colors.surface }]}>
        {bar('‹', () => web.current?.goBack(), !canGoBack)}
        {bar('›', () => web.current?.goForward())}
        {/* The two things the toolbar exists for, and both are the popup's own
            buttons under another name. */}
        {bar(
          page.readerOpen ? t('actionDone') : t('actionRead'),
          async () => {
            const r = await ask({ type: 'toggleReader' });
            if (r && r.ok === false && r.error) toast(r.error);
          },
          !page.detected && !page.readerOpen,
        )}
        {bar(t('popupAddToLibrary'), async () => {
          await ask({ type: 'openLibraryModal' });
          onChanged?.();
        })}
        {bar('⇧', () => Share.share({ message: title ? `${title}\n${url}` : url }))}
      </View>
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

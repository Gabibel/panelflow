// The browser nobody sees, that keeps chapters for offline reading.
//
// A chapter is saved by the reader, from the pages it has open
// (extension/content/reader.js, saveChapterNow): that is the one place that
// knows how a site hands its pages over, with the reader's cookies, through
// every rule the in-app browser follows. So a chapter picked in a series'
// offline list (screens/OfflineChaptersScreen.js) is saved the same way: this
// opens it in a WebView of its own, with the same scripts and the same key as
// the visible browser (../web-inject.js), waits for the reader, and asks it,
// with the app's signed command, to save what it has. One chapter at a time,
// in the order the queue (../offline-queue.js) gives.
//
// Invisible and untouchable rather than off screen: a WebView with no size
// lays nothing out, and the detector reads the page's layout. It sits behind
// everything at the size of the screen, at no opacity, taking no touches.
//
// The reader inside it is a reader that saves, not one that reads: what it
// may ask the app is HIDDEN_PAGE_TYPES, so it cannot move the bookmark, file
// the chapter as read or push anything to a tracker.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { blockedHosts, blockedImageHosts, early, late } from '../../generated/injected.js';
import { decide } from '../navigation-policy.js';
import { sendFromPage } from '../core.js';
import { currentLang } from '../i18n.js';
import * as diagnostics from '../diagnostics.js';
import {
  POLL, commandScript, deliverScript, dispatchScript, keyed, pageKey,
} from '../web-inject.js';
import { HIDDEN_PAGE_TYPES, saveQueue } from '../offline-queue.js';

/** How long a loaded page has to show its chapter in the reader. */
const READER_WAIT_MS = 30000;
/** How long a detected chapter is given to open its reader by itself. */
const NUDGE_AFTER_MS = 5000;
/** A moment for the reader's pages to settle before it is asked to save them. */
const SETTLE_MS = 1500;
/** Where the queue writes down what is left to do; the device's, not the account's. */
const QUEUE_KEY = 'pf-device:offlineQueue';

const queueStorage = {
  load: async () => JSON.parse((await AsyncStorage.getItem(QUEUE_KEY)) || '[]'),
  save: (jobs) => AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(jobs)),
};

export default function OfflineSaver({ whitelist }) {
  const web = useRef(null);
  const secret = useMemo(pageKey, []);
  // `{ url, n }`: the chapter on the hidden page, or none.
  const [job, setJob] = useState(null);
  const [life, setLife] = useState(0);
  // The one attempt under way: its answer, and how it ends.
  const pending = useRef(null);
  const here = useRef('');
  const asked = useRef('');

  const injected = useMemo(
    () => keyed(`window.PanelFlowLang=${JSON.stringify(currentLang())};
${late}`, secret, { late: true }),
    [secret],
  );
  const whitelistKey = JSON.stringify(whitelist || []);
  const nativeAdblock = useMemo(() => ({
    panelflowAdblock: { hosts: blockedHosts, imageHosts: blockedImageHosts, whitelist: JSON.parse(whitelistKey) },
  }), [whitelistKey]);

  const finish = (result) => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    clearTimeout(p.timer);
    clearTimeout(p.settle);
    setJob(null);
    p.resolve(result);
  };

  // The queue's driver: one chapter, opened here, answered by its reader.
  useEffect(() => {
    saveQueue.setStorage(queueStorage);
    saveQueue.setDriver((next) => new Promise((resolve) => {
      finish({ ok: false, error: 'replaced' });
      pending.current = {
        resolve,
        replyId: Math.floor(Math.random() * 1e9),
        asked: false,
        nudged: false,
        timer: setTimeout(() => finish({ ok: false, error: 'no-reader' }), READER_WAIT_MS),
      };
      here.current = '';
      asked.current = next.url;
      setJob(next);
      setLife((n) => n + 1);
    }));
    // What a closed app left to do, taken up again.
    saveQueue.restore();
    return () => saveQueue.setDriver(null);
  }, []);

  // Back from the background: a page the system stopped while the app was
  // away is loaded again rather than waited on.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !pending.current) return;
      const p = pending.current;
      if (p.asked) return;
      clearTimeout(p.timer);
      p.timer = setTimeout(() => finish({ ok: false, error: 'no-reader' }), READER_WAIT_MS);
      setLife((n) => n + 1);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!job) return undefined;
    const timer = setInterval(() => web.current?.injectJavaScript(POLL), 1000);
    return () => clearInterval(timer);
  }, [job]);

  const onMessage = async (event) => {
    let payload;
    try { payload = JSON.parse(event.nativeEvent.data); } catch { return; }
    const p = pending.current;

    // The reader's answer to "save this chapter": only with the key.
    if (payload.reply) {
      if (payload.k !== secret) return;
      if (p && payload.reply.id === p.replyId) finish(payload.reply.body || { ok: false, error: 'no-answer' });
      return;
    }

    if (payload.event === 'state' && p && !p.asked) {
      const state = payload.state || {};
      // Detected and still not open a few seconds on: opened the way the
      // toolbar would. Not at once: the reader opens by itself on a phone,
      // and a toggle sent on a stale answer would close it.
      if (state.detected && !state.readerOpen && !p.nudged) {
        p.seenAt ??= Date.now();
        if (Date.now() - p.seenAt > NUDGE_AFTER_MS) {
          p.nudged = true;
          web.current?.injectJavaScript(dispatchScript(JSON.stringify({ type: 'toggleReader' }), null));
        }
      }
      if (state.readerOpen) {
        p.asked = true;
        // From here the save itself takes its time, a page after another;
        // the queue's own limit is the one that applies (../offline-queue.js).
        clearTimeout(p.timer);
        p.settle = setTimeout(() => {
          web.current?.injectJavaScript(commandScript(JSON.stringify({ type: 'saveOfflineNow' }), p.replyId, secret));
        }, SETTLE_MS);
      }
      return;
    }

    if (payload.id != null && payload.msg) {
      if (payload.k !== secret) return;
      // A reader that saves, not one that reads (see HIDDEN_PAGE_TYPES).
      if (!HIDDEN_PAGE_TYPES.has(payload.msg.type)) {
        web.current?.injectJavaScript(deliverScript(payload.id, null, secret));
        return;
      }
      const body = await sendFromPage(payload.msg, {
        pageUrl: here.current || asked.current,
        openUrl: () => {},
        share: () => {},
        goHome: () => {},
      });
      web.current?.injectJavaScript(deliverScript(payload.id, body, secret));
    }
  };

  if (!job) return null;
  return (
    <View pointerEvents="none" style={styles.hidden} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <WebView
        key={life}
        ref={web}
        source={{ uri: job.url }}
        originWhitelist={['http://*', 'https://*']}
        injectedJavaScriptBeforeContentLoaded={`window.PanelFlowAdblockWhitelist=${whitelistKey};
${keyed(early, secret)}`}
        injectedJavaScript={injected}
        injectedJavaScriptObject={nativeAdblock}
        injectedJavaScriptForMainFrameOnly={false}
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={(req) => decide(req, {
          here: here.current, asked: asked.current, trusted: [], blocked: blockedHosts, stores: [],
        }).allow}
        onNavigationStateChange={(nav) => {
          if (!nav.loading && nav.url) here.current = nav.url;
        }}
        onHttpError={(e) => {
          if ((e.nativeEvent?.statusCode || 0) >= 500) finish({ ok: false, error: `http ${e.nativeEvent.statusCode}` });
        }}
        onError={() => finish({ ok: false, error: 'load' })}
        onRenderProcessGone={() => finish({ ok: false, error: 'renderer' })}
        onContentProcessDidTerminate={() => finish({ ok: false, error: 'renderer' })}
        setSupportMultipleWindows={false}
        mediaPlaybackRequiresUserAction
        onLoadEnd={() => diagnostics.note('offline', `hidden page loaded: ${job.url}`)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { ...StyleSheet.absoluteFillObject, opacity: 0, zIndex: -1 },
});

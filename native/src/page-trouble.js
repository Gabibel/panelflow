// When the in-app browser has nothing to show (iPhone tests, 2026-10-22).
//
// Two pages left a black screen and no word on it. sushiscan.fr answered "504
// Gateway Time-out": the WebView showed what the gateway sent, and the screen
// said nothing about a site being down. asurascans.com was up and still black:
// it sends its <body> with an inline `opacity:0` on a near-black background and
// counts on its stylesheet, or a three-second timer, to reveal it. Neither was
// looked at, so the dark theme's background behind the WebView was all there
// was to see. BrowserScreen.js now covers such a page with a message and a
// Retry button.
//
// Three kinds:
//   server       the page itself answered 5xx (react-native-webview reports
//                `onHttpError` for the main frame only, on both platforms)
//   unreachable  the load failed outright: no answer, no DNS, no TLS
//   empty        the page loaded and, a few seconds later, shows nothing
//
// A 4xx is left alone: a 404 is the site's own page, with its own words and
// its own links back.
//
// No import, so a test runs it as it is.

/** How long a loaded page has to show something before it counts as empty. */
export const EMPTY_AFTER_MS = 8000;

/**
 * What the page looks like, asked of the top document. Posted as
 * `{ event: 'probe', probe }`; the screen hands `probe` to `trouble`.
 * Effective opacity: an element under an opacity of 0 is invisible however
 * much text it holds, and `innerText` still counts that text.
 */
export const PROBE = `(function(){try{
  if(!window.ReactNativeWebView||window.top!==window)return;
  var s=window.PanelFlowPage&&window.PanelFlowPage.state&&window.PanelFlowPage.state();
  var d=document,b=d.body,o=1,hidden=!b;
  for(var n=b;n&&n.nodeType===1;n=n.parentElement){
    var c=getComputedStyle(n);
    if(c.display==='none'||c.visibility==='hidden')hidden=true;
    o*=parseFloat(c.opacity)||0;
  }
  var media=0,all=b?b.querySelectorAll('img,video,canvas,svg,iframe,picture'):[];
  for(var i=0;i<all.length&&media<20;i++){var r=all[i].getBoundingClientRect();if(r.width*r.height>2500)media++;}
  window.ReactNativeWebView.postMessage(JSON.stringify({event:'probe',probe:{
    readerOpen:!!(s&&s.readerOpen),text:b?(b.innerText||'').trim().length:0,media:media,opacity:o,hidden:hidden}}));
}catch(e){}})();true;`;

/** Whether a probed page shows anything at all. */
function looksEmpty(probe) {
  if (!probe || probe.readerOpen) return false;
  if (probe.hidden || !(probe.opacity > 0.05)) return true;
  return !probe.text && !probe.media;
}

/**
 * What is wrong with the page, or null.
 *
 * `httpStatus` from `onHttpError`, `loadError` from `onError`, `probe` from
 * PROBE. The server's answer wins over the look of the page: a gateway's error
 * page has words on it and is still an error.
 */
export function trouble({ httpStatus, loadError, probe } = {}) {
  if (httpStatus >= 500 && httpStatus <= 599) return { kind: 'server', status: httpStatus };
  if (loadError) return { kind: 'unreachable' };
  if (looksEmpty(probe)) return { kind: 'empty' };
  return null;
}

/** The two lines the screen shows, through the app's `t`. */
export function troubleText(found, t) {
  if (found.kind === 'server') {
    return { title: t('mobileBrowserSiteDown', [String(found.status)]), hint: t('mobileBrowserSiteDownHint') };
  }
  if (found.kind === 'unreachable') {
    return { title: t('mobileBrowserSiteUnreachable'), hint: t('mobileBrowserSiteDownHint') };
  }
  return { title: t('mobileBrowserPageEmpty'), hint: t('mobileBrowserPageEmptyHint') };
}

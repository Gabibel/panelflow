// The shelf of chapters kept on this device.
//
// This page exists because of one constraint: a saved page is a Blob, and a
// Blob cannot cross chrome's messaging channel — it is JSON, so the bytes would
// arrive as `{}`. Saving works over messages because base64 is a string, but
// *reading* cannot, so whatever displays a saved chapter has to run on the same
// origin as the database. That is an extension page, and this is it.
'use strict';

const { createOfflineStore, idbBackend } = window.PanelFlowOffline;
const store = createOfflineStore(idbBackend(indexedDB));

const list = document.getElementById('list');
const empty = document.getElementById('empty');
const usageLine = document.getElementById('usage');

// Blob URLs for the chapter currently open. They pin the whole chapter's bytes
// in memory until revoked, and the reader is handed them rather than the blobs.
let openUrls = [];

function releaseOpen() {
  for (const u of openUrls) URL.revokeObjectURL(u);
  openUrls = [];
}
addEventListener('pagehide', releaseOpen);

const human = (bytes) => {
  if (!bytes) return '—';
  const units = ['B', 'kB', 'MB', 'GB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
};

const when = (ms) => {
  const days = Math.floor((Date.now() - ms) / 86400000);
  return days < 1 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
};

async function read(meta) {
  const saved = await store.get(meta.chapterUrl);
  if (!saved) return render(); // deleted in another tab
  releaseOpen();
  if (saved.meta.kind === 'text') {
    window.PanelFlowReader.openText(saved.meta.paragraphs || [], saved.meta, {});
    return;
  }
  openUrls = saved.pages.map((b) => URL.createObjectURL(b));
  // An empty rule object, not the site's: the detection rule described how to
  // find the pages on a live page, and there is no live page here.
  window.PanelFlowReader.open(openUrls, saved.meta, {});
}

async function remove(meta) {
  await store.remove(meta.chapterUrl);
  render();
}

function chapterRow(meta) {
  const row = document.createElement('div');
  row.className = 'chapter';

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = meta.chapterLabel || meta.chapterUrl;
  row.appendChild(label);

  const info = document.createElement('span');
  info.className = 'meta';
  info.textContent = meta.kind === 'text'
    ? `${meta.pageCount} paragraphs · ${when(meta.savedAt)}`
    : `${meta.pageCount} pages · ${human(meta.bytes)} · ${when(meta.savedAt)}`;
  row.appendChild(info);

  const open = document.createElement('button');
  open.textContent = 'Read';
  open.addEventListener('click', () => read(meta));
  row.appendChild(open);

  const del = document.createElement('button');
  del.className = 'ghost';
  del.textContent = 'Remove';
  del.addEventListener('click', () => remove(meta));
  row.appendChild(del);

  return row;
}

async function render() {
  const chapters = await store.list();
  list.textContent = '';
  empty.hidden = chapters.length > 0;

  const { bytes } = await store.usage();
  usageLine.textContent = chapters.length
    ? `${chapters.length} chapter${chapters.length === 1 ? '' : 's'} · ${human(bytes)} on this device`
    : '';

  // Grouped by series, in the order the list arrived — which is newest first,
  // so the series you last saved from is the one at the top.
  const groups = new Map();
  for (const meta of chapters) {
    const key = meta.sourceUrl || meta.chapterUrl;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(meta);
  }

  for (const [, metas] of groups) {
    const box = document.createElement('div');
    box.className = 'series';

    const head = document.createElement('h2');
    head.textContent = metas[0].title || metas[0].sourceUrl || 'Unknown series';
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `${metas.length} chapter${metas.length === 1 ? '' : 's'}`;
    head.appendChild(count);
    box.appendChild(head);

    // Oldest chapter first inside a series: that is reading order, and it is not
    // the order the list itself uses.
    for (const meta of metas.slice().reverse()) box.appendChild(chapterRow(meta));
    list.appendChild(box);
  }
}

// Pages left over from a save that was interrupted are dead weight, and this is
// the one screen that reports how much room the saved chapters take — so the
// number it shows should not include bytes nothing can read.
store.sweep().catch(() => {}).then(render);

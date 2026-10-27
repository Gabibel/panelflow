// Every chapter of a series, to pick the ones to keep for offline reading.
//
// Opened from the series' sheet (EntrySheet.js, "Hors ligne"), as the dark
// redesign drew it (owner, October 2026): the read chapters greyed, the ones
// already kept marked and left out of the choice, a box on every other row,
// and three quick choices: the unread ones, all of them, none. No limit on how
// many: the space on the phone is the limit, and the queue says when it is
// reached (../offline-queue.js).
//
// The list comes from the core (`seriesChapters`: the series page's own links
// and the chapters worked out from the bookmark); the saving is the queue's,
// which hands each chapter to the hidden browser (../components/OfflineSaver.js).
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, FlatList, Pressable, StyleSheet, View,
} from 'react-native';
import Text from '../components/Text.js';
import Icon from '../components/Icon.js';
import { Button } from '../ui.js';
import { send } from '../core.js';
import { t } from '../i18n.js';
import { bytes as fmtBytes } from '../format.js';
import { Match } from '../shared.js';
import { offlineSpace } from '../offline.js';
import { saveQueue } from '../offline-queue.js';

export default function OfflineChaptersScreen({ entry, colors, onClose }) {
  const [chapters, setChapters] = useState(null);
  const [usage, setUsage] = useState({ bytes: 0 });
  // The cap that applies now: the free one, or Premium's (../offline.js).
  const [cap, setCap] = useState(null);
  const [retention, setRetention] = useState(90);
  const [picked, setPicked] = useState(() => new Set());
  const [mode, setMode] = useState(null);
  const [queue, setQueue] = useState(saveQueue.snapshot());

  useEffect(() => saveQueue.subscribe(setQueue), []);

  const load = async () => {
    const list = await send({ type: 'offlineList' });
    if (list?.retentionDays) setRetention(list.retentionDays);
    const saved = (list?.chapters || [])
      .filter((c) => Match.sameSeries(c.sourceUrl, entry.sourceUrl))
      .map((c) => c.chapterUrl);
    setUsage((await send({ type: 'offlineUsage' })) || { bytes: 0 });
    setCap((await offlineSpace().catch(() => null))?.cap ?? null);
    const r = await send({ type: 'seriesChapters', sourceUrl: entry.sourceUrl, saved });
    setChapters(r?.chapters || []);
  };
  useEffect(() => { load(); }, [entry.sourceUrl]);

  // A chapter kept since the list was read is kept now: the queue says so.
  const lastSaved = queue.saved;
  useEffect(() => { if (lastSaved) load(); }, [lastSaved]);

  const stateOf = useMemo(() => {
    const map = new Map();
    for (const j of queue.jobs) map.set(j.url, j.state);
    return map;
  }, [queue]);

  const open = (chapters || []).filter((c) => !c.saved && stateOf.get(c.url) !== 'waiting' && stateOf.get(c.url) !== 'saving');
  const unread = open.filter((c) => !c.read);
  const choose = (list, which) => { setPicked(new Set(list.map((c) => c.url))); setMode(which); };
  const toggle = (url) => {
    setMode(null);
    setPicked((was) => {
      const next = new Set(was);
      if (next.has(url)) next.delete(url); else next.add(url);
      return next;
    });
  };

  const count = [...picked].filter((url) => open.some((c) => c.url === url)).length;
  const keep = () => {
    const rows = open.filter((c) => picked.has(c.url));
    saveQueue.add(rows.map((c) => ({
      url: c.url, n: c.n, label: t('mobileOfflineChapter', [String(c.n)]),
      sourceUrl: entry.sourceUrl, title: entry.title,
    })));
    setPicked(new Set());
    setMode(null);
  };

  const chip = (label, on, onPress) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!on }}
      hitSlop={{ top: 6, bottom: 6 }}
      style={[styles.chip, { backgroundColor: on ? colors.text : colors.surfaceHi }]}
    >
      <Text style={[styles.chipText, { color: on ? colors.bg : colors.text }]}>{label}</Text>
    </Pressable>
  );

  const row = ({ item: c }) => {
    const queued = stateOf.get(c.url);
    const label = t('mobileOfflineChapter', [String(c.n)]);
    if (c.saved || queued) {
      const said = c.saved || queued === 'saved' ? t('mobileOfflineSaved')
        : queued === 'saving' ? t('mobileOfflineSaving')
          : queued === 'failed' ? t('mobileOfflineFailed') : t('mobileOfflineQueued');
      const tint = queued === 'failed' ? colors.danger : colors.accent;
      return (
        <View style={[styles.row, { borderColor: colors.surfaceHi }]} accessible accessibilityLabel={`${label}, ${said}`}>
          <Icon name="saved" size={22} color={tint} />
          <Text style={[styles.rowText, { color: colors.text }]}>{label}</Text>
          <Text style={[styles.rowNote, { color: tint }]}>{said}</Text>
        </View>
      );
    }
    const on = picked.has(c.url);
    return (
      <Pressable
        onPress={() => toggle(c.url)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: on }}
        accessibilityLabel={c.read ? `${label}, ${t('mobileOfflineRead')}` : label}
        style={[styles.row, { borderColor: colors.surfaceHi }]}
      >
        <View style={[styles.box, { borderColor: on ? colors.accent : colors.fieldBorder, backgroundColor: on ? colors.accent : 'transparent' }]}>
          {on && <Icon name="check" size={16} color={colors.onAccent} />}
        </View>
        <Text style={[styles.rowText, { color: c.read ? colors.muted : colors.text }]}>{label}</Text>
        {c.read && <Text style={[styles.rowNote, { color: colors.muted }]}>{t('mobileOfflineRead')}</Text>}
      </Pressable>
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.surface }]}>
      <View style={styles.header}>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={t('actionBack')} hitSlop={8} style={styles.back}>
          <Text style={{ color: colors.text, fontSize: 24 }}>‹</Text>
        </Pressable>
        <View style={styles.headText}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('mobileOfflineTitle')}</Text>
          <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 13 }}>
            {chapters ? `${entry.title} · ${t('mobileOfflineCount', [String(chapters.length)])}` : entry.title}
          </Text>
        </View>
      </View>

      {chapters === null && (
        <View style={styles.wait}>
          <ActivityIndicator color={colors.muted} />
          <Text style={{ color: colors.muted }}>{t('mobileOfflineLoading')}</Text>
        </View>
      )}
      {chapters && chapters.length === 0 && (
        <Text style={[styles.empty, { color: colors.muted }]}>{t('mobileOfflineNoList')}</Text>
      )}
      {chapters && chapters.length > 0 && (
        <>
          <View accessibilityRole="toolbar" style={styles.chips}>
            {chip(t('mobileOfflineUnread', [String(unread.length)]), mode === 'unread', () => choose(unread, 'unread'))}
            {chip(t('mobileOfflineAll', [String(open.length)]), mode === 'all', () => choose(open, 'all'))}
            {chip(t('mobileOfflineNone'), false, () => choose([], null))}
          </View>
          <FlatList
            data={chapters}
            keyExtractor={(c) => c.url}
            renderItem={row}
            extraData={[picked, stateOf]}
            style={[styles.list, { borderColor: colors.line }]}
            initialNumToRender={20}
          />
        </>
      )}

      <View style={[styles.footer, { borderColor: colors.line }]}>
        <Text style={{ color: colors.muted, fontSize: 12 }}>
          {cap !== null && t('mobileOfflineSpace', [fmtBytes(usage.bytes), fmtBytes(cap), String(retention)])}
        </Text>
        <Button
          colors={colors}
          disabled={!count}
          label={!count ? t('mobileOfflinePick')
            : count === 1 ? t('mobileOfflineSaveOne') : t('mobileOfflineSaveN', [String(count)])}
          onPress={keep}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingTop: 12, paddingBottom: 6 },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headText: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 18, fontWeight: '800' },
  wait: { alignItems: 'center', gap: 10, paddingTop: 40 },
  empty: { fontSize: 14, lineHeight: 20, textAlign: 'center', paddingHorizontal: 24, paddingTop: 40 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  chip: { borderRadius: 18, paddingHorizontal: 14, minHeight: 36, justifyContent: 'center' },
  chipText: { fontSize: 13, fontWeight: '700' },
  list: { flex: 1, borderTopWidth: StyleSheet.hairlineWidth },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52,
    paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, fontSize: 15, fontWeight: '600' },
  rowNote: { fontSize: 12, fontWeight: '600' },
  footer: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12, gap: 6, borderTopWidth: StyleSheet.hairlineWidth },
});

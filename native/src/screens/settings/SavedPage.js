// The chapters kept on this phone, and a way to read them with no network.
//
// The counterpart of the extension's offline page (extension/offline/), on top
// of the same store (shared/offline-store.js, over the file system in
// native/src/offline.js). Two screens in one file because they are two halves
// of one thing: the list, and the reader that opens from it. Neither knows how
// a chapter was saved; that is the injected reader's job (reader.js, "Save
// offline"), and it lands here through the hub.
//
// The saved reader is deliberately the simplest thing that reads: a vertical
// strip of the pages, at the screen's width, each at its own height. The
// injected reader has modes, a chapter wheel and progress; this one has the
// pages, because the one moment it is used is the moment nothing else can be
// fetched, and a page that draws is worth more than a feature that might not.
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions,
} from 'react-native';
import { send } from '../../core.js';
import { MAX_BYTES } from '../../offline.js';
import { bytes as fmtBytes } from '../../format.js';
import { t } from '../../i18n.js';
import { Button, Empty, Hint } from '../../ui.js';

/** The list, grouped by series, newest save first inside each. */
export default function SavedPage({ colors, toast }) {
  const [chapters, setChapters] = useState(null);
  const [retention, setRetention] = useState(90);
  const [usage, setUsage] = useState({ chapters: 0, bytes: 0 });
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    // `offlineList` expires what has aged out before answering, so nothing
    // listed here is a chapter the store is about to drop.
    const r = await send({ type: 'offlineList' });
    setChapters(r?.chapters || []);
    if (r?.retentionDays) setRetention(r.retentionDays);
    setUsage((await send({ type: 'offlineUsage' })) || { chapters: 0, bytes: 0 });
  }, []);
  useEffect(() => { load(); }, [load]);

  const remove = (meta) => {
    Alert.alert(meta.title || t('offlineUnknownSeries'), meta.chapterLabel || '', [
      { text: t('actionCancel'), style: 'cancel' },
      {
        text: t('actionRemove'),
        style: 'destructive',
        onPress: async () => {
          await send({ type: 'offlineRemove', chapterUrl: meta.chapterUrl });
          toast(t('actionRemove'));
          load();
        },
      },
    ]);
  };

  if (chapters === null) return null;

  // One row per series, in the order of their newest save.
  const groups = [];
  for (const meta of chapters) {
    const key = meta.sourceUrl || meta.title || meta.chapterUrl;
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, title: meta.title || t('offlineUnknownSeries'), items: [] }; groups.push(g); }
    g.items.push(meta);
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Hint colors={colors}>{t('mobileSavedLede', [String(retention), fmtBytes(MAX_BYTES)])}</Hint>
      <Text style={[styles.usage, { color: colors.muted }]}>
        {t('offlineUsage', [
          t(usage.chapters === 1 ? 'offlineChapterOne' : 'offlineChapterMany', [String(usage.chapters)]),
          fmtBytes(usage.bytes),
          String(retention),
        ])}
      </Text>

      {groups.length === 0 && <Empty colors={colors}>{t('mobileSavedEmpty')}</Empty>}

      {groups.map((g) => (
        <View key={g.key} style={styles.group}>
          <Text style={[styles.series, { color: colors.text }]}>{g.title}</Text>
          {g.items.map((meta) => {
            const count = meta.kind === 'text'
              ? t(meta.pageCount === 1 ? 'offlineParagraphOne' : 'offlineParagraphMany', [String(meta.pageCount)])
              : t(meta.pageCount === 1 ? 'offlinePageOne' : 'offlinePageMany', [String(meta.pageCount)]);
            return (
              <Pressable
                key={meta.chapterUrl}
                onPress={() => setOpen(meta)}
                onLongPress={() => remove(meta)}
                accessibilityRole="button"
                accessibilityHint={t('actionOpen')}
                style={[styles.row, { borderColor: colors.line }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.label, { color: colors.text }]} numberOfLines={1}>
                    {meta.chapterLabel || meta.chapterUrl}
                  </Text>
                  <Text style={[styles.sub, { color: colors.muted }]}>
                    {count} · {fmtBytes(meta.bytes)}
                  </Text>
                </View>
                <Pressable
                  onPress={() => remove(meta)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={t('actionRemove')}
                >
                  <Text style={{ color: colors.muted, fontSize: 18 }}>✕</Text>
                </Pressable>
              </Pressable>
            );
          })}
        </View>
      ))}

      {open && <SavedReader meta={open} colors={colors} onClose={() => setOpen(null)} />}
    </ScrollView>
  );
}

/** One page of a saved chapter, drawn at the screen's width and its own height. */
function SavedImage({ page, width }) {
  // The height is asked of the image itself: a strip is only readable when
  // each panel keeps its shape. Until it answers, a page-shaped placeholder.
  const [ratio, setRatio] = useState(1.45);
  useEffect(() => {
    let alive = true;
    Image.getSize(page.uri, (w, h) => { if (alive && w && h) setRatio(h / w); }, () => {});
    return () => { alive = false; };
  }, [page.uri]);
  return <Image source={{ uri: page.uri }} style={{ width, height: Math.round(width * ratio) }} resizeMode="contain" />;
}

/**
 * The saved chapter, as a strip.
 *
 * Reads through the hub (`offlineGet`) rather than the store directly, so this
 * screen depends on one message and not on how the phone keeps files; the
 * pages come back as file URIs an <Image> can open with no network at all.
 */
export function SavedReader({ meta, colors, onClose }) {
  const { width } = useWindowDimensions();
  const [chapter, setChapter] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    send({ type: 'offlineGet', chapterUrl: meta.chapterUrl }).then((r) => {
      if (!alive) return;
      if (!r || r.error || !r.meta) setError(r?.error || 'missing');
      else setChapter(r);
    });
    return () => { alive = false; };
  }, [meta.chapterUrl]);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={[styles.reader, { backgroundColor: colors.bg }]}>
        <View style={[styles.readerBar, { borderColor: colors.line, backgroundColor: colors.surface }]}>
          <Text numberOfLines={1} style={[styles.readerTitle, { color: colors.text }]}>
            {meta.title} · {meta.chapterLabel}
          </Text>
          <Button colors={colors} kind="ghost" label={t('webClose')} onPress={onClose} />
        </View>
        {error && <Empty colors={colors}>{String(error)}</Empty>}
        {chapter && (
          <ScrollView contentContainerStyle={styles.strip}>
            {chapter.meta.kind === 'text'
              ? (chapter.meta.paragraphs || []).map((p, i) => (
                <Text key={i} style={[styles.paragraph, { color: colors.text }]}>{p}</Text>
              ))
              : chapter.pages.map((page, i) => <SavedImage key={i} page={page} width={width} />)}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 40 },
  usage: { fontSize: 13, marginBottom: 12 },
  group: { marginBottom: 18 },
  series: { fontSize: 15, fontWeight: '600', marginBottom: 4 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  label: { fontSize: 15 },
  sub: { fontSize: 12, marginTop: 2 },
  reader: { flex: 1 },
  readerBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    paddingLeft: 16, paddingRight: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  readerTitle: { flex: 1, fontSize: 14, fontWeight: '600' },
  strip: { paddingBottom: 40 },
  paragraph: { fontSize: 17, lineHeight: 27, paddingHorizontal: 18, marginVertical: 8 },
});

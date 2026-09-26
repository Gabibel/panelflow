// One series, everything about it, without leaving the shelf.
//
// The phone's answer to the extension's library modal. It used to be four
// buttons and a row of folders; a tester holding a tile wanted what the other
// readers give: the cover and the facts (where you are, what is out, what
// kind of work, its language, its status), your own score and note, what
// your trackers say about it. It is editable where a field is yours (folder,
// score, note). There is no "saved chapters" tab any more: a phone app that
// keeps copies of a site's pages is what App Store rule 5.2.3 refuses, so the
// app keeps none (QA and store review, September 2026).
//
// Every fact is read from where it already lives: the entry and the bookmark
// from the store, the trackers through `trackerEntry` (the same message the
// extension's sheet sends). The sheet writes through `updateEntry`, one field
// at a time, so a score set here is on the website before the sheet has closed.
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Folders, Shelf } from './shared.js';
import { send } from './core.js';
import { t } from './i18n.js';
import { Button, Field } from './ui.js';
import { statusColor } from './theme.js';
import Cover from './components/Cover.js';

const MEDIUM_KEY = {
  manga: 'mobileMediumManga', webtoon: 'popupGroupWebtoons', novel: 'popupGroupNovels', anime: 'mobileMediumAnime',
};
const SCORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** What the trackers say about this series: asked once per opening, never before. */
function useTrackerEntry(entry) {
  const [state, setState] = useState({ loading: true, entries: [], connected: [], errors: [] });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, entries: [], connected: [], errors: [] });
    send({ type: 'trackerEntry', title: entry.title })
      .then((r) => { if (alive) setState({ loading: false, ...(r || {}), entries: r?.entries || [], connected: r?.connected || [], errors: r?.errors || [] }); })
      .catch(() => { if (alive) setState({ loading: false, entries: [], connected: [], errors: [] }); });
    return () => { alive = false; };
  }, [entry.id, entry.title]);
  return state;
}

export default function EntrySheet({ entry, store, colors, onClose, onOpen, toast }) {
  if (!entry) return null;
  return <Sheet key={entry.id} entry={entry} store={store} colors={colors} onClose={onClose} onOpen={onOpen} toast={toast} />;
}

function Sheet({ entry, store, colors, onClose, onOpen, toast }) {
  const { categories, progress, targets, settings } = store;
  const target = targets[entry.id];
  const bookmark = progress[entry.sourceUrl];
  const [note, setNote] = useState(entry.note || '');
  const trackers = useTrackerEntry(entry);

  const patch = async (fields) => {
    await send({ type: 'updateEntry', id: entry.id, patch: fields });
    await store.refresh();
  };
  const file = async (folder) => { await patch({ folder }); onClose(); };

  const behind = (() => {
    try { return Math.round(Shelf.newChapters(entry, bookmark, categories)); } catch { return 0; }
  })();
  const medium = MEDIUM_KEY[entry.medium] ? t(MEDIUM_KEY[entry.medium]) : null;
  const pill = (label, on) => (
    <View key={label} style={[styles.pill, { borderColor: on ? colors.accent : colors.line, backgroundColor: on ? colors.surfaceHi : 'transparent' }]}>
      <Text style={{ color: on ? colors.text : colors.muted, fontSize: 12 }}>{label}</Text>
    </View>
  );

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={[styles.scrim, { backgroundColor: colors.scrim }]} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        {/* The head: cover, title, site, kind. */}
        <View style={styles.head}>
          <View style={[styles.thumb, { backgroundColor: colors.surfaceHi }]}>
            <Cover entry={entry} settings={settings} style={styles.cover} textStyle={[styles.fallback, { color: colors.muted }]} />
          </View>
          <View style={styles.headText}>
            <Text style={[styles.title, { color: colors.text }]} numberOfLines={3}>{entry.title}</Text>
            <Text style={[styles.sub, { color: colors.muted }]} numberOfLines={1}>{entry.sourceDomain || entry.sourceUrl}</Text>
            <View style={styles.pills}>
              {medium && pill(medium, false)}
              {entry.language && pill(String(entry.language).toUpperCase(), false)}
              {entry.seriesStatus && pill(t(entry.seriesStatus === 'completed' ? 'webFinished' : 'webOngoing'), false)}
            </View>
          </View>
        </View>

        <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
          <>
              {/* Where you are, and what is out. */}
              <Text style={[styles.label, { color: colors.muted }]}>{t('fieldProgress')}</Text>
              <Text style={{ color: colors.text }}>
                {bookmark?.chapterLabel || t('webNotStarted')}
                {bookmark?.pageCount > 1 ? `  ·  ${(bookmark.page ?? 0) + 1}/${bookmark.pageCount}` : ''}
              </Text>
              {entry.lastKnownChapter && (
                <Text style={{ color: behind > 0 ? colors.unread : colors.muted, marginTop: 2 }}>
                  {t('webLatestChapter', [String(entry.lastKnownChapter)])}{behind > 0 ? `  ·  ${t('badgeNNew', [String(behind)])}` : ''}
                </Text>
              )}

              {target?.url && (
                <Button
                  colors={colors}
                  label={bookmark?.chapterLabel ? t('actionContinueChapter', [bookmark.chapterLabel]) : t('actionRead')}
                  onPress={() => { onClose(); onOpen(target.url, entry); }}
                />
              )}
              {entry.sourceUrl && (
                <Button colors={colors} kind="ghost" label={t('actionOpenSeriesPage')} onPress={() => { onClose(); onOpen(entry.sourceUrl, entry); }} />
              )}

              <Text style={[styles.label, { color: colors.muted }]}>{t('fieldFolder')}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
                {Folders.folderTabs(categories).map((f) => {
                  const on = String(entry.folder || Folders.DEFAULT_FOLDER) === f.id;
                  return (
                    <Pressable
                      key={f.id}
                      onPress={() => file(f.id)}
                      style={[styles.chip, { borderColor: on ? colors.accent : colors.line, backgroundColor: on ? colors.surfaceHi : 'transparent' }]}
                    >
                      <View style={[styles.dot, { backgroundColor: statusColor(f.status || f.id, colors) }]} />
                      <Text style={{ color: on ? colors.text : colors.muted }}>{f.custom ? f.label : t(`folder_${f.id}`)}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {/* Your score: ten stars, the lit one is yours, tapping it again clears it. */}
              <Text style={[styles.label, { color: colors.muted }]}>{t('fieldScore')}</Text>
              <View style={styles.stars}>
                {SCORES.map((n) => (
                  <Pressable key={n} onPress={() => patch({ score: entry.score === n ? null : n })} hitSlop={4}>
                    <Text style={{ fontSize: 22, color: entry.score != null && n <= entry.score ? colors.accent : colors.line }}>★</Text>
                  </Pressable>
                ))}
                <Text style={{ color: colors.muted, marginLeft: 6 }}>{entry.score != null ? `${entry.score}/10` : ''}</Text>
              </View>

              {entry.tags?.length > 0 && (
                <>
                  <Text style={[styles.label, { color: colors.muted }]}>{t('fieldTags')}</Text>
                  <View style={styles.pills}>{entry.tags.map((g) => pill(g, false))}</View>
                </>
              )}

              <Field
                colors={colors}
                label={t('fieldNote')}
                value={note}
                onChangeText={setNote}
                onEndEditing={() => { if (note !== (entry.note || '')) patch({ note: note || null }); }}
                multiline
              />

              {/* What the trackers say. Three sentences, never one: nothing
                  connected, connected but not there, and there with a count. */}
              <Text style={[styles.label, { color: colors.muted }]}>{t('navTrackers')}</Text>
              {trackers.loading ? (
                <Text style={{ color: colors.muted }}>{t('trackerAsking')}</Text>
              ) : trackers.connected.length === 0 ? (
                <Text style={{ color: colors.muted }}>{t('trackerNotConnected')}</Text>
              ) : (
                trackers.connected.map((service) => {
                  const found = trackers.entries.find((e) => e.service === service);
                  const failed = trackers.errors.find((e) => e.service === service);
                  return (
                    <View key={service} style={styles.trackerRow}>
                      <Text style={{ color: colors.text, fontWeight: '600', textTransform: 'capitalize' }}>{service}</Text>
                      <Text style={{ color: colors.muted, flex: 1 }} numberOfLines={2}>
                        {failed ? t('trackerUnreachable')
                          : !found ? t('mobileTrackerNotThere')
                            : [
                              found.remoteTitle,
                              found.chaptersRead != null ? t('mobileTrackerChapters', [String(found.chaptersRead)]) : null,
                              found.score != null ? `★ ${found.score}` : null,
                              found.folder ? t(`folder_${found.folder}`) : null,
                            ].filter(Boolean).join(' · ')}
                      </Text>
                    </View>
                  );
                })
              )}

              <Button
                colors={colors}
                kind="danger"
                label={t('actionRemoveFromLibrary')}
                onPress={async () => {
                  await send({ type: 'removeFromLibrary', id: entry.id });
                  await store.refresh();
                  toast(t('statusRemoved'));
                  onClose();
                }}
              />
          </>
        </ScrollView>

        <Button colors={colors} kind="ghost" label={t('actionCancel')} onPress={onClose} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1 },
  sheet: {
    borderTopLeftRadius: 16, borderTopRightRadius: 16, borderTopWidth: 1,
    padding: 16, paddingBottom: 28, maxHeight: '88%',
  },
  head: { flexDirection: 'row', gap: 12 },
  thumb: { width: 72, height: 104, borderRadius: 8, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  cover: { width: 72, height: 104 },
  fallback: { fontSize: 10, textAlign: 'center', padding: 4 },
  headText: { flex: 1 },
  title: { fontSize: 17, fontWeight: '600' },
  sub: { fontSize: 12, marginTop: 2 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1 },
  body: { flexGrow: 0, marginTop: 8 },
  label: { fontSize: 12, marginTop: 14, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6 },
  row: { gap: 8, paddingBottom: 6 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  stars: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  trackerRow: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 6 },
});

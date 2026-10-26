// What you were in the middle of, one row per kind of thing.
//
// The shelf answers "what do I have"; this answers "what was I doing". They are
// different questions and they sort differently — a library is arranged by what
// it holds, a history by when you last touched it — which is why this is not a
// filter on the other screen.
//
// One row per medium, and a row only exists once there is something in it: a
// reader who has never opened a light novel should not be told, every day, that
// they have no light novels. The rows are the closed list in
// `shared/panelflow-core.js`, so "recently read" and "recently watched" are the
// same code with a different word above them.
import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Text from '../components/Text.js';
import { Shelf } from '../shared.js';
import Cover from '../components/Cover.js';
import { t } from '../i18n.js';
import { newChapters } from '../format.js';
import { EmptyState, ScreenTitle } from '../ui.js';
import { firstWebUrl } from '../web-url.js';

/**
 * The rows, in the order somebody would look for them, each with the word for
 * what one does with that medium. Reading a manga and watching an anime are not
 * the same verb, and a single heading for both would be wrong twice.
 */
const ROWS = [
  { medium: 'manga', label: 'mobileMediumManga' },
  { medium: 'webtoon', label: 'popupGroupWebtoons' },
  // Web novels and light novels in one row: two types, one kind of reading.
  { medium: 'novel', media: ['webnovel', 'lightnovel'], label: 'popupGroupNovels' },
  { medium: 'anime', label: 'mobileMediumAnime' },
];

const HOW_MANY = 15;

export default function RecentScreen({ store, colors, onOpen, onEntry, onTab }) {
  const { library, progress, targets, settings, categories } = store;

  /**
   * What is out that you have not read — the website's "Updates" tab, as the
   * first row of this screen. The phone had the count as a badge on each
   * cover and nowhere as a list, so "what came out this week" was a scroll
   * across the whole shelf looking for numbers. Ordered by how far behind,
   * furthest first: the series with five new chapters is the one waiting.
   * The arithmetic is shared/library-view.js's, the same the badge uses.
   */
  const behind = useMemo(() => {
    const map = new Map();
    for (const e of library) {
      try {
        const n = Math.round(Shelf.newChapters(e, progress[e.sourceUrl], categories || []));
        if (n > 0) map.set(e, n);
      } catch { /* an entry the matcher cannot read costs its badge, not the row */ }
    }
    return map;
  }, [library, progress, categories]);
  const fresh = useMemo(
    () => [...behind.entries()].sort((a, b) => b[1] - a[1]).slice(0, HOW_MANY).map(([e]) => e),
    [behind],
  );

  /**
   * Everything you have touched, newest first, split by medium.
   *
   * "Touched" is deliberately wider than "has a bookmark". Only the reader
   * writes progress, so a site it never managed to open — most light novel
   * sites, and any chapter behind a layout it cannot read — left an entry with
   * no bookmark at all, and this screen dropped it. The reader who had just
   * added a light novel was told they had never opened one: the row itself was
   * missing, because the row only exists when something is in it.
   *
   * So a bookmark if there is one, and otherwise the day it entered the library
   * — which is a real answer to "when did I last do something with this".
   *
   * `dateAdded` and not the entry's `updatedAt`: an entry is patched when its
   * cover arrives or its shelf changes, and neither of those is "I read this".
   * Ordering by it would reshuffle the history every time a picture loaded.
   */
  const rows = useMemo(() => {
    const stamp = (e) => String(progress[e.sourceUrl]?.updatedAt || e.dateAdded || '');
    const read = library
      .filter((e) => stamp(e))
      .sort((a, b) => stamp(b).localeCompare(stamp(a)));
    return ROWS
      .map((row) => ({
        ...row,
        entries: read.filter((e) => (row.media || [row.medium]).includes(Shelf.mediumOf(e))).slice(0, HOW_MANY),
      }))
      .filter((row) => row.entries.length > 0);
  }, [library, progress]);

  /**
   * The one series read last, first and large: the redesign's "Reprendre"
   * card (owner, October 2026). The series with the newest bookmark, and its
   * button goes where the cover would, the core's continue target.
   */
  const last = useMemo(() => {
    let best = null;
    for (const e of library) {
      const at = String(progress[e.sourceUrl]?.updatedAt || '');
      if (at && Shelf.bookmarkOf(progress[e.sourceUrl]) && (!best || at > best.at)) best = { entry: e, at };
    }
    return best?.entry || null;
  }, [library, progress]);

  // The shelf's order of addresses (LibraryScreen.js), each one skipped when it
  // is not http(s), and the series' sheet when none is left.
  const open = (entry) => {
    const url = firstWebUrl(targets[entry.id]?.url,
      progress[entry.sourceUrl]?.chapterUrl,
      entry.sourceUrl);
    if (url) onOpen(url, entry);
    else onEntry(entry);
  };

  if (rows.length === 0 && fresh.length === 0) {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <ScreenTitle colors={colors} title={t('navHistory')} inset={4} />
        <EmptyState
          colors={colors}
          icon="history"
          title={t('mobileHistoryEmptyTitle')}
          body={t('mobileHistoryEmptyBody')}
          actions={[{ label: t('mobileWelcomeSearch'), onPress: () => onTab?.('search') }]}
        />
      </ScrollView>
    );
  }

  // One row shape for both kinds: the update row and the per-medium rows are
  // the same cards, the update row simply comes first and says so.
  const allRows = [
    ...(fresh.length ? [{ medium: 'fresh', label: 'webNewChapters', entries: fresh }] : []),
    ...rows,
  ];

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <ScreenTitle colors={colors} title={t('navHistory')} inset={4} />
      {last && (() => {
        const mark = Shelf.bookmarkOf(progress[last.sourceUrl]);
        const share = mark?.pageCount > 1 ? Math.min(1, ((mark.page ?? 0) + 1) / mark.pageCount) : null;
        const where = targets[last.id]?.label || mark?.chapterLabel || '';
        return (
          <View style={[styles.resume, { backgroundColor: colors.surface }]}>
            <View style={[styles.resumeThumb, { backgroundColor: colors.surfaceHi }]}>
              <Cover entry={last} settings={settings} style={styles.cover} colors={colors} letterSize={34} />
            </View>
            <View style={styles.resumeText}>
              <Text style={[styles.kicker, { color: colors.accent }]}>{t('libraryContinueReading')}</Text>
              <Text numberOfLines={2} style={[styles.resumeTitle, { color: colors.text }]}>{last.title}</Text>
              {!!mark?.chapterLabel && (
                <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 13 }}>{mark.chapterLabel}</Text>
              )}
              {share !== null && (
                <View style={[styles.bar, { backgroundColor: colors.line }]}>
                  <View style={[styles.bar, { width: `${Math.round(share * 100)}%`, backgroundColor: colors.accent }]} />
                </View>
              )}
              <Pressable
                onPress={() => open(last)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.resumeButton, { backgroundColor: colors.accent }, pressed && { opacity: 0.75 }]}
              >
                <Text numberOfLines={1} style={[styles.resumeButtonText, { color: colors.onAccent }]}>
                  {where ? t('actionContinueChapter', [where]) : t('libraryContinueReading')}
                </Text>
              </Pressable>
            </View>
          </View>
        );
      })()}
      {allRows.map((row) => (
        <View key={row.medium}>
          <Text accessibilityRole="header" style={[styles.head, { color: colors.text }]}>{t(row.label)}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rowInset}>
            {row.entries.map((entry) => {
              return (
                <Pressable
                  key={entry.id || entry.sourceUrl}
                  onPress={() => open(entry)}
                  onLongPress={() => onEntry(entry)}
                  style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
                  accessibilityRole="button"
                  accessibilityLabel={[
                    entry.title,
                    row.medium === 'fresh'
                      ? newChapters(behind.get(entry), entry)
                      : Shelf.bookmarkOf(progress[entry.sourceUrl])?.chapterLabel,
                  ].filter(Boolean).join(', ')}
                  accessibilityHint={t('mobileCardHint')}
                  accessibilityActions={[{ name: 'activate' }, { name: 'details', label: t('mobileCardDetails') }]}
                  onAccessibilityAction={({ nativeEvent }) => {
                    if (nativeEvent.actionName === 'details') onEntry(entry);
                    else open(entry);
                  }}
                >
                  <View style={[styles.thumb, { backgroundColor: colors.surfaceHi }]}>
                    <Cover
                      entry={entry}
                      settings={settings}
                      style={styles.cover}
                      colors={colors}
                      letterSize={38}
                    />
                  </View>
                  <Text numberOfLines={2} style={[styles.title, { color: colors.text }]}>
                    {entry.title}
                  </Text>
                  <Text numberOfLines={1} style={[styles.sub, { color: row.medium === 'fresh' ? colors.unread : colors.muted }]}>
                    {row.medium === 'fresh'
                      ? t('badgeNNew', [String(behind.get(entry))])
                      : (Shelf.bookmarkOf(progress[entry.sourceUrl])?.chapterLabel || '')}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 12, paddingBottom: 32 },
  head: { fontSize: 16, fontWeight: '700', marginTop: 16, marginBottom: 8, paddingHorizontal: 4 },
  resume: { flexDirection: 'row', gap: 12, padding: 12, borderRadius: 14, marginTop: 4, marginHorizontal: 4 },
  resumeThumb: { width: 84, aspectRatio: 2 / 3, borderRadius: 8, overflow: 'hidden', justifyContent: 'center' },
  resumeText: { flex: 1, minWidth: 0, gap: 6 },
  kicker: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  resumeTitle: { fontSize: 16, fontWeight: '800', lineHeight: 20 },
  bar: { height: 4, borderRadius: 2 },
  resumeButton: { alignSelf: 'flex-start', minHeight: 40, borderRadius: 20, paddingHorizontal: 16, justifyContent: 'center', marginTop: 2 },
  resumeButtonText: { fontSize: 14, fontWeight: '800' },
  rowInset: { paddingHorizontal: 4 },
  card: { width: 108, marginRight: 10 },
  thumb: { width: '100%', aspectRatio: 2 / 3, borderRadius: 8, overflow: 'hidden', justifyContent: 'center' },
  cover: { width: '100%', height: '100%' },
  fallback: { fontSize: 11, textAlign: 'center', paddingHorizontal: 4 },
  title: { fontSize: 12, fontWeight: '600', marginTop: 5, lineHeight: 15 },
  sub: { fontSize: 11, marginTop: 1 },
});

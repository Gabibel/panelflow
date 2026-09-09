// The shelf — the screen you land on when you tap the icon.
//
// It draws three things, in the order they answer the question you opened the
// app with: what can I carry on with (continue), how is it filed (the chip
// rows), what have I got (the grid). None of the arithmetic is here: how far
// behind a series is comes from shared/library-view.js and which shelf it sits
// on from shared/folders.js, so a badge means the same thing on this phone and
// in the browser.
//
// A plain ScrollView with a wrapping row of tiles, and deliberately not a
// FlatList: the shelf held six series and drew none of them, while the
// horizontal "continue" row above it — a ScrollView — drew the same entries
// fine. A library is tens of covers, not thousands, so virtualisation buys
// nothing here and cost the whole screen. Fewer moving parts is also the
// difference between a bug somebody can find and one they cannot.
import { useMemo, useState } from 'react';
import {
  Image, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { Folders, Shelf } from '../shared.js';
import { coverSrc } from '../store.js';
import { statusColor, UNREAD } from '../theme.js';
import { t } from '../i18n.js';
import { Empty } from '../ui.js';

const COLUMNS = 3;

/**
 * The four kinds of work, and what each chip says.
 *
 * `shared/panelflow-core.js` owns the list and `addToLibrary` is what files an
 * entry into one. Before this row existed the phone drew them as one grid, so a
 * library of manga, light novels and anime looked like a library of manga.
 */
const MEDIA = [
  ['manga', 'mobileMediumManga'],
  ['webtoon', 'popupGroupWebtoons'],
  ['novel', 'popupGroupNovels'],
  ['anime', 'mobileMediumAnime'],
];

export default function LibraryScreen({ store, colors, onOpen, onEntry }) {
  const [folder, setFolder] = useState('all');
  const [medium, setMedium] = useState('all');
  const [refreshing, setRefreshing] = useState(false);
  // How the shelf is ordered, and which genre it is narrowed to. Both live
  // behind one button rather than in a fourth row of chips: they are answers
  // you change occasionally, and the rows above are ones you change constantly.
  const [sortBy, setSortBy] = useState(Shelf.DEFAULT_SORT);
  const [tag, setTag] = useState(null);
  const [sheet, setSheet] = useState(false);

  const { library, progress, targets, categories, settings } = store;

  // A shelf of the reader's own is called what they called it; a built-in one is
  // called what this language calls it. `folderTabs` hands back the English
  // label for both, which is right for exactly one of them.
  const tabs = useMemo(() => [{ id: 'all' }, ...Folders.folderTabs(categories)], [categories]);
  const tabLabel = (f) => (f.id === 'all'
    ? t('folder_all')
    : (f.custom ? f.label : t(`folder_${f.id}`)));

  // Where an entry actually sits: a shelf deleted on another device leaves
  // entries pointing at a folder that no longer exists, and they belong back in
  // the default rather than nowhere.
  const folderOf = (entry) => {
    const value = String(entry.folder || Folders.DEFAULT_FOLDER);
    if (Folders.BUILTIN_IDS.includes(value)) return value;
    return categories.some((c) => Folders.folderFor(c) === value) ? value : Folders.DEFAULT_FOLDER;
  };

  const mediumOf = (entry) => String(entry.medium || 'manga');

  // The row only appears once there is more than one kind on the shelf: a
  // filter that can only say "all" is furniture.
  const media = useMemo(
    () => MEDIA.filter(([id]) => library.some((e) => mediumOf(e) === id)),
    [library],
  );

  // Rounded, because half a chapter behind is a real measurement and "2.5 new"
  // is not a badge. Guarded, because this draws one badge on one cover: an
  // entry the matcher cannot read a chapter number out of must cost that badge
  // and not the shelf.
  const unread = (entry) => {
    try {
      return Math.round(Shelf.newChapters(entry, progress[entry.sourceUrl], categories));
    } catch (e) {
      console.warn('[panelflow] could not count new chapters', entry?.title, e);
      return 0;
    }
  };

  // Every genre in the library with how many series carry it, commonest first —
  // the same count the popup's filter uses, so a tag typed once is a tag every
  // surface offers.
  const tags = useMemo(() => Shelf.tagCounts(library).slice(0, 12), [library]);

  // Filtered and ordered by shared/library-view.js — the same two functions the
  // popup and the web shelf use, rather than a phone-shaped copy of them.
  const shown = useMemo(() => Shelf.sortLibrary(
    Shelf.filterLibrary(library, {
      folder, folderOf, tags: tag ? [tag] : [], categories, progressOf: (e) => progress[e.sourceUrl],
    }).filter((e) => medium === 'all' || mediumOf(e) === medium),
    { by: sortBy, progressOf: (e) => progress[e.sourceUrl] },
  ), [library, folder, medium, sortBy, tag, progress, categories]);

  // "Continue reading" is the reason to open the app at all, so it is only what
  // can actually be resumed: a bookmark pointing at a real chapter.
  const carryOn = useMemo(() => library
    .filter((e) => progress[e.sourceUrl]?.chapterUrl)
    .sort((a, b) => String(progress[b.sourceUrl].updatedAt || '')
      .localeCompare(String(progress[a.sourceUrl].updatedAt || '')))
    .slice(0, 12),
  [library, progress]);

  const refresh = async () => {
    setRefreshing(true);
    await store.refresh();
    setRefreshing(false);
  };

  // Where a tap leads, in the order of how much is known: the chapter the core
  // worked out to continue with, the bookmark itself, then the series page.
  // Never nowhere — a tap that opens nothing reads as a tap that did not land.
  const openEntry = (entry) => {
    const url = targets[entry.id]?.url
      || progress[entry.sourceUrl]?.chapterUrl
      || entry.sourceUrl;
    if (url) onOpen(url, entry);
    else onEntry(entry);
  };

  /** One row of chips. Both filter rows are the same control twice. */
  const chips = (options, value, onChange) => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
      {options.map(({ id, label, dot }) => {
        const on = value === id;
        return (
          <Pressable
            key={id}
            onPress={() => onChange(id)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            style={[styles.chip, {
              backgroundColor: on ? colors.surfaceHi : 'transparent',
              borderColor: on ? colors.line : 'transparent',
            }]}
          >
            {dot && <View style={[styles.dot, { backgroundColor: dot }]} />}
            <Text style={{ color: on ? colors.text : colors.muted, fontSize: 14 }}>{label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );

  const tile = (entry) => {
    const src = coverSrc(entry, settings);
    const n = unread(entry);
    const p = progress[entry.sourceUrl];
    return (
      <Pressable
        key={entry.id || entry.sourceUrl}
        style={styles.tile}
        onPress={() => openEntry(entry)}
        onLongPress={() => onEntry(entry)}
      >
        <View style={[styles.thumb, { backgroundColor: colors.surfaceHi }]}>
          {src
            ? <Image source={{ uri: src }} style={styles.cover} resizeMode="cover" />
            : (
              <Text numberOfLines={4} style={[styles.fallback, { color: colors.muted }]}>
                {entry.title}
              </Text>
            )}
          {/* The shelf, as a colour rather than a word: at grid density a label
              does not fit, and the folder is the only thing that has to be
              readable at a glance. */}
          <View style={[styles.stripe, {
            backgroundColor: statusColor(Folders.folderStatus(folderOf(entry), categories), colors),
          }]}
          />
          {n > 0 && (
            <View style={[styles.badge, { backgroundColor: UNREAD }]}>
              <Text style={styles.badgeText}>{t('badgeNNew', [String(n)])}</Text>
            </View>
          )}
        </View>
        <Text numberOfLines={2} style={[styles.title, { color: colors.text }]}>{entry.title}</Text>
        <Text numberOfLines={1} style={[styles.sub, { color: colors.muted }]}>
          {p?.chapterLabel || entry.sourceDomain || ''}
        </Text>
      </Pressable>
    );
  };

  return (
    <ScrollView
      contentContainerStyle={styles.page}
      refreshControl={(
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />
      )}
    >
      {carryOn.length > 0 && (
        <View>
          <Text style={[styles.sectionHead, { color: colors.text }]}>
            {t('libraryContinueReading')}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {carryOn.map((entry) => {
              const p = progress[entry.sourceUrl];
              const src = coverSrc(entry, settings);
              return (
                <Pressable
                  key={entry.id || entry.sourceUrl}
                  style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}
                  onPress={() => openEntry(entry)}
                >
                  {src && <Image source={{ uri: src }} style={styles.cardCover} resizeMode="cover" />}
                  <View style={styles.cardText}>
                    <Text numberOfLines={2} style={[styles.cardTitle, { color: colors.text }]}>
                      {entry.title}
                    </Text>
                    <Text numberOfLines={1} style={[styles.sub, { color: colors.muted }]}>
                      {p?.chapterLabel || ''}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}

      {media.length > 1 && chips(
        [{ id: 'all', label: t('folder_all') }, ...media.map(([id, key]) => ({ id, label: t(key) }))],
        medium,
        setMedium,
      )}

      {chips(
        tabs.map((f) => ({
          id: f.id,
          label: tabLabel(f),
          dot: f.id === 'all' ? null : statusColor(f.status || f.id, colors),
        })),
        folder,
        setFolder,
      )}

      <View style={styles.sortRow}>
        <Pressable
          onPress={() => setSheet(true)}
          style={[styles.sortButton, { borderColor: colors.line }]}
        >
          <Text style={{ color: colors.text, fontSize: 13 }}>
            {`${t('popupSortOrder')} · ${t(`sort_${sortBy}`)}${tag ? ` · ${tag}` : ''}`}
          </Text>
        </Pressable>
      </View>

      <View style={styles.grid}>{shown.map(tile)}</View>

      <Modal visible={sheet} transparent animationType="slide" onRequestClose={() => setSheet(false)}>
        <Pressable style={[styles.scrim, { backgroundColor: colors.scrim }]} onPress={() => setSheet(false)} />
        <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Text style={[styles.sheetHead, { color: colors.muted }]}>{t('popupSortOrder')}</Text>
          <View style={styles.wrap}>
            {Shelf.SORT_IDS.map((id) => {
              const on = sortBy === id;
              return (
                <Pressable
                  key={id}
                  onPress={() => setSortBy(id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  style={[styles.chip, {
                    borderColor: on ? colors.accent : colors.line,
                    backgroundColor: on ? colors.surfaceHi : 'transparent',
                  }]}
                >
                  <Text style={{ color: on ? colors.text : colors.muted, fontSize: 14 }}>
                    {t(`sort_${id}`)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Only when the library has genres on it. A filter with nothing to
              filter by is a heading over an empty row. */}
          {tags.length > 0 && (
            <>
              <Text style={[styles.sheetHead, { color: colors.muted }]}>{t('fieldTags')}</Text>
              <View style={styles.wrap}>
                {tags.map(({ tag: name, count }) => {
                  const on = tag === name;
                  return (
                    <Pressable
                      key={name}
                      onPress={() => setTag(on ? null : name)}
                      style={[styles.chip, {
                        borderColor: on ? colors.accent : colors.line,
                        backgroundColor: on ? colors.surfaceHi : 'transparent',
                      }]}
                    >
                      <Text style={{ color: on ? colors.text : colors.muted, fontSize: 14 }}>
                        {`${name} · ${count}`}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          )}

          <Pressable onPress={() => setSheet(false)} style={[styles.done, { borderColor: colors.line }]}>
            <Text style={{ color: colors.text }}>{t('actionDone')}</Text>
          </Pressable>
        </View>
      </Modal>

      {shown.length === 0 && (
        <Empty colors={colors}>
          {/* An empty shelf inside a full library is not the same message as an
              empty library, and saying the second on the first is how a filter
              looks like a fault. */}
          {library.length > 0
            ? t('mobileNothingFiled', [tabLabel(tabs.find((f) => f.id === folder) || { id: folder })])
            : t('mobileLibraryEmpty')}
        </Empty>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 8, paddingBottom: 32 },
  sectionHead: { fontSize: 15, fontWeight: '600', marginLeft: 4, marginTop: 8, marginBottom: 8 },
  card: { flexDirection: 'row', width: 210, borderRadius: 10, borderWidth: 1, marginRight: 8, overflow: 'hidden' },
  cardCover: { width: 48, height: 68 },
  cardText: { flex: 1, padding: 8, justifyContent: 'center' },
  cardTitle: { fontSize: 13, fontWeight: '600' },
  chipRow: { paddingVertical: 8, paddingHorizontal: 4, gap: 6 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  sortRow: { paddingHorizontal: 4, paddingBottom: 6 },
  sortButton: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  scrim: { flex: 1 },
  sheet: {
    borderTopLeftRadius: 16, borderTopRightRadius: 16, borderTopWidth: 1,
    padding: 16, paddingBottom: 28,
  },
  sheetHead: { fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 10, marginBottom: 8 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  done: {
    alignSelf: 'center', borderWidth: 1, borderRadius: 999,
    paddingHorizontal: 22, paddingVertical: 10, marginTop: 18,
  },
  // A width and not a flex: three tiles per row, whatever the row holds. `flex`
  // shares free space, which is a different promise and the one that left a
  // full shelf looking empty.
  tile: { width: `${100 / COLUMNS}%`, padding: 4 },
  // 2:3 is the shape a scan site's cover actually is; anything else crops faces.
  thumb: { width: '100%', aspectRatio: 2 / 3, borderRadius: 8, overflow: 'hidden', justifyContent: 'center' },
  cover: { width: '100%', height: '100%' },
  fallback: { fontSize: 12, textAlign: 'center', paddingHorizontal: 6 },
  stripe: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3 },
  badge: { position: 'absolute', top: 5, right: 5, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontWeight: '700', color: '#1a1714' },
  title: { fontSize: 12, marginTop: 5, lineHeight: 15 },
  sub: { fontSize: 11, marginTop: 1 },
});

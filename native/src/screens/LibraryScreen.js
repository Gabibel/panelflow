// The shelf — the screen you land on when you tap the icon.
//
// It draws the same three things the phone's web shell drew and in the same
// order, because they answer the same question in the same priority: what can I
// carry on with (continue), what am I filing it under (folders), what have I got
// (the grid). None of the arithmetic is here: how far behind a series is comes
// from shared/library-view.js and which shelf it sits on from shared/folders.js,
// so a badge means the same thing on this phone and in the browser.
import { useMemo, useState } from 'react';
import {
  FlatList, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { Folders, Shelf } from '../shared.js';
import { coverSrc } from '../store.js';
import { statusColor, UNREAD } from '../theme.js';
import { t } from '../i18n.js';
import { Empty } from '../ui.js';

const COLUMNS = 3;

export default function LibraryScreen({ store, colors, onOpen, onEntry }) {
  const [folder, setFolder] = useState('all');
  const [refreshing, setRefreshing] = useState(false);

  const { library, progress, targets, categories, settings } = store;

  // A shelf of the user's own is called what they called it; a built-in one is
  // called what this language calls it. `folderTabs` hands back the English
  // label for both, which is right for exactly one of them.
  const tabs = useMemo(
    () => [{ id: 'all' }, ...Folders.folderTabs(categories)],
    [categories],
  );
  const tabLabel = (f) => (f.id === 'all' ? t('folder_all') : (f.custom ? f.label : t(`folder_${f.id}`)));

  // Where an entry actually sits: a shelf deleted on another device leaves
  // entries pointing at a folder that no longer exists, and they belong back in
  // the default rather than nowhere.
  const folderOf = (entry) => {
    const value = String(entry.folder || Folders.DEFAULT_FOLDER);
    if (Folders.BUILTIN_IDS.includes(value)) return value;
    return categories.some((c) => Folders.folderFor(c) === value) ? value : Folders.DEFAULT_FOLDER;
  };

  // Rounded, because half a chapter behind is a real measurement and "2.5 new"
  // is not a badge. Guarded, because this draws a badge: an entry the matcher
  // cannot read a chapter number out of must cost that one badge and not the
  // whole shelf.
  const unread = (entry) => {
    try {
      return Math.round(Shelf.newChapters(entry, progress[entry.sourceUrl], categories));
    } catch (e) {
      console.warn('[panelflow] could not count new chapters', entry?.title, e);
      return 0;
    }
  };

  // Filtered and ordered by shared/library-view.js — the same two functions the
  // popup and the web shelf use. Not a phone-shaped copy of them: this screen
  // used to carry its own filter and its own comparator, which is how it came
  // to disagree with the other surfaces about which series it was even showing.
  const shown = useMemo(() => Shelf.sortLibrary(
    Shelf.filterLibrary(library, { folder, folderOf }),
    { by: 'updated', progressOf: (e) => progress[e.sourceUrl] },
  ), [library, folder, progress, categories]);

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
  // Never nowhere — an entry whose target the core could not compute used to
  // open the sheet instead, which reads as a tap that did nothing.
  const openEntry = (entry) => {
    const url = targets[entry.id]?.url
      || progress[entry.sourceUrl]?.chapterUrl
      || entry.sourceUrl;
    if (url) onOpen(url, entry);
    else onEntry(entry);
  };

  const renderTile = ({ item: entry }) => {
    const src = coverSrc(entry, settings);
    const n = unread(entry);
    const p = progress[entry.sourceUrl];
    return (
      <Pressable
        style={styles.tile}
        onPress={() => openEntry(entry)}
        onLongPress={() => onEntry(entry)}
      >
        <View style={[styles.thumb, { backgroundColor: colors.surfaceHi }]}>
          {src
            ? <Image source={{ uri: src }} style={styles.cover} resizeMode="cover" />
            : <Text numberOfLines={4} style={[styles.fallback, { color: colors.muted }]}>{entry.title}</Text>}
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

  const header = (
    <View>
      {carryOn.length > 0 && (
        <View style={styles.continue}>
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

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.folders}
      >
        {tabs.map((f) => {
          const on = folder === f.id;
          return (
            <Pressable
              key={f.id}
              onPress={() => setFolder(f.id)}
              style={[styles.folderTab, {
                backgroundColor: on ? colors.surfaceHi : 'transparent',
                borderColor: on ? colors.line : 'transparent',
              }]}
            >
              {f.id !== 'all' && (
                <View style={[styles.dot, {
                  backgroundColor: statusColor(f.status || f.id, colors),
                }]}
                />
              )}
              <Text style={{ color: on ? colors.text : colors.muted, fontSize: 14 }}>
                {tabLabel(f)}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );

  return (
    <FlatList
      data={shown}
      key={COLUMNS}
      numColumns={COLUMNS}
      // `sourceUrl` as the fallback, because it is the field the whole core
      // treats as the identity of a series — an entry with no `id` (one just
      // pulled, one written by an older client) would otherwise share the key
      // "undefined" with every other such entry, and React draws one row for a
      // repeated key. That is a shelf silently missing everything but its first
      // unsaved series.
      keyExtractor={(e, i) => String(e.id || e.sourceUrl || i)}
      renderItem={renderTile}
      ListHeaderComponent={header}
      contentContainerStyle={styles.list}
      refreshControl={(
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />
      )}
      ListEmptyComponent={(
        <Empty colors={colors}>
          {/* An empty shelf inside a full library is not the same message as an
              empty library, and saying the second on the first is how a filter
              looks like a bug. */}
          {library.length > 0
            ? t('mobileNothingFiled', [tabLabel(tabs.find((f) => f.id === folder) || { id: folder })])
            : t('mobileLibraryEmpty')}
        </Empty>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 8, paddingBottom: 24 },
  continue: { marginBottom: 8 },
  sectionHead: { fontSize: 15, fontWeight: '600', marginLeft: 4, marginTop: 8, marginBottom: 8 },
  card: { flexDirection: 'row', width: 210, borderRadius: 10, borderWidth: 1, marginRight: 8, overflow: 'hidden' },
  cardCover: { width: 48, height: 68 },
  cardText: { flex: 1, padding: 8, justifyContent: 'center' },
  cardTitle: { fontSize: 13, fontWeight: '600' },
  folders: { paddingVertical: 10, paddingHorizontal: 4, gap: 6 },
  folderTab: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  tile: { flex: 1 / COLUMNS, padding: 4, maxWidth: `${100 / COLUMNS}%` },
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

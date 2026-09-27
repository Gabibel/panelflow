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
  Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { Folders, Shelf } from '../shared.js';
import Cover from '../components/Cover.js';
import Icon from '../components/Icon.js';
import Sheet from '../components/Sheet.js';
import { statusColor } from '../theme.js';
import { t } from '../i18n.js';
import { newChapters } from '../format.js';
import { Empty, EmptyState, ScreenTitle } from '../ui.js';

const COLUMNS = 3;

/**
 * The kinds of work come from shared/library-view.js (MEDIA): manga, webtoon,
 * web novel, light novel, anime — the same five the web app's type row and the
 * popup's type filter offer. Before this row existed the phone drew them as one
 * grid, so a library of manga, light novels and anime looked like a library of
 * manga.
 */

export default function LibraryScreen({ store, colors, onOpen, onEntry, onTab }) {
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

  // Every kind, whether or not the shelf has one yet, each with its count: a
  // row whose chips come and go as series are added moves under the thumb.
  const media = useMemo(() => {
    const counts = {};
    for (const e of library) counts[Shelf.mediumOf(e)] = (counts[Shelf.mediumOf(e)] || 0) + 1;
    return Shelf.MEDIA.map((m) => ({ id: m.id, count: counts[m.id] || 0 }));
  }, [library]);

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
      folder, folderOf, tags: tag ? [tag] : [], categories, progressOf: (e) => progress[e.sourceUrl], medium,
    }),
    { by: sortBy, progressOf: (e) => progress[e.sourceUrl] },
  ), [library, folder, medium, sortBy, tag, progress, categories]);

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
            // 32 points drawn, 44 to the finger (QA re-test It.5, N-A18).
            hitSlop={SLOP}
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

  // What VoiceOver says for a card: everything the eye gets from it — the
  // title, where the bookmark is, what is new, which shelf the stripe means —
  // and what a tap does. The sheet is a named action, not a gesture to guess.
  const spoken = (entry, n, mark, shelf) => [
    entry.title,
    mark?.chapterLabel,
    n > 0 ? newChapters(n, entry) : null,
    shelf,
    entry.score != null ? t('mobileScoreValue', [String(entry.score)]) : null,
  ].filter(Boolean).join(', ');

  const tile = (entry) => {
    const n = unread(entry);
    const p = progress[entry.sourceUrl];
    const mark = Shelf.bookmarkOf(p);
    const status = Folders.folderStatus(folderOf(entry), categories);
    const shelf = tabLabel(tabs.find((f) => f.id === folderOf(entry)) || { id: folderOf(entry) });
    return (
      <Pressable
        key={entry.id || entry.sourceUrl}
        style={({ pressed }) => [styles.tile, pressed && { opacity: 0.7 }]}
        onPress={() => openEntry(entry)}
        onLongPress={() => onEntry(entry)}
        accessibilityRole="button"
        accessibilityLabel={spoken(entry, n, mark, shelf)}
        accessibilityHint={t('mobileCardHint')}
        accessibilityActions={[{ name: 'activate' }, { name: 'details', label: t('mobileCardDetails') }]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === 'details') onEntry(entry);
          else openEntry(entry);
        }}
      >
        <View style={[styles.thumb, { backgroundColor: colors.surfaceHi }]}>
          <Cover
            entry={entry}
            settings={settings}
            style={styles.cover}
            colors={colors}
            letterSize={44}
          />
          {/* The shelf, as a colour rather than a word: at grid density a label
              does not fit, and the folder is the only thing that has to be
              readable at a glance. */}
          <View style={[styles.stripe, { backgroundColor: statusColor(status, colors) }]} />
          {n > 0 && (
            <View style={[styles.badge, { backgroundColor: colors.unread }]}>
              {/* Ink is the theme's ground: dark on the amber, light on the
                  darkened amber. A fixed dark ink was 2.9:1 on the light one. */}
              <Text style={[styles.badgeText, { color: colors.bg }]}>{t('badgeNNew', [String(n)])}</Text>
            </View>
          )}
          {/* The reader's own score, the way the web card shows it (★ 8):
              on the other corner, so it never sits under the unread count. */}
          {entry.score != null && (
            <View style={[styles.score, { backgroundColor: colors.surface }]}>
              <Text style={[styles.badgeText, { color: colors.text }]}>{`★ ${entry.score}`}</Text>
            </View>
          )}
        </View>
        <View style={styles.caption}>
          <View style={styles.captionText}>
            <Text numberOfLines={2} style={[styles.title, { color: colors.text }]}>{entry.title}</Text>
            <Text numberOfLines={1} style={[styles.sub, { color: colors.muted }]}>
              {mark?.chapterLabel || entry.sourceDomain || ''}
            </Text>
          </View>
          {/* The sheet had one way in, a long press nobody was told about
              (QA report, F-39). Hidden from VoiceOver, which has the card's
              own "Details" action instead of a second stop per card. */}
          <Pressable
            onPress={() => onEntry(entry)}
            hitSlop={{ top: 12, bottom: 12, left: 11, right: 11 }}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={({ pressed }) => [styles.more, pressed && { opacity: 0.5 }]}
          >
            <Icon name="more" size={20} color={colors.muted} />
          </Pressable>
        </View>
        {/* The note, one line of it: the sheet has the whole text. */}
        {!!entry.note && (
          <Text numberOfLines={1} style={[styles.note, { color: colors.muted }]}>{entry.note}</Text>
        )}
      </Pressable>
    );
  };

  // A first launch, or a shelf emptied: what PanelFlow is for, and the three
  // ways in — find a series, open an address, or sign in and bring the one
  // the computer already has (QA report, F-19).
  if (library.length === 0) {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <ScreenTitle colors={colors} title={t('navLibrary')} inset={4} />
        <EmptyState
          colors={colors}
          icon="book"
          title={t('mobileWelcomeTitle')}
          body={t('mobileWelcomeBody')}
          actions={[
            { label: t('mobileWelcomeSearch'), onPress: () => onTab?.('search') },
            { label: t('mobileOpenAddress'), onPress: () => onTab?.('sites') },
            ...(store.account ? [] : [{ label: t('welcomeHaveAccount'), onPress: () => onTab?.('settings', 'account') }]),
          ]}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.page}
      refreshControl={(
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />
      )}
    >
      <ScreenTitle
        colors={colors}
        inset={4}
        title={t('navLibrary')}
        subtitle={library.length === 1 ? t('mobileLibraryCountOne') : t('mobileLibraryCount', [String(library.length)])}
      />
      {chips(
        [{ id: 'all', label: t('mediumAll') },
          ...media.map(({ id, count }) => ({ id, label: `${t('medium_' + id)} ${count}` }))],
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
          accessibilityRole="button"
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
          style={({ pressed }) => [styles.sortButton, { borderColor: colors.line }, pressed && { opacity: 0.6 }]}
        >
          <Text style={{ color: colors.text, fontSize: 13 }}>
            {`${t('popupSortOrder')} · ${t(`sort_${sortBy}`)}${tag ? ` · ${tag}` : ''}`}
          </Text>
        </Pressable>
      </View>

      <View style={styles.grid}>{shown.map(tile)}</View>

      <Sheet visible={sheet} onClose={() => setSheet(false)} colors={colors} label={t('popupSortOrder')}>
          <Text accessibilityRole="header" style={[styles.sheetHead, { color: colors.muted }]}>{t('popupSortOrder')}</Text>
          <View style={styles.wrap}>
            {Shelf.SORT_IDS.map((id) => {
              const on = sortBy === id;
              return (
                <Pressable
                  key={id}
                  onPress={() => setSortBy(id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  hitSlop={SLOP}
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
                      // A filter that is on or off, said as one.
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      hitSlop={SLOP}
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

          <Pressable
            onPress={() => setSheet(false)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.done, { borderColor: colors.line }, pressed && { opacity: 0.6 }]}
          >
            <Text style={{ color: colors.text }}>{t('actionDone')}</Text>
          </Pressable>
      </Sheet>

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

/** What a chip drawn 32 points high adds to reach 44 under a finger. */
const SLOP = { top: 6, bottom: 6, left: 2, right: 2 };

const styles = StyleSheet.create({
  page: { paddingHorizontal: 12, paddingBottom: 32 },
  chipRow: { paddingVertical: 8, paddingHorizontal: 4, gap: 6 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  sortRow: { paddingHorizontal: 4, paddingBottom: 6 },
  sortButton: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
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
  badgeText: { fontSize: 11, fontWeight: '700' },
  score: { position: 'absolute', top: 5, left: 5, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 2 },
  note: { fontSize: 11, marginTop: 1, fontStyle: 'italic' },
  caption: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 5 },
  captionText: { flex: 1, minWidth: 0 },
  more: { paddingLeft: 2, paddingTop: 1 },
  title: { fontSize: 13, lineHeight: 16, fontWeight: '500' },
  sub: { fontSize: 11.5, marginTop: 1 },
});

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
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Cover from '../components/Cover.js';
import { t } from '../i18n.js';
import { Empty } from '../ui.js';

/**
 * The rows, in the order somebody would look for them, each with the word for
 * what one does with that medium. Reading a manga and watching an anime are not
 * the same verb, and a single heading for both would be wrong twice.
 */
const ROWS = [
  { medium: 'manga', label: 'mobileMediumManga' },
  { medium: 'webtoon', label: 'popupGroupWebtoons' },
  { medium: 'novel', label: 'popupGroupNovels' },
  { medium: 'anime', label: 'mobileMediumAnime' },
];

const HOW_MANY = 15;

export default function RecentScreen({ store, colors, onOpen, onEntry }) {
  const { library, progress, targets, settings } = store;

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
        entries: read.filter((e) => String(e.medium || 'manga') === row.medium).slice(0, HOW_MANY),
      }))
      .filter((row) => row.entries.length > 0);
  }, [library, progress]);

  const open = (entry) => {
    const url = targets[entry.id]?.url
      || progress[entry.sourceUrl]?.chapterUrl
      || entry.sourceUrl;
    if (url) onOpen(url, entry);
    else onEntry(entry);
  };

  if (rows.length === 0) {
    return <Empty colors={colors}>{t('statsNothingRead')}</Empty>;
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      {rows.map((row) => (
        <View key={row.medium}>
          <Text style={[styles.head, { color: colors.text }]}>{t(row.label)}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {row.entries.map((entry) => {
              return (
                <Pressable
                  key={entry.id || entry.sourceUrl}
                  onPress={() => open(entry)}
                  onLongPress={() => onEntry(entry)}
                  style={styles.card}
                >
                  <View style={[styles.thumb, { backgroundColor: colors.surfaceHi }]}>
                    <Cover
                      entry={entry}
                      settings={settings}
                      style={styles.cover}
                      textStyle={[styles.fallback, { color: colors.muted }]}
                    />
                  </View>
                  <Text numberOfLines={2} style={[styles.title, { color: colors.text }]}>
                    {entry.title}
                  </Text>
                  <Text numberOfLines={1} style={[styles.sub, { color: colors.muted }]}>
                    {progress[entry.sourceUrl]?.chapterLabel || ''}
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
  head: { fontSize: 16, fontWeight: '600', marginTop: 16, marginBottom: 8 },
  card: { width: 108, marginRight: 10 },
  thumb: { width: '100%', aspectRatio: 2 / 3, borderRadius: 8, overflow: 'hidden', justifyContent: 'center' },
  cover: { width: '100%', height: '100%' },
  fallback: { fontSize: 11, textAlign: 'center', paddingHorizontal: 4 },
  title: { fontSize: 12, marginTop: 5, lineHeight: 15 },
  sub: { fontSize: 11, marginTop: 1 },
});

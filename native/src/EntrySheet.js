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
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Folders, Shelf } from './shared.js';
import { send } from './core.js';
import { languageName, t } from './i18n.js';
import { chapterNumber, newChapters, opening } from './format.js';
import { Button, Field } from './ui.js';
import { statusColor } from './theme.js';
import Cover from './components/Cover.js';
import Sheet from './components/Sheet.js';

const SCORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const TRACKER_NAMES = { anilist: 'AniList', mal: 'MyAnimeList', kitsu: 'Kitsu' };
export const trackerName = (s) => TRACKER_NAMES[s] || s;
// "Ep." and "episodes" for an anime — the pairs live in shared/library-view.js.
const tu = (key, entry, subs) => t(Shelf.unitKey(key, entry), subs);

/** What the trackers say about this series: asked once per opening, never before. */
function useTrackerEntry(entry) {
  const [state, setState] = useState({ loading: true, entries: [], connected: [], errors: [] });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, entries: [], connected: [], errors: [] });
    // The medium picks the half of the catalogue; the host lets the server cut
    // the site's name off a title saved before titles were cleaned.
    send({ type: 'trackerEntry', title: entry.title, medium: Shelf.mediumOf(entry), host: entry.sourceDomain })
      .then((r) => { if (alive) setState({ loading: false, ...(r || {}), entries: r?.entries || [], connected: r?.connected || [], errors: r?.errors || [] }); })
      .catch(() => { if (alive) setState({ loading: false, entries: [], connected: [], errors: [] }); });
    return () => { alive = false; };
  }, [entry.id, entry.title, entry.medium]);
  return state;
}

/**
 * Kept on screen while it leaves: the series it was opened on stays drawn
 * until the sheet has gone down, so closing is the opening played backwards
 * rather than a panel that empties and then vanishes.
 */
export default function EntrySheet({ entry, store, colors, onClose, onOpen, onRemove, toast }) {
  const [held, setHeld] = useState(entry);
  useEffect(() => { if (entry) setHeld(entry); }, [entry]);
  const shown = entry || held;
  if (!shown) return null;
  return (
    <Sheet
      visible={!!entry}
      onClose={onClose}
      onHidden={() => setHeld(null)}
      colors={colors}
      label={shown.title}
      style={styles.sheet}
    >
      <Body key={shown.id} entry={shown} store={store} colors={colors} onClose={onClose} onOpen={onOpen} onRemove={onRemove} toast={toast} />
    </Sheet>
  );
}

function Body({ entry, store, colors, onClose, onOpen, onRemove }) {
  const { categories, progress, targets, settings } = store;
  const target = targets[entry.id];
  // The bookmark — the furthest chapter reached — which a reread under way
  // does not move (arbitrage e). The record itself is the last position.
  const record = progress[entry.sourceUrl];
  const bookmark = Shelf.bookmarkOf(record);
  const [note, setNote] = useState(entry.note || '');
  const trackers = useTrackerEntry(entry);

  const patch = async (fields) => {
    await send({ type: 'updateEntry', id: entry.id, patch: fields });
    await store.refresh();
  };
  const file = async (folder) => { await patch({ folder }); onClose(); };

  const behind = (() => {
    try { return Math.round(Shelf.newChapters(entry, record, categories)); } catch { return 0; }
  })();
  const medium = t('medium_' + Shelf.mediumOf(entry));
  // "Add to MyAnimeList", one service at a time: what it is saying, and the
  // catalogue's guesses when the title alone did not settle which work it is.
  const [adding, setAdding] = useState({});
  const addTo = async (service, pick) => {
    setAdding((a) => ({ ...a, [service]: { busy: true, note: t('modalTrackerAdding') } }));
    const resp = await send({
      type: 'trackerAdd', sourceUrl: entry.sourceUrl, service,
      remoteId: pick?.id ?? null, remoteTitle: pick?.title ?? null,
    }).catch((e) => ({ error: String(e?.message ?? e) }));
    const r = resp?.result;
    const name = trackerName(service);
    let next;
    if (resp?.error || !r) {
      next = { note: t('modalTrackerFailed', [name, resp?.error || t('modalTrackerNoAnswer')]) };
    } else if (r.skipped === 'unmatched') {
      const hits = (r.hits || []).slice(0, 5);
      next = {
        note: hits.length ? t('modalTrackerPickSeries', [name]) : t('modalTrackerNoHits', [name, entry.title]),
        hits,
      };
    } else {
      next = {
        done: true,
        note: r.already
          ? t('modalTrackerAlready', [name, [r.remoteTitle, r.folder ? t(`folder_${r.folder}`) : null]
            .filter(Boolean).join(' · ')])
          : r.count ? tu('modalTrackerAdded', entry, [name, String(r.count)]) : t('modalTrackerAddedPlain', [name]),
      };
    }
    setAdding((a) => ({ ...a, [service]: next }));
  };
  // Asked first, the way the web app and the popup ask: the button sits at the
  // bottom of a sheet the thumb scrolls through, one slip from being pressed.
  // The Undo that follows (Shell.js) is still there for a mind changed later.
  //
  // A series that is also on the reader's AniList or MyAnimeList list gets a
  // third answer, "Remove everywhere", and a line saying what it deletes: the
  // choice the web app and the popup offer as a box to tick. Never the
  // default — the list over there keeps a score and a count this Undo cannot
  // bring back.
  const askRemove = () => {
    const holding = [...new Set(trackers.entries.map((e) => e.service))];
    const names = holding.map(trackerName).join(', ');
    Alert.alert(
      t('confirmRemoveTitle', [entry.title]),
      [t(store.account ? 'confirmRemoveBody' : 'confirmRemoveBodyLocal'),
        holding.length ? t('confirmRemoveAlsoOn', [names]) : null].filter(Boolean).join('\n\n'),
      [
        { text: t('actionCancel'), style: 'cancel' },
        { text: t('confirmRemoveAction'), style: 'destructive', onPress: () => onRemove(entry) },
        ...(holding.length ? [{
          text: t('confirmRemoveEverywhere'),
          style: 'destructive',
          onPress: () => onRemove(entry, { trackers: holding }),
        }] : []),
      ],
    );
  };
  const pill = (label, on) => (
    <View key={label} style={[styles.pill, { borderColor: on ? colors.accent : colors.line, backgroundColor: on ? colors.surfaceHi : 'transparent' }]}>
      <Text style={{ color: on ? colors.text : colors.muted, fontSize: 12 }}>{label}</Text>
    </View>
  );

  return (
    <>
        {/* The head: cover, title, site, kind. */}
        <View style={styles.head}>
          <View style={[styles.thumb, { backgroundColor: colors.surfaceHi }]}>
            <Cover entry={entry} settings={settings} style={styles.cover} colors={colors} letterSize={30} />
          </View>
          <View style={styles.headText}>
            <Text style={[styles.title, { color: colors.text }]} numberOfLines={3}>{entry.title}</Text>
            <Text style={[styles.sub, { color: colors.muted }]} numberOfLines={1}>{entry.sourceDomain || entry.sourceUrl}</Text>
            <View style={styles.pills}>
              {medium && pill(medium, false)}
              {entry.language && pill(languageName(entry.language), false)}
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
                <Text
                  style={{ color: behind > 0 ? colors.unread : colors.muted, marginTop: 2 }}
                  accessibilityLabel={[
                    opening(tu('webLatestChapter', entry, [chapterNumber(entry.lastKnownChapter)])),
                    behind > 0 ? newChapters(behind, entry) : null,
                  ].filter(Boolean).join(', ')}
                >
                  {opening(tu('webLatestChapter', entry, [chapterNumber(entry.lastKnownChapter)]))}
                  {behind > 0 ? `  ·  ${t('badgeNNew', [String(behind)])}` : ''}
                </Text>
              )}

              {/* What the button says is where it goes: the next chapter when
                  the bookmark's is finished and a newer one is out. */}
              {target?.url && (
                <Button
                  colors={colors}
                  label={target.isNew ? tu('actionReadChapter', entry, [target.label])
                    : bookmark?.chapterLabel ? t('actionContinueChapter', [target.label || bookmark.chapterLabel])
                    : tu('actionRead', entry)}
                  onPress={() => { onClose(); onOpen(target.url, entry); }}
                />
              )}
              {target?.reread?.url && (
                <Button
                  colors={colors}
                  kind="ghost"
                  label={t('actionResumeReread', [target.reread.label || tu('webFieldChapter', entry)])}
                  onPress={() => { onClose(); onOpen(target.reread.url, entry); }}
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
                      // One shelf out of several: which one it is on has to be
                      // said, not only drawn (QA re-test It.5, N-A14).
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      hitSlop={{ top: 5, bottom: 5 }}
                      style={[styles.chip, { borderColor: on ? colors.accent : colors.line, backgroundColor: on ? colors.surfaceHi : 'transparent' }]}
                    >
                      <View style={[styles.dot, { backgroundColor: statusColor(f.status || f.id, colors) }]} />
                      <Text style={{ color: on ? colors.text : colors.muted }}>{f.custom ? f.label : t(`folder_${f.id}`)}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {/* What kind of work it is. Nothing on a page tells a web novel
                  from a light novel, so the reader has the last word; moving a
                  series between read and watched unlinks it from the trackers
                  (routes/library.js), which will look for it again. */}
              <Text style={[styles.label, { color: colors.muted }]}>{t('fieldMedium')}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
                {Shelf.MEDIA.map((m) => {
                  const on = Shelf.mediumOf(entry) === m.id;
                  return (
                    <Pressable
                      key={m.id}
                      onPress={() => { if (!on) patch({ medium: m.id }); }}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      hitSlop={{ top: 5, bottom: 5 }}
                      style={[styles.chip, { borderColor: on ? colors.accent : colors.line, backgroundColor: on ? colors.surfaceHi : 'transparent' }]}
                    >
                      <Text style={{ color: on ? colors.text : colors.muted }}>{t('medium_' + m.id)}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {/* Your score: ten stars, the lit one is yours, tapping it again
                  clears it. To VoiceOver it is one control, not ten "black
                  star" buttons: "Score, 7 out of 10, adjustable" — swipe up or
                  down to change it (QA report, F-42). */}
              <Text style={[styles.label, { color: colors.muted }]}>{t('fieldScore')}</Text>
              <View
                style={styles.stars}
                accessible
                accessibilityRole="adjustable"
                accessibilityLabel={t('fieldScore')}
                accessibilityValue={{ text: entry.score != null ? t('mobileScoreValue', [String(entry.score)]) : t('mobileScoreNone') }}
                accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                onAccessibilityAction={({ nativeEvent }) => {
                  const now = entry.score ?? 0;
                  const next = nativeEvent.actionName === 'increment' ? Math.min(10, now + 1) : Math.max(0, now - 1);
                  if (next !== now) patch({ score: next === 0 ? null : next });
                }}
              >
                {SCORES.map((n) => (
                  <Pressable
                    key={n}
                    onPress={() => patch({ score: entry.score === n ? null : n })}
                    hitSlop={{ top: 10, bottom: 10, left: 2, right: 2 }}
                    style={styles.star}
                  >
                    {/* An unlit star is still a star to hit: drawn in the
                        palette's muted ink, not the hairline one (1.4:1). */}
                    <Text style={{ fontSize: 24, color: entry.score != null && n <= entry.score ? colors.accent : colors.muted }}>★</Text>
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
                  const live = adding[service];
                  // Not on that list: a button that puts it there, from here.
                  const offer = !found && !failed && !live?.done;
                  return (
                    <View key={service}>
                      <View style={styles.trackerRow}>
                        <Text style={{ color: colors.text, fontWeight: '600' }}>{trackerName(service)}</Text>
                        <Text
                          style={{ color: live?.done ? colors.ok : colors.muted, flex: 1 }}
                          numberOfLines={3}
                          accessibilityLiveRegion="polite"
                        >
                          {live?.note ?? (failed ? t('trackerUnreachable')
                            : !found ? t('mobileTrackerNotThere')
                              : [
                                found.remoteTitle,
                                found.chaptersRead != null ? tu('mobileTrackerChapters', entry, [String(found.chaptersRead)]) : null,
                                found.score != null ? `★ ${found.score}` : null,
                                found.folder ? t(`folder_${found.folder}`) : null,
                              ].filter(Boolean).join(' · '))}
                        </Text>
                      </View>
                      {offer && !live?.hits?.length && (
                        <Button
                          colors={colors}
                          kind="ghost"
                          busy={!!live?.busy}
                          label={t('trackerAddTo', [trackerName(service)])}
                          onPress={() => addTo(service)}
                        />
                      )}
                      {(live?.hits || []).map((hit) => (
                        <Button
                          key={hit.id}
                          colors={colors}
                          kind="ghost"
                          label={hit.title}
                          onPress={() => addTo(service, hit)}
                        />
                      ))}
                    </View>
                  );
                })
              )}

              {/* Written five seconds late, with "Undo" on screen until then
                  (Shell.js). It used to go at once, with no way back. */}
              <Button
                colors={colors}
                kind="danger"
                label={t('actionRemoveFromLibrary')}
                onPress={askRemove}
              />
          </>
        </ScrollView>

        <Button colors={colors} kind="ghost" label={t('actionClose')} onPress={onClose} />
    </>
  );
}

const styles = StyleSheet.create({
  sheet: { maxHeight: '88%' },
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
  stars: { flexDirection: 'row', alignItems: 'center', gap: 0 },
  // 28 points wide and 44 tall with the slop: ten of them fit a 320-point
  // screen, and each is a target a thumb can find.
  star: { width: 28, alignItems: 'center' },
  trackerRow: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 6 },
});

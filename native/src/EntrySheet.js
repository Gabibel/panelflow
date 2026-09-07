// What you can do to one series, without leaving the shelf.
//
// The phone's answer to the extension's library modal: which folder it is
// filed under, where it leads, and getting rid of it. Filing is the one that
// earns the sheet — `folder` is a single field every client reads and writes,
// so moving a series here moves it on the website before the sheet has closed.
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Folders } from './shared.js';
import { send } from './core.js';
import { t } from './i18n.js';
import { Button } from './ui.js';
import { statusColor } from './theme.js';

export default function EntrySheet({ entry, store, colors, onClose, onOpen, toast }) {
  if (!entry) return null;
  const { categories, progress, targets } = store;
  const target = targets[entry.id];
  const bookmark = progress[entry.sourceUrl];

  const file = async (folder) => {
    await send({ type: 'updateEntry', id: entry.id, patch: { folder } });
    await store.refresh();
    onClose();
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={[styles.scrim, { backgroundColor: colors.scrim }]} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>{entry.title}</Text>
        <Text style={[styles.sub, { color: colors.muted }]} numberOfLines={1}>
          {entry.sourceDomain || entry.sourceUrl}
        </Text>

        {target?.url && (
          <Button
            colors={colors}
            // Named after the chapter when there is one to name: "Continue —
            // Ch. 110" is the whole reason to have opened the app.
            label={bookmark?.chapterLabel
              ? t('actionContinueChapter', [bookmark.chapterLabel])
              : t('actionRead')}
            onPress={() => { onClose(); onOpen(target.url, entry); }}
          />
        )}
        {entry.sourceUrl && (
          <Button
            colors={colors}
            kind="ghost"
            label={t('actionOpenSeriesPage')}
            onPress={() => { onClose(); onOpen(entry.sourceUrl, entry); }}
          />
        )}

        <Text style={[styles.label, { color: colors.muted }]}>{t('fieldFolder')}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {Folders.folderTabs(categories).map((f) => {
            const on = String(entry.folder || Folders.DEFAULT_FOLDER) === f.id;
            return (
              <Pressable
                key={f.id}
                onPress={() => file(f.id)}
                style={[styles.chip, {
                  borderColor: on ? colors.accent : colors.line,
                  backgroundColor: on ? colors.surfaceHi : 'transparent',
                }]}
              >
                <View style={[styles.dot, { backgroundColor: statusColor(f.status || f.id, colors) }]} />
                <Text style={{ color: on ? colors.text : colors.muted }}>
                  {f.custom ? f.label : t(`folder_${f.id}`)}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

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
        <Button colors={colors} kind="ghost" label={t('actionCancel')} onPress={onClose} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1 },
  sheet: {
    borderTopLeftRadius: 16, borderTopRightRadius: 16, borderTopWidth: 1,
    padding: 16, paddingBottom: 28,
  },
  title: { fontSize: 17, fontWeight: '600' },
  sub: { fontSize: 12, marginTop: 2, marginBottom: 10 },
  label: { fontSize: 12, marginTop: 14, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6 },
  row: { gap: 8, paddingBottom: 6 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
});

// AniList and MyAnimeList, from the phone.
//
// Nothing secret passes through here. The client secret and the account tokens
// live on the backend, which is why connecting is a URL it hands back rather
// than a form this screen could fill: PanelFlow sends the reader to the
// tracker's own permission page, the tracker redirects to the backend, and the
// backend keeps the token. This screen only ever asks the hub — the same five
// messages the extension's popup sends, so an account connected on the desktop
// is already connected here.
//
// Kitsu is deliberately absent from the answer: it only offers a password
// grant, and PanelFlow does not ask anybody for a tracker password.
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { send } from '../../core.js';
import { t } from '../../i18n.js';
import { Button, Empty, Hint } from '../../ui.js';

/** Title case for a service id, which is all the API gives us. */
const label = (service) => ({ anilist: 'AniList', mal: 'MyAnimeList' }[service]
  || service.charAt(0).toUpperCase() + service.slice(1));

export default function TrackersPage({ colors, onOpen, toast }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(null);
  // What a dry run found, per service, waiting for the second press. The two
  // presses are the confirmation: an import writes across the whole library at
  // once, and the numbers are what turn that into a decision.
  const [pending, setPending] = useState({});

  const load = useCallback(async () => {
    const r = await send({ type: 'trackers' });
    // One answer, three lists — services, connections, links — asked together
    // by the hub so this screen is never drawn half-informed.
    setState(r?.error ? { error: r.error } : r);
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = async (name, work) => {
    setBusy(name);
    try { await work(); } finally { setBusy(null); }
  };

  if (!state) return <Hint colors={colors}>{t('trackerAsking')}</Hint>;
  if (state.error) return <Empty colors={colors}>{t('trackerUnreachable')}</Empty>;

  const connected = new Map((state.connected || []).map((c) => [c.service, c]));

  // A ScrollView, and that is a fix rather than a detail: the settings frame
  // scrolls the pages that take preferences and hands the others their own
  // room, so this one was drawing three cards into a fixed box and losing the
  // bottom of the third behind the tab bar.
  return (
    <ScrollView contentContainerStyle={styles.page}>
      {(state.services || []).map((svc) => {
        const link = connected.get(svc.service);
        const name = label(svc.service);
        return (
          <View key={svc.service} style={[styles.card, { borderColor: colors.line }]}>
            <Text style={[styles.name, { color: colors.text }]}>{name}</Text>

            {/* Four different noes, and they are not interchangeable: no
                permission page will ever exist, this deployment has no
                credentials, connected, or simply not yet. */}
            <Text style={[styles.state, { color: link ? colors.ok : colors.muted }]}>
              {!svc.oauth ? t('trackerPasswordAuth')
                : !svc.configured ? t('trackerNoCredentials')
                  : link ? (link.remoteUser
                    ? t('trackerConnectedAs', [link.remoteUser])
                    : t('trackerConnected'))
                    : t('trackerNotConnected')}
              {link && !svc.canPush ? t('trackerNotListening') : ''}
            </Text>

            {/* A token that stopped being accepted looks exactly like a working
                one until something says so. AniList's last a year and cannot be
                refreshed, so this line is the difference between "connected"
                and "connected and still listening". */}
            {link?.lastError && (
              <Text style={[styles.error, { color: colors.danger }]}>
                {t('trackerRefusing', [link.lastError])}
              </Text>
            )}

            {svc.oauth && svc.configured && !link && (
              <Button
                colors={colors}
                busy={busy === `connect:${svc.service}`}
                label={t('actionConnect')}
                onPress={() => run(`connect:${svc.service}`, async () => {
                  const r = await send({ type: 'trackerConnect', service: svc.service });
                  if (r?.error || !r?.authorizeUrl) return toast(r?.error || t('trackerUnreachable'));
                  // The tracker's own page, in the app's browser. The backend
                  // is what the redirect comes back to, so there is nothing to
                  // catch here — coming back and pressing refresh is the whole
                  // of the second half.
                  onOpen(r.authorizeUrl);
                  return undefined;
                })}
              />
            )}

            {link && (
              <>
                <Button
                  colors={colors}
                  kind="ghost"
                  busy={busy === `push:${svc.service}`}
                  label={t('trackerSendMyLibrary')}
                  onPress={() => run(`push:${svc.service}`, async () => {
                    toast(t('trackerSending', [name]));
                    const r = await send({ type: 'trackerPushAll', service: svc.service });
                    const report = r?.report || {};
                    toast(r?.error || t('trackerSent', [String(report.sent ?? 0)]));
                  })}
                />
                <Hint colors={colors}>{t('trackerSendMyLibraryHint')}</Hint>

                <Button
                  colors={colors}
                  kind="ghost"
                  busy={busy === `pull:${svc.service}`}
                  label={t('trackerFetchAll')}
                  onPress={() => run(`pull:${svc.service}`, async () => {
                    toast(t('trackerFetching', [name]));
                    const r = await send({ type: 'trackerPull', service: svc.service });
                    const report = r?.report || {};
                    toast(r?.error || t('trackerFetched', [String(report.updated ?? 0)]));
                  })}
                />
                <Hint colors={colors}>{t('trackerFetchAllHint')}</Hint>

                {/* Asked twice on purpose: the first press reports, the second
                    writes. An import touches the whole library at once, and
                    seeing the two numbers first is what makes it a decision. */}
                <Button
                  colors={colors}
                  kind="ghost"
                  busy={busy === `import:${svc.service}`}
                  label={pending[svc.service]
                    ? t('trackerImportPending', [
                      String(pending[svc.service].added), String(pending[svc.service].updated)])
                    : t('trackerImportList')}
                  onPress={() => run(`import:${svc.service}`, async () => {
                    // Second press: the same call without `dryRun`, which is
                    // what actually writes.
                    if (pending[svc.service]) {
                      const done = await send({ type: 'trackerImport', service: svc.service });
                      setPending((was) => ({ ...was, [svc.service]: null }));
                      if (done?.error) return toast(done.error);
                      const { added = 0, updated = 0 } = done.report || {};
                      toast(t('trackerImportDone', [String(added), String(updated)]));
                      await load();
                      return undefined;
                    }
                    const dry = await send({ type: 'trackerImport', service: svc.service, dryRun: true });
                    if (dry?.error) return toast(dry.error);
                    const { added = 0, updated = 0 } = dry.report || {};
                    if (!added && !updated) return toast(t('trackerNothingMissing', [name]));
                    setPending((was) => ({ ...was, [svc.service]: { added, updated } }));
                    toast(t('trackerImportPreview', [String(added), String(updated)]));
                    return undefined;
                  })}
                />
                <Button
                  colors={colors}
                  kind="danger"
                  busy={busy === `off:${svc.service}`}
                  label={t('actionDisconnect')}
                  onPress={() => run(`off:${svc.service}`, async () => {
                    await send({ type: 'trackerDisconnect', service: svc.service });
                    await load();
                  })}
                />
              </>
            )}
          </View>
        );
      })}

      <Button colors={colors} kind="ghost" label={t('actionSyncNow')} onPress={load} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 48 },
  card: { borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 14, gap: 2 },
  name: { fontSize: 16, fontWeight: '600' },
  state: { fontSize: 13, marginBottom: 8 },
  error: { fontSize: 12, marginBottom: 8 },
});

// How often this phone goes looking for new chapters, and whether it says so.
//
// Only while the app is running: the server keeps watching the sites it can
// reach on its own and hands over what it found the next time this client asks,
// which is why checking rarely costs less than it looks.
//
// The banners are a switch here, off until the reader turns it on — which is
// when the system asks for permission, not the first time a check finds
// something (QA report, F-48; native/src/notify.js).
import { useEffect, useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import Choice from '../../components/Choice.js';
import { Button, Heading, Hint } from '../../ui.js';
import { notificationState, openNotificationSettings, setNotifications } from '../../notify.js';
import { t } from '../../i18n.js';

export default function UpdatesPage({ prefs, set, colors }) {
  const [notify, setNotify] = useState(null); // { on, blocked }
  useEffect(() => { notificationState().then(setNotify); }, []);

  return (
    <>
      <Heading colors={colors}>{t('mobileNotifyHeading')}</Heading>
      <View style={styles.row}>
        <Text style={[styles.rowText, { color: colors.text }]}>{t('mobileNotifyNewChapters')}</Text>
        <Switch
          value={!!notify?.on}
          disabled={!notify}
          onValueChange={async (on) => setNotify(await setNotifications(on))}
          accessibilityLabel={t('mobileNotifyNewChapters')}
          trackColor={{ true: colors.accent, false: colors.line }}
        />
      </View>
      {notify?.blocked ? (
        <>
          <Hint colors={colors}>{t('mobileNotifyBlocked')}</Hint>
          <Button colors={colors} kind="ghost" label={t('mobileNotifyOpenSettings')} onPress={openNotificationSettings} />
        </>
      ) : (
        <Hint colors={colors}>{t('mobileNotifyHint')}</Hint>
      )}

      <Heading colors={colors}>{t('optionsCheckEvery')}</Heading>
      <Choice
        colors={colors}
        value={prefs.checkIntervalMin}
        onChange={(v) => set('checkIntervalMin', v)}
        options={[
          { value: 60, label: t('optionsEvery1h') },
          { value: 180, label: t('optionsEvery3h') },
          { value: 360, label: t('optionsEvery6h') },
          { value: 720, label: t('optionsEvery12h') },
          { value: 1440, label: t('optionsEvery24h') },
        ]}
      />
      <Hint colors={colors}>{t('mobileUpdatesHint')}</Hint>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 48 },
  rowText: { flex: 1, fontSize: 16 },
});

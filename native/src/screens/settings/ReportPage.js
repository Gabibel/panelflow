// "Signaler un problème": everything a bug report needs, in one mail the
// reader sends themselves.
//
// The testers were sending screenshots, and a screenshot of a page that did
// not open says nothing about why. This screen gathers what does: the build
// (so a fix that is not in the tester's build is not reported as not
// working), the phone and its system, the page they were on, the moment, and
// the last few things the app noted (native/src/diagnostics.js). Then it
// hands all of that to the mail app, addressed to the operator, for the
// tester to add a sentence to and send. The lines and the address are
// shared/report.js, so the PC writes the same mail.
//
// Opt-in, entirely: nothing is gathered until the screen is opened and nothing
// leaves the phone until the tester presses Send in their own mail app. The
// privacy page promises exactly that, and legal-pages.test.js holds this
// file's address to the one on that page.
import { useState } from 'react';
import { Linking, Platform, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import * as Application from 'expo-application';
import '../../../generated/shared/report.js';
import { lastPage, recent } from '../../diagnostics.js';
import { t } from '../../i18n.js';
import { Button, Field, Heading, Hint } from '../../ui.js';

// The address and the lines are shared/report.js, the same the extension's
// options page and the web app's settings use: one report, three surfaces.
const { REPORT_TO, reportLines, mailto } = globalThis.PanelFlowReport;
export { REPORT_TO, reportLines };

export default function ReportPage({ colors }) {
  const [description, setDescription] = useState('');
  const app = {
    version: Application.nativeApplicationVersion || '?',
    build: Application.nativeBuildVersion || '?',
  };
  const platform = { os: Platform.OS, version: String(Platform.Version) };

  const body = () => reportLines({
    description, url: lastPage(), events: recent(), app, platform, now: new Date().toISOString(),
  }).join('\n');

  const mail = async () => {
    const url = mailto(REPORT_TO, `PanelFlow ${app.version} (${app.build})`, body().split('\n'));
    // No mail app is a real case on a fresh phone; the share sheet takes the
    // same text anywhere else.
    if (await Linking.canOpenURL(url)) await Linking.openURL(url);
    else await Share.share({ message: body() });
  };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Hint colors={colors}>{t('mobileReportLede')}</Hint>
      <Field
        colors={colors}
        label={t('mobileReportWhat')}
        value={description}
        onChangeText={setDescription}
        multiline
      />
      <Button colors={colors} label={t('mobileReportSend')} onPress={mail} disabled={!description.trim()} />
      <Button colors={colors} kind="ghost" label={t('mobileReportShare')} onPress={() => Share.share({ message: body() })} />

      <Heading colors={colors}>{t('mobileReportIncluded')}</Heading>
      <View style={[styles.box, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <Text style={[styles.mono, { color: colors.muted }]} selectable>
          {reportLines({ description: '', url: lastPage(), events: recent(), app, platform, now: new Date().toISOString() })
            .filter((l) => l !== '(what happened?)').join('\n')}
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 40 },
  box: { borderWidth: 1, borderRadius: 8, padding: 10, marginTop: 8 },
  mono: { fontSize: 12, lineHeight: 17, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
});

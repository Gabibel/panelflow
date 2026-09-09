// One broken screen must not be a broken app.
//
// React unmounts the whole tree when a render throws, and on a phone that is a
// black screen with no way back — the failure everybody reports as "the app
// crashed" and nobody can describe further. Wrapping each screen in one of
// these keeps the fault where it happened: the tab bar still works, the other
// four screens still work, and the one that broke says so, by name, with the
// message in it.
//
// It has to be a class. Error boundaries are the one thing React has no hook
// for, and `componentDidCatch` exists nowhere else.
import { Component } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // The stack, for whoever is reading a terminal. What is on screen is for
    // whoever is holding the phone, and the two want different things.
    console.warn(`[panelflow] ${this.props.name} crashed`, error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    const { colors, name, children } = this.props;
    if (!error) return children;

    return (
      <View style={styles.box}>
        <Text style={[styles.head, { color: colors.danger }]}>{name}</Text>
        {/* Deliberately the raw message. This is not a screen a user was meant
            to see, so the useful thing to put on it is the thing that can be
            copied into a bug report. */}
        <Text style={[styles.detail, { color: colors.muted }]}>
          {String(error?.message ?? error)}
        </Text>
        <Pressable
          onPress={() => this.setState({ error: null })}
          style={[styles.retry, { borderColor: colors.line }]}
        >
          <Text style={{ color: colors.text }}>↻</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  box: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  head: { fontSize: 15, fontWeight: '600' },
  detail: { fontSize: 13, textAlign: 'center', lineHeight: 19 },
  retry: {
    borderWidth: 1, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 10, marginTop: 6,
  },
});

// The interface icons: one white-on-transparent picture each, tinted here.
//
// Drawn once, as lines on the same grid the reader's and the popup's icons
// use, and written out at the three iOS scales by scripts/build-icons.mjs (GLYPHS)
// (Metro picks @2x and @3x by itself). A tint is all an icon needs to follow
// the theme and the selected tab, and `tintColor` does that on iOS and on the
// web build alike — no icon font and no native module for it.
//
// Always decorative: an icon is never the only thing that names a control.
// The control around it carries the words (its label, or its accessibility
// label), so the picture is hidden from VoiceOver rather than read as "image".
import { Image } from 'react-native';

const SOURCES = {
  library: require('../../assets/icons/library.png'),
  history: require('../../assets/icons/history.png'),
  sites: require('../../assets/icons/sites.png'),
  search: require('../../assets/icons/search.png'),
  settings: require('../../assets/icons/settings.png'),
  more: require('../../assets/icons/more.png'),
  book: require('../../assets/icons/book.png'),
  bookmark: require('../../assets/icons/bookmark.png'),
  bell: require('../../assets/icons/bell.png'),
  link: require('../../assets/icons/link.png'),
  check: require('../../assets/icons/check.png'),
  close: require('../../assets/icons/close.png'),
};

export const ICON_NAMES = Object.keys(SOURCES);

export default function Icon({ name, color, size = 24, style }) {
  const source = SOURCES[name];
  if (!source) return null;
  return (
    <Image
      source={source}
      tintColor={color}
      style={[{ width: size, height: size }, style]}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}

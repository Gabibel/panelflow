// One cover image, and what to draw when there isn't one.
//
// Every shelf drew this itself, which meant every shelf had the same hole: an
// <Image> whose URL 404s renders nothing and says nothing, so a broken cover
// and a loading cover look alike for ever. Nobody was in a position to notice
// except the component doing the drawing, so noticing belongs here.
//
// Two things happen on failure, and they are separate on purpose:
//   * the title is drawn instead, so the tile is still readable;
//   * `reportBrokenCover` is told, so the next pass can go and find another
//     picture (see covers.js). This component does not fetch anything itself —
//     a component that repaired its own image would fire once per redraw.
import React, { useEffect, useState } from 'react';
import { Image, Text } from 'react-native';
import { coverSrc } from '../store.js';
import { reportBrokenCover } from '../covers.js';

/**
 * @param entry     the library entry, for its cover URL and its title
 * @param settings  needed to build the proxied URL
 * @param style     the image box — each shelf sizes its own
 * @param textStyle how the title reads when there is no picture
 */
export default function Cover({ entry, settings, style, textStyle }) {
  const src = coverSrc(entry, settings);
  const [failed, setFailed] = useState(false);

  // A different entry, or a replacement cover for this one, deserves a fresh
  // try — otherwise the tile that failed once stays text until the app restarts.
  useEffect(() => { setFailed(false); }, [src]);

  if (src && !failed) {
    return (
      <Image
        source={{ uri: src }}
        style={style}
        resizeMode="cover"
        onError={() => { setFailed(true); reportBrokenCover(entry?.id); }}
      />
    );
  }
  if (!textStyle) return null;
  return <Text numberOfLines={4} style={textStyle}>{entry?.title}</Text>;
}

let graphemeSegmenter: Intl.Segmenter | undefined
let wordSegmenter: Intl.Segmenter | undefined

/**
 * Memoized `Intl.Segmenter` with grapheme granularity for width-aware string
 * handling in the renderer and terminal parser.
 * @returns The shared grapheme segmenter, created once on first use.
 */
export function getGraphemeSegmenter(): Intl.Segmenter {
  return (graphemeSegmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' }))
}

/** Shared Unicode word boundaries, including languages without spaces. */
export function getWordSegmenter(): Intl.Segmenter {
  return (wordSegmenter ??= new Intl.Segmenter('en', { granularity: 'word' }))
}

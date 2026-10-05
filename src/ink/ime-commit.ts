import type { ParsedKey } from './parse-keypress.js'

/** Printable ASCII range — a committed cluster outside it came from an IME. */
const NON_ASCII = /[^\x20-\x7e]/

/**
 * Whether a parsed key carries text an input method just COMMITTED.
 *
 * An IME commit is the only composition signal a terminal app gets: the
 * preedit keystrokes (`y`, `i`, …) never reach us — the terminal feeds them
 * to the input method — while the committed characters arrive as one key
 * event carrying either a non-ASCII cluster (CJK, accented Latin, emoji) or
 * several code points at once. Multi-character printable payloads count too:
 * some protocols batch a fast burst into one event, and the caller's reaction
 * (reclaiming the cursor row, see `Ink.repaintCursorRow`) is harmless when it
 * fires for plain text.
 *
 * Excluded on purpose:
 *   - pasted payloads (`isPasted`): a paste is whole text, not a composition,
 *     and its cells are rewritten by the ordinary diff anyway;
 *   - control bytes and escape sequences: those are protocol (arrows, mouse,
 *     focus, terminal responses), and a lone ESC must never read as text.
 *
 * @param key - the parsed key to classify.
 * @returns true when the key's payload looks like committed composition text.
 */
export function isImeCommit(key: ParsedKey): boolean {
  if (key.kind !== 'key' || key.isPasted === true) return false
  const sequence = key.sequence
  if (sequence === undefined || sequence === '') return false
  const first = sequence.charCodeAt(0)
  if (first < 0x20 || first === 0x7f) return false
  if (NON_ASCII.test(sequence)) return true
  return [...sequence].length > 1
}

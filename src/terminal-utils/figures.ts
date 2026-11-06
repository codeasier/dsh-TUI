/**
 * Small, shared glyphs used by the terminal UI. Keep this module limited to
 * symbols with active consumers so each visual mark has one clear meaning.
 */

/** Activity bullet: ring on macOS, solid dot elsewhere. */
export const BLACK_CIRCLE = process.platform === 'darwin' ? '⏺' : '●'

/** Prompt pointer, a bold right chevron (`❯`). */
export const POINTER = '\u276f' // ❯
/** Success checkmark (`✓`). */
export const TICK = '\u2713' // ✓
/** Settled tool-status dot (`•`). */
export const BULLET = '\u2022' // •
/** Failed tool status (`✗`). */
export const MULTIPLICATION_X = '\u2717' // ✗

/** Direction markers used by the token counter and navigation affordances. */
export const UP_ARROW = '\u2191' // ↑
export const DOWN_ARROW = '\u2193' // ↓

/**
 * Thinking frames share a one-column footprint with the settled/expanded
 * markers below, so the label stays put when the stream settles.
 */
export const THINKING_SPINNER_FRAMES = [
  '\u280b', // ⠋
  '\u2819', // ⠙
  '\u2839', // ⠹
  '\u2838', // ⠸
  '\u283c', // ⠼
  '\u2834', // ⠴
  '\u2826', // ⠦
  '\u2827', // ⠧
  '\u2807', // ⠇
  '\u280f', // ⠏
]
export const THINKING_SPINNER_INTERVAL_MS = 80
/** Settled marker: a collapsed reasoning block (click or Ctrl+O opens it). */
export const THINKING_SETTLED_MARKER = '\u002b' // +
/** Expanded marker: the same block while open — the pair reads as `+`/`-`. */
export const THINKING_EXPANDED_MARKER = '\u002d' // -

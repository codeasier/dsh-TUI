import { createContext } from 'react'
import type { DOMElement } from '../dom.js'

/**
 * A declared cursor parking position: a node plus the line and column within
 * it where the terminal cursor should sit.
 */
export type CursorDeclaration = {
  /** Display column (terminal cell width) within the declared node */
  readonly relativeX: number
  /** Line number within the declared node */
  readonly relativeY: number
  /** The ink-box DOMElement whose yoga layout provides the absolute origin */
  readonly node: DOMElement
  /**
   * Columns past the node's right edge that must survive the IME tail clip
   * (parent border, padding, a sibling button). Set only by a real text
   * input: the renderer then erases the rest of that row so an input method's
   * composition band — and the caret it parks at the end of that band —
   * cannot run out of the box into the page margin. Undefined means do not
   * clip (a one-cell list caret must not wipe the rest of its row).
   */
  readonly imeProtectColumns?: number
}

/**
 * Setter for the declared cursor position.
 *
 * The optional second argument makes `null` a conditional clear: the
 * declaration is only cleared if the currently-declared node matches
 * `clearIfNode`. This makes the hook safe for sibling components
 * (e.g. list items) that transfer focus among themselves — without the
 * node check, a newly-unfocused item's clear could clobber a
 * newly-focused sibling's set depending on layout-effect order.
 */
export type CursorDeclarationSetter = (
  declaration: CursorDeclaration | null,
  clearIfNode?: DOMElement | null,
) => void

/**
 * React context that provides the cursor-declaration setter to descendants.
 */
const CursorDeclarationContext = createContext<CursorDeclarationSetter>(
  () => {},
)

export default CursorDeclarationContext

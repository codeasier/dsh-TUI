import sliceAnsi from '../utils/sliceAnsi.js'
import type { Styles } from './styles.js'
import wrapText from './wrap-text.js'
import { stringWidth } from './stringWidth.js'
import type { SoftWrapFlag } from './output.js'

export type HangingWrap = {
  /** Source text only: synthetic indentation must not enter style indexing. */
  wrapped: string
  syntheticIndents: number[]
  softWrap: SoftWrapFlag[] | undefined
}

/** Wrap each logical body at its content width, retaining its real first prefix. */
export function hangingWrap(
  text: string,
  width: number,
  wrap: Styles['textWrap'],
  continuationIndent: readonly number[],
): HangingWrap {
  if (wrap !== 'wrap' && wrap !== 'wrap-trim') {
    const wrapped = wrapText(text, width, wrap)
    return { wrapped, syntheticIndents: wrapped.split('\n').map(() => 0), softWrap: undefined }
  }
  const lines: string[] = []
  const syntheticIndents: number[] = []
  const softWrap: SoftWrapFlag[] = []
  for (const [index, source] of text.split('\n').entries()) {
    const requested = continuationIndent[index] ?? 0
    const indent = Number.isFinite(requested) && requested > 0 && width > requested
      ? Math.floor(requested)
      : 0
    const prefix = indent > 0 ? sliceAnsi(source, 0, indent) : ''
    const body = indent > 0 ? sliceAnsi(source, indent) : source
    const pieces = wrapText(body, indent > 0 ? width - indent : width, wrap).split('\n')
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!
      const gap = i > 0 && wrap === 'wrap' && piece.startsWith(' ') &&
        stringWidth(pieces[i - 1]!) === width - indent && stringWidth(piece.trim()) > 0
      lines.push(i === 0 ? prefix + piece : gap ? piece.slice(1) : piece)
      syntheticIndents.push(i > 0 ? indent : 0)
      softWrap.push(gap ? 'gap' : i > 0)
    }
  }
  return { wrapped: lines.join('\n'), syntheticIndents, softWrap }
}

/** Call only after source-indexed styles have been restored.
 *  indentStyle opens the synthetic cells' style without entering source indexing. */
export function addSyntheticIndents(text: string, indents: readonly number[], indentStyle = ''): string {
  return text.split('\n').map((line, i) => {
    const indent = indents[i] ?? 0
    return (indent > 0 ? indentStyle + ' '.repeat(indent) : '') + line
  }).join('\n')
}

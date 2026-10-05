/**
 * 词级编辑的 Unicode 词边界（编辑语义，与显示宽度无关）。
 *
 * 聊天页 composer（PromptInput）与启动页输入框（Launchpad 的单行编辑器）
 * 共用同一套跳词/删词几何：Ctrl/Option/Alt+←→ 与 Alt+B/F 按**词**移动、
 * `Ctrl+W` 删光标前一个词。边界由 `Intl.Segmenter` 的 word 粒度给出——
 * 无空格中文按语义成词，标点与 emoji 是独立单元；向左跳词跳过尾随空白
 * （编辑器的「词」不含其后空白，`Ctrl+W` 才能一次删掉「词 + 空白」）。
 * 两处必须同源：各写一份会出现「聊天页跳一词、启动页跳半句」的分叉。
 */
import { getWordSegmenter } from './intl.js'

/** Previous Unicode word start, skipping trailing whitespace. Punctuation
 *  and emoji are their own units, so deleting after them never eats a word too. */
export function wordBoundaryLeft(text: string, cursor: number): number {
  const segments = getWordSegmenter().segment(text)
  let offset = cursor
  while (offset > 0) {
    const { index, segment } = segments.containing(offset - 1)!
    if (!/^\s+$/u.test(segment)) return index
    offset = index
  }
  return 0
}

/** Next word start: finish the current segment, then skip following whitespace. */
export function wordBoundaryRight(text: string, cursor: number): number {
  const segments = getWordSegmenter().segment(text)
  const current = segments.containing(cursor)
  if (current === undefined) return text.length
  let offset = current.index + current.segment.length
  while (offset < text.length) {
    const next = segments.containing(offset)!
    if (!/^\s+$/u.test(next.segment)) break
    offset = next.index + next.segment.length
  }
  return offset
}

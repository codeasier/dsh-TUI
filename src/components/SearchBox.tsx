import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import Box from './design-system/ThemedBox.js'
import Text from './design-system/ThemedText.js'
import type { DOMElement } from '../ink/dom.js'
import measureElement from '../ink/measure-element.js'
import { useDeclaredCursor } from '../ink/hooks/use-declared-cursor.js'
import { useTerminalSize } from '../ink/hooks/use-terminal-size.js'
import { stringWidth } from '../ink/stringWidth.js'
import { getGraphemeSegmenter } from '../utils/intl.js'

/**
 * Cells kept clear to the right of the caret so an input method can paint
 * inside the box. Terminal emulators draw IME preedit AT the physical cursor,
 * extending rightwards — with the caret parked on the box's last interior
 * cell, the composition and its own caret bar spill over the border (and the
 * terminal reserves the row with its default background, which reads as a
 * black bar trailing the caret in CJK input). The window scrolls a few cells
 * earlier instead, so a short pinyin composition stays inside the frame.
 */
const IME_PREEDIT_RESERVE = 4

/**
 * Window a single-line query around the caret so the visible slice fits
 * `avail` display cells (CJK display width, grapheme safe — the same
 * `Intl.Segmenter` clusters the renderer lays out and PromptInput edits by,
 * so cluster widths can never disagree with the cells actually drawn). The
 * caret character itself always stays inside the window: leading characters
 * are dropped until before-caret text + caret + {@link IME_PREEDIT_RESERVE}
 * fit, then after-caret text fills what remains. `offset` arrives in UTF-16
 * units (callers move the caret by key count); an offset inside a cluster
 * (mid-surrogate, inside a ZWJ emoji) snaps back to that cluster's start.
 */
function windowQuery(
  query: string,
  offset: number,
  avail: number,
): { before: string; at: string; after: string; caretColumn: number } {
  const budget = Math.max(avail, 1)
  const caret = Math.max(0, Math.min(offset, query.length))
  // Grapheme clusters with their UTF-16 start offsets, in order.
  const clusters: Array<{ text: string; start: number }> = []
  for (const { segment, index } of getGraphemeSegmenter().segment(query)) {
    clusters.push({ text: segment, start: index })
  }
  // First cluster that ENDS after the caret offset; that is the caret cluster.
  let caretIndex = clusters.length
  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i]!
    if (cluster.start + cluster.text.length > caret) {
      caretIndex = i
      break
    }
  }
  const beforeClusters = clusters.slice(0, caretIndex)
  const at = caretIndex < clusters.length ? clusters[caretIndex]!.text : ' '
  const atWidth = Math.max(1, stringWidth(at))
  let caretColumn = 0
  for (const cluster of beforeClusters) caretColumn += stringWidth(cluster.text)
  let start = 0
  while (start < beforeClusters.length && caretColumn + atWidth + IME_PREEDIT_RESERVE > budget) {
    caretColumn -= stringWidth(beforeClusters[start]!.text)
    start++
  }
  let rest = budget - caretColumn - atWidth
  let after = ''
  for (const cluster of clusters.slice(caretIndex + 1)) {
    const w = stringWidth(cluster.text)
    if (w > rest) break
    after += cluster.text
    rest -= w
  }
  return {
    before: beforeClusters.slice(start).map(cluster => cluster.text).join(''),
    at,
    after,
    caretColumn,
  }
}

/**
 * 多行草稿最多画几行（落地页 Shift+Enter 换行）：超过就以光标行为锚开垂直
 * 窗口，绝不把输入框撑到屏外。落地页把它同时喂给 `resolveLaunchpadLayout`，
 * 立绘/键帽行该让位时先让位。
 */
export const MULTILINE_MAX_ROWS = 6

/** 按显示宽度取一行文本的头部（grapheme 安全，宽字符不劈半）。 */
function headToWidth(text: string, width: number): string {
  let used = 0
  let out = ''
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    const w = stringWidth(segment)
    if (used + w > width) break
    out += segment
    used += w
  }
  return out
}

/**
 * 多行草稿的行模型：按 `\n` 切行，光标所在行用与单行**同一套**窗口化
 * （含 IME 预留与 grapheme 对齐），其余行按内容宽度截头显示；行数超过
 * `maxRows` 时以光标行为锚做垂直窗口。返回的 `caretRow`/`caretColumn`
 * 已经是「相对输入框内容区」的坐标（`caretColumn` 含 `indent` 缩进，
 * 与首行的前缀宽度一致），声明光标直接吃这两个数。
 */
function windowMultiLine(
  query: string,
  offset: number,
  avail: number,
  maxRows: number,
  indent: number,
): {
  rows: Array<{ before: string; at: string; after: string; isCaret: boolean }>
  caretRow: number
  caretColumn: number
} {
  const lines = query.split('\n')
  const caret = Math.max(0, Math.min(offset, query.length))
  // 光标所在行 + 行内 UTF-16 偏移。
  let caretLine = 0
  let lineStart = 0
  {
    let pos = 0
    for (let i = 0; i < lines.length; i++) {
      const end = pos + lines[i]!.length
      if (caret <= end || i === lines.length - 1) {
        caretLine = i
        lineStart = pos
        break
      }
      pos = end + 1
    }
  }
  const caretCol = Math.max(0, caret - lineStart)
  const budget = Math.max(avail, 1)
  const windowStart = Math.max(0, Math.min(caretLine - maxRows + 1, lines.length - maxRows))
  const visible = lines.slice(windowStart, windowStart + maxRows)
  let caretColumn = 0
  const rows = visible.map((line, index) => {
    if (windowStart + index !== caretLine) {
      return { before: headToWidth(line, budget), at: '', after: '', isCaret: false }
    }
    const win = windowQuery(line, caretCol, budget)
    caretColumn = indent + win.caretColumn
    return { before: win.before, at: win.at, after: win.after, isCaret: true }
  })
  return { rows, caretRow: caretLine - windowStart, caretColumn }
}

/**
 * A single-line search input in a round-bordered box: `⌕ ` prefix, block
 * cursor at `cursorOffset` (inverse cell).
 * When empty and focused, the caret is an inverse block **on the first
 * character of the placeholder** (opencode style, 2026-10 第七版) — it never
 * occupies a cell of its own, so text never shifts; the terminal-painted IME
 * preedit (pinyin) still lands at the declared native cursor next to it.
 *
 * The query row is strictly single-line: an overlong query is windowed
 * around the caret (horizontal scroll) instead of wrapping, so the native
 * cursor declaration below stays exact for any query length.
 */
export function SearchBox({
  query,
  placeholder = 'Search…',
  isFocused,
  isTerminalFocused,
  prefix = '⌕',
  width,
  cursorOffset,
  borderless = false,
  caretBlink = true,
  placeholderAlign = 'right',
  multiline = false,
  maxRows = MULTILINE_MAX_ROWS,
}: {
  query: string
  placeholder?: string
  isFocused: boolean
  isTerminalFocused: boolean
  prefix?: string
  width?: number | string
  cursorOffset?: number
  borderless?: boolean
  /**
   * 空输入 + 焦点态那一行里占位文案的对齐（2026-10 落地页第四版新增）：
   * `right`（缺省，历史行为）贴框右缘；`left` 紧跟 `前缀 + 块状光标` 之后。
   * 共享组件——聊天页/选择器不传此 prop，渲染与从前逐字节一致。
   */
  placeholderAlign?: 'left' | 'right'
  /**
   * 光标闪烁相位（true = 反显、false = 常规）。落地页传入（约 550ms 一相位）；
   * 缺省 true 恒反显——其它使用方（选择器搜索等）保持不闪。
   *
   * 契约（第七版修订）：光标是**压在当前字符身上的反显块**（对那一个字符
   * 用 inverse；行尾时对反显空格），绝不另起一格、绝不吃掉字符；闪烁是
   * **纯样式切换**（inverse ↔ 常规——上一版是 inverse ↔ inverse+dim，dim
   * 相位在部分终端会把反显块里的字形糊到几乎看不见，看起来像"字消失了"），
   * 不增删任何字符——无头回归读的是视口纯文本，断言不会随相位抖动。
   */
  caretBlink?: boolean
  /**
   * 多行草稿（落地页 Shift+Enter 换行）：`query` 里的 `\n` 分行渲染，输入框
   * 随之长高；行数超过 `maxRows` 时以光标行为锚开垂直窗口。缺省 false =
   * 单行语义，选择器/会话树的搜索框不传，渲染与从前逐字节一致。
   */
  multiline?: boolean
  /** 多行模式最多画几行（见 {@link MULTILINE_MAX_ROWS}）。 */
  maxRows?: number
}): React.ReactNode {
  const offset = cursorOffset ?? query.length
  const borderStyle = borderless ? undefined : 'round'
  const borderColor = isFocused ? 'suggestion' : undefined
  const borderDimColor = !isFocused
  // 空输入的行内光标（第七版重做）：光标压在**占位文本的第一个字符**身上
  // （对那一个字符 inverse，opencode 式）——绝不自己占一格、绝不把文字往右
  // 挤。不再拿终端焦点（DECSET 1004 focus 事件）当开关：只要这个输入框是
  // 本屏的焦点目标，光标就常在（用户原话「光标永远不消失 哪怕焦点没了」）。
  const inlineCaret = isFocused && query === ''

  // Content width of the box in display cells. Measured from yoga after
  // layout (resize re-layouts without any prop/state change, so measure on
  // every commit — the setState is a no-op when the width is unchanged);
  // the terminal-columns estimate only covers the very first frame.
  const { columns } = useTerminalSize()
  const chrome = borderless ? 0 : 4 // 2 border cells + paddingX 2
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null)
  const contentWidth = measuredWidth ?? Math.max(8, columns - chrome - 2)

  const prefixWidth = stringWidth(`${prefix} `)
  const win = windowQuery(query, offset, contentWidth - prefixWidth)
  // 多行分支（仅落地页传 multiline）：草稿里有换行时整块换成多行行模型
  // （行数按 `maxRows` 截窗）——焦点挪到参数/入口行时也照多行画，否则框高
  // 与 `resolveLaunchpadLayout` 的行数预算会当场分家。空草稿的占位行与所有
  // 非多行使用方走原路径。
  const multi = multiline && query.includes('\n')
    ? windowMultiLine(query, offset, contentWidth - prefixWidth, maxRows, prefixWidth)
    : null

  // Park the native terminal cursor at the caret so IME preedit (pinyin)
  // renders inline at the input instead of the screen's bottom row (same
  // mechanism as PromptInput). The declaration hangs on the outer Box —
  // content stays a single Text (splitting it into flex siblings
  // reorders/drops glyphs on narrow widths), so the position is computed:
  // border (1) + paddingX (1) per edge when bordered, then the `prefix `
  // run and the windowed before-caret text, all in display cells.
  const showCaret = isFocused && isTerminalFocused
  // Clamp into the box's content area: on absurdly narrow layouts the
  // prefix alone can meet or exceed the content width, and the park must
  // never land outside the box's rect.
  const edge = borderless ? 0 : 2
  const maxColumn = edge + Math.max(0, contentWidth - 1)
  const caretColumn = Math.min(edge + prefixWidth + win.caretColumn, maxColumn)
  const declarationRef = useDeclaredCursor({
    // 多行时行号跟着光标行走（行窗口已把光标行夹在可见区间里）。
    line: (borderless ? 0 : 1) + (multi === null ? 0 : multi.caretRow),
    column: multi === null ? caretColumn : Math.min(edge + multi.caretColumn, maxColumn),
    active: showCaret,
    // 落地页把本框嵌在外层圆角卡片里（padding 1 + border 1）。裁切必须从边框
    // 外侧开始，否则输入法合成带会把页边距刷成终端默认底，光标条停在框外。
    imeProtectColumns: borderless ? 2 : 0,
  })
  const boxNodeRef = useRef<DOMElement | null>(null)
  const boxRef = useCallback(
    (node: DOMElement | null) => {
      boxNodeRef.current = node
      declarationRef(node)
    },
    [declarationRef],
  )
  useLayoutEffect(() => {
    const node = boxNodeRef.current
    if (!node) return
    // Layout runs before layout effects (reconciler resetAfterCommit), so a
    // zero raw width means a genuinely zero-width box — but a zero CONTENT
    // width (chrome eats the whole box) is a real, must-clamp case.
    const raw = measureElement(node).width
    if (raw > 0) {
      const w = Math.max(0, raw - chrome)
      setMeasuredWidth(prev => (prev === w ? prev : w))
    }
  })

  let content: React.ReactNode
  if (isFocused) {
    if (query) {
      // 第七版重做：光标常在（不再依赖终端焦点事件），压在当前字符身上
      // （对那一个字符 inverse；行尾时反显空格），闪烁相位只在
      // inverse ↔ 常规之间切样式——字符常在、文字不位移。
      content = (
        <>
          <Text>{win.before}</Text>
          {caretBlink ? <Text inverse>{win.at}</Text> : <Text>{win.at}</Text>}
          {win.after !== '' && <Text>{win.after}</Text>}
        </>
      )
    }
  } else {
    content = query ? <Text>{query}</Text> : <Text>{placeholder}</Text>
  }

  return (
    <Box
      ref={boxRef}
      flexShrink={0}
      flexDirection={multi === null ? 'row' : 'column'}
      borderStyle={borderStyle}
      borderColor={borderColor}
      borderDimColor={borderDimColor}
      paddingX={borderless ? 0 : 1}
      width={width}
    >
      {multi !== null ? (
        // 多行：一行一个 Text（前缀只在首行，续行按前缀宽度缩进对齐），焦点
        // 在输入框时光标压在它那一格的字符身上——与单行同一套光标契约，
        // 闪烁只切样式；焦点挪走时整块降为 dim，行数不变。
        multi.rows.map((row, index) => (
          <Text key={index} dimColor={!isFocused} wrap="truncate-end">
            {index === 0 ? `${prefix} ` : ' '.repeat(prefixWidth)}
            {row.before}
            {row.isCaret && isFocused
              ? (caretBlink ? <Text inverse>{row.at}</Text> : <Text>{row.at}</Text>)
              : row.at}
            {row.after}
          </Text>
        ))
      ) : inlineCaret ? (
        placeholderAlign === 'left' ? (
          <Box flexDirection="row" width="100%">
            <Text>{prefix} </Text>
            {/* 光标压在占位**第一个字符**身上（opencode 式）：对那一个字符
                inverse，整行不多占一格、文字位置不动；闪烁只切样式。 */}
            <Text dimColor wrap="truncate">
              {caretBlink
                ? <Text inverse>{placeholder.slice(0, 1)}</Text>
                : placeholder.slice(0, 1)}
              {placeholder.slice(1)}
            </Text>
          </Box>
        ) : (
          <Box flexDirection="row" width="100%">
            <Text>{prefix} </Text>
            {/* 右对齐变体（非落地页使用方）：占位钉在右缘，行首没有可压的
                字符——光标画在光标位那一格（反显空格），同样不挤任何文字。 */}
            {caretBlink ? <Text inverse> </Text> : <Text> </Text>}
            <Box flexGrow={1} />
            <Text dimColor wrap="truncate">
              {placeholder}
            </Text>
          </Box>
        )
      ) : (
        <Text dimColor={!isFocused} wrap="truncate-end">
          {prefix} {content}
        </Text>
      )}
    </Box>
  )
}

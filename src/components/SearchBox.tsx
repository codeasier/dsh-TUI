import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useSurfaceEdges } from './SurfaceEdges.js'
import Box from './design-system/ThemedBox.js'
import Text from './design-system/ThemedText.js'
import { useTheme } from './design-system/ThemeProvider.js'
import { cursorGlyphColor, getTheme } from '../theme.js'
import type { Color } from '../ink/styles.js'
import type { DOMElement } from '../ink/dom.js'
import measureElement from '../ink/measure-element.js'
import { useDeclaredCursor, useNativeCursor } from '../ink/hooks/use-declared-cursor.js'
import { useTerminalSize } from '../ink/hooks/use-terminal-size.js'
import { stringWidth } from '../ink/stringWidth.js'
import { snapOffImageToken, type ImageTokenSpan } from './composerImageTokens.js'
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
  imageSpans: readonly ImageTokenSpan[] = [],
): { before: string; at: string; after: string; caretColumn: number; start: number; caret: number } {
  const budget = Math.max(avail, 1)
  let caret = snapOffImageToken(imageSpans, Math.max(0, Math.min(offset, query.length)), 'nearest')
  // Capability-backed image tokens are atomic, just like grapheme clusters.
  const clusters: Array<{ text: string; start: number }> = []
  for (const { segment, index } of getGraphemeSegmenter().segment(query)) {
    const token = imageSpans.find(span => index >= span.start && index < span.end)
    if (token !== undefined && index !== token.start) continue
    clusters.push({ text: token?.token ?? segment, start: index })
  }
  let caretIndex = clusters.findIndex(cluster => cluster.start + cluster.text.length > caret)
  if (caretIndex < 0) caretIndex = clusters.length
  caret = clusters[caretIndex]?.start ?? query.length
  const at = clusters[caretIndex]?.text ?? ' '
  const atWidth = Math.max(1, stringWidth(at))
  let startIndex = caretIndex
  let caretColumn = 0
  while (startIndex > 0) {
    const width = stringWidth(clusters[startIndex - 1]!.text)
    if (caretColumn + width + atWidth + IME_PREEDIT_RESERVE > budget) break
    caretColumn += width
    startIndex--
  }
  const start = clusters[startIndex]?.start ?? caret
  let rest = budget - caretColumn - atWidth
  let after = ''
  for (const cluster of clusters.slice(caretIndex + 1)) {
    const width = stringWidth(cluster.text)
    if (width > rest) break
    after += cluster.text
    rest -= width
  }
  return { before: query.slice(start, caret), at, after, caretColumn, start, caret }
}

/**
 * 多行草稿最多画几行（落地页 Shift+Enter 换行）：超过就以光标行为锚开垂直
 * 窗口，绝不把输入框撑到屏外。落地页把它同时喂给 `resolveLaunchpadLayout`，
 * 立绘/键帽行该让位时先让位。
 */
export const MULTILINE_MAX_ROWS = 6

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
  imageSpans: readonly ImageTokenSpan[],
): {
  rows: Array<{ before: string; at: string; after: string; isCaret: boolean; start: number; caret: number; image: boolean }>
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
  let rowStart = lines.slice(0, windowStart).reduce((sum, line) => sum + line.length + 1, 0)
  const rows = visible.map((line, index) => {
    const isCaret = windowStart + index === caretLine
    const base = rowStart
    rowStart += line.length + 1
    const spans = imageSpans.filter(span => span.start >= base && span.end <= base + line.length)
      .map(span => ({ ...span, start: span.start - base, end: span.end - base }))
    const win = windowQuery(line, isCaret ? caretCol : 0, budget, spans)
    if (isCaret) caretColumn = indent + win.caretColumn
    return { before: win.before, at: win.at, after: win.after, isCaret,
      start: base + win.start, caret: base + win.caret,
      image: spans.some(span => span.start === win.caret) }
  })
  return { rows, caretRow: caretLine - windowStart, caretColumn }
}

/**
 * A single-line search input in a round-bordered box: `⌕ ` prefix and a native
 * cursor at `cursorOffset`. Static snapshots retain the theme-painted caret.
 * When empty with a left-aligned placeholder, the caret sits on its first
 * character; text stays in place and IME preedit uses the same native anchor.
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
  declareCursor = true,
  placeholderAlign = 'right',
  imageSpans = [],
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
  /** Capability-backed image chips, sharing the chat composer's atomic geometry. */
  imageSpans?: readonly ImageTokenSpan[]
  /**
   * 空输入 + 焦点态那一行里占位文案的对齐（2026-10 落地页第四版新增）：
   * `right`（缺省，历史行为）贴框右缘；`left` 紧跟前缀。
   * 共享组件——聊天页/选择器不传此 prop，渲染与从前逐字节一致。
   */
  placeholderAlign?: 'left' | 'right'
  /**
   * 无原生光标的呈现环境使用的闪烁相位（仅切换样式，不增删字符）。
   * TTY 光标的闪烁与动画由终端配置控制。
   */
  caretBlink?: boolean
  /** Keep the live field styled while another region owns the native caret. */
  declareCursor?: boolean
  /**
   * 多行草稿（落地页 Shift+Enter 换行）：`query` 里的 `\n` 分行渲染，输入框
   * 随之长高；行数超过 `maxRows` 时以光标行为锚开垂直窗口。缺省 false =
   * 单行语义，选择器/会话树的搜索框不传，渲染与从前逐字节一致。
   */
  multiline?: boolean
  /** 多行模式最多画几行（见 {@link MULTILINE_MAX_ROWS}）。 */
  maxRows?: number
}): React.ReactNode {
  const [themeName] = useTheme()
  const surfaceEdges = useSurfaceEdges()
  const nativeCursor = useNativeCursor()
  const cursorTheme = getTheme(themeName)
  const cursorColor = cursorTheme.cursor ?? ''
  const cursorGlyph = cursorGlyphColor(cursorTheme)
  const caretCell = (text: string, image = false): React.ReactNode => !image && (nativeCursor || !caretBlink)
    ? <Text>{text}</Text>
    : cursorColor === ''
      ? <Text inverse>{text}</Text>
      : <Text backgroundColor={cursorColor as Color} color={cursorGlyph}>{text}</Text>
  const offset = cursorOffset ?? query.length
  const borderStyle = borderless ? undefined : 'round'
  const borderColor = isFocused ? 'suggestion' : undefined
  const borderDimColor = !isFocused
  // Empty left-aligned inputs park on the placeholder's first character;
  // the terminal owns the cursor's appearance when its window loses focus.
  const inlineCaret = isFocused && query === ''

  // Content width of the box in display cells. Measured from yoga after
  // layout (resize re-layouts without any prop/state change, so measure on
  // every commit — the setState is a no-op when the width is unchanged);
  // the terminal-columns estimate only covers the very first frame.
  const { columns } = useTerminalSize()
  const chrome = borderless ? 0 : 4 // 2 border cells + paddingX 2
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null)
  const contentWidth = measuredWidth ?? Math.max(8, columns - chrome - 2)

  const prefixText = prefix === '' ? '' : `${prefix} `
  const prefixWidth = stringWidth(prefixText)
  const win = windowQuery(query, offset, contentWidth - prefixWidth, imageSpans)
  const renderQueryPart = (text: string, start: number): React.ReactNode => {
    if (imageSpans.length === 0) return <Text>{text}</Text>
    const pieces: React.ReactNode[] = []
    let pos = start
    for (const span of imageSpans) {
      if (span.start < start || span.end > start + text.length) continue
      if (pos < span.start) pieces.push(<Text key={`text-${pos}`}>{query.slice(pos, span.start)}</Text>)
      pieces.push(<Text key={`image-${span.start}`} color="suggestion">{span.token}</Text>)
      pos = span.end
    }
    if (pos < start + text.length) pieces.push(<Text key={`text-${pos}`}>{query.slice(pos, start + text.length)}</Text>)
    return pieces.length === 0 ? <Text>{text}</Text> : <>{pieces}</>
  }
  // 多行分支（仅落地页传 multiline）：草稿里有换行时整块换成多行行模型
  // （行数按 `maxRows` 截窗）——焦点挪到参数/入口行时也照多行画，否则框高
  // 与 `resolveLaunchpadLayout` 的行数预算会当场分家。空草稿的占位行与所有
  // 非多行使用方走原路径。
  const multi = multiline && query.includes('\n')
    ? windowMultiLine(query, offset, contentWidth - prefixWidth, maxRows, prefixWidth, imageSpans)
    : null

  // Park the native terminal cursor at the caret so IME preedit (pinyin)
  // renders inline at the input instead of the screen's bottom row (same
  // mechanism as PromptInput). The declaration hangs on the outer Box —
  // content stays a single Text (splitting it into flex siblings
  // reorders/drops glyphs on narrow widths), so the position is computed:
  // border (1) + paddingX (1) per edge when bordered, then the `prefix `
  // run and the windowed before-caret text, all in display cells.
  const showCaret = isFocused && (nativeCursor || isTerminalFocused)
  // Clamp into the box's content area: on absurdly narrow layouts the
  // prefix alone can meet or exceed the content width, and the park must
  // never land outside the box's rect.
  const edge = borderless ? 0 : 2
  const maxColumn = edge + Math.max(0, contentWidth - 1)
  const caretColumn = Math.min(edge + prefixWidth + win.caretColumn, maxColumn)
  const declarationRef = useDeclaredCursor({
    active: showCaret && declareCursor,
    visible: nativeCursor,
    // 多行时行号跟着光标行走（行窗口已把光标行夹在可见区间里）。
    line: (borderless ? 0 : 1) + (multi === null ? 0 : multi.caretRow),
    column: multi === null ? caretColumn : Math.min(edge + multi.caretColumn, maxColumn),
    // 落地页把本框嵌在外层圆角卡片里（padding 1 + border 1）。裁切必须从边框
    // 外侧开始，否则输入法合成带会把页边距刷成终端默认底，光标条停在框外。
    // A split-column search must never erase its neighbouring panel.
    imeProtectColumns: surfaceEdges.right > 0 ? (borderless ? 2 : 0) : undefined,
  })
  const boxNodeRef = useRef<DOMElement | null>(null)
  const boxRef = useCallback(
    (node: DOMElement | null) => {
      boxNodeRef.current = node
      const cleanup = declarationRef(node)
      if (node === null) return
      return () => {
        if (typeof cleanup === 'function') cleanup()
        if (boxNodeRef.current === node) boxNodeRef.current = null
      }
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
      // Keep the visible text intact; only the painted fallback changes
      // the caret glyph's style as its blink phase advances.
      content = (
        <>
          {renderQueryPart(win.before, win.start)}
          {caretCell(win.at, imageSpans.some(span => span.start === win.caret))}
          {win.after !== '' && renderQueryPart(win.after, win.caret + win.at.length)}
        </>
      )
    }
  } else {
    content = query ? renderQueryPart(query, 0) : <Text>{placeholder}</Text>
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
            {renderQueryPart(row.before, row.start)}
            {row.isCaret && isFocused
              ? caretCell(row.at, row.image)
              : renderQueryPart(row.at, row.caret)}
            {renderQueryPart(row.after, row.caret + row.at.length)}
          </Text>
        ))
      ) : inlineCaret ? (
        placeholderAlign === 'left' ? (
          <Box flexDirection="row" width="100%">
            <Text>{prefixText}</Text>
            {/* An empty placeholder still reserves a blank caret cell
                so the input row cannot collapse. */}
            <Text dimColor wrap="truncate">
              {caretCell(placeholder.slice(0, 1) || ' ')}
              {placeholder.slice(1)}
            </Text>
          </Box>
        ) : (
          <Box flexDirection="row" width="100%">
            <Text>{prefixText}</Text>
            {/* A right-aligned placeholder leaves a blank caret cell at
                the input origin. */}
            {caretCell(' ')}
            <Box flexGrow={1} />
            <Text dimColor wrap="truncate">
              {placeholder}
            </Text>
          </Box>
        )
      ) : (
        <Text dimColor={!isFocused} wrap="truncate-end">
          {prefixText}{content}
        </Text>
      )}
    </Box>
  )
}

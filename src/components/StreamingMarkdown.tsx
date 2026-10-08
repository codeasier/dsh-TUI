import React from 'react'
import { marked, type Token } from 'marked'
import Box from '../ink/components/Box.js'
import { configureMarked, formatToken, isBlankMarkdownToken, markdownBlockGap, stripPromptXMLTags } from '../terminal-utils/markdown.js'
import { t } from '../i18n.js'
import { isMathBlockToken, mayBecomeCodeSpan } from '../terminal-utils/math.js'
import { isStandaloneToken, Markdown } from './Markdown.js'

/**
 * Renders streaming markdown in sealed groups of completed top-level blocks.
 * Only the unsealed group and growing final block change as text arrives.
 * marked.lexer() keeps unclosed fences inside one token, and the boundary
 * analysis below preserves the whole-document formatter's row spacing.
 */
/**
 * Tail budget for the unstable suffix during streaming. The sticky view only
 * ever shows the last viewport of rows, but the suffix Text is re-wrapped
 * every frame — an unbounded suffix (a single huge paragraph with no block
 * boundary to advance the prefix) made that O(total) per frame. The suffix
 * is clipped to this many characters (preferring a paragraph boundary),
 * with a leading marker naming the dropped amount; settling renders the
 * full text once through the non-streaming path.
 *
 * The cut point is STICKY (advances only when the suffix outgrows budget +
 * step): a cut that slid every frame would break append-only growth, and
 * the layout layer's incremental wrap would fall back to a full re-wrap of
 * the whole tail on every token.
 */
const SUFFIX_TAIL_BUDGET = 3584
const SUFFIX_BOUNDARY_LOOKBACK = 2048
const SUFFIX_CUT_STEP = 1024
const STABLE_BLOCK_BUDGET = 8192

function clipSuffixTail(suffix: string, cut: { current: number }): string {
  const total = suffix.length
  if (total <= SUFFIX_TAIL_BUDGET) {
    cut.current = 0
    return suffix
  }
  // Advance the sticky cut only once the suffix outgrew the budget by a
  // full step, preferring a paragraph boundary inside the lookback window.
  if (total - cut.current > SUFFIX_TAIL_BUDGET + SUFFIX_CUT_STEP) {
    const windowStart = total - SUFFIX_TAIL_BUDGET
    const boundary = suffix.lastIndexOf('\n\n', windowStart + SUFFIX_BOUNDARY_LOOKBACK)
    cut.current = boundary !== -1 && boundary >= windowStart - SUFFIX_BOUNDARY_LOOKBACK
      ? boundary + 2
      : windowStart
  }
  const dropped = cut.current
  return `${t('streaming-folded', { count: dropped })}\n\n${suffix.slice(cut.current)}`
}

type StableBoundary = {
  /** False when the candidate prefix has no visible block to seal. */
  safe: boolean
  type: string | undefined
  separated: boolean
}

const UNSAFE_BOUNDARY: StableBoundary = {
  safe: false,
  type: undefined,
  separated: false,
}

/**
 * Only the last visible stable block and source separation matter. Inspect
 * backwards so sealing a prefix never reformats all its historical blocks.
 * Whitespace around standalone nodes is not another layout node.
 */
function analyzeStableBoundary(tokens: readonly Token[], suffixIndex: number): StableBoundary {
  let separated = false
  for (let i = suffixIndex - 1; i >= 0; i--) {
    const token = tokens[i]!
    if (isBlankMarkdownToken(token.type)) {
      separated ||= token.type === 'space' || token.type === 'br' || /\n\n$/.test(token.raw)
      continue
    }
    if (isStandaloneToken(token) || formatToken(token).trim() !== '') {
      return { safe: true, type: token.type, separated: separated || /\n\n$/.test(token.raw) }
    }
  }
  return UNSAFE_BOUNDARY
}

type SuffixStart = {
  type: string | undefined
  separated: boolean
}

/** Find the first visible suffix node without formatting the growing token.
 * Whitespace around invisible definitions/HTML is internal in a whole render
 * but gets trimmed at the start of the split suffix, so count it into the
 * boundary gap explicitly. */
function analyzeSuffixStart(tokens: readonly Token[], startIndex: number): SuffixStart {
  let separated = false
  for (let i = startIndex; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === undefined) break
    if (isBlankMarkdownToken(token.type)) {
      separated ||= token.type === 'space' || token.type === 'br' || /\n\n$/.test(token.raw)
      continue
    }
    return { type: token.type, separated }
  }
  return { type: undefined, separated }
}

function gapBetween(boundary: StableBoundary, start: SuffixStart): number {
  return markdownBlockGap(boundary.type, start.type, boundary.separated || start.separated)
}

type StableBlocks = {
  blocks: Array<{ text: string; gap: number }>
  end: number
  tokens: Token[]
  tail: string
  tailGap: number
  boundary: StableBoundary | undefined
  definitions: boolean
}

export function StreamingMarkdown({
  children,
  dimColor = false,
}: {
  children: string
  dimColor?: boolean
}): React.ReactNode {
  // The prefix tracks source offsets; its rendered blocks are sealed once
  // so an advancing boundary never reparses the entire accumulated answer.
  const prefixRef = React.useRef('')
  const blocksRef = React.useRef<StableBlocks>({
    blocks: [], end: 0, tokens: [], tail: '', tailGap: 0,
    boundary: undefined, definitions: false,
  })
  const cutRef = React.useRef(0)
  const prefixBoundaryRef = React.useRef(UNSAFE_BOUNDARY)

  // The boundary lex below must see the same tokenizer extensions (math
  // blocks) as the Markdown children, or the two disagree on block edges.
  configureMarked()
  const stripped = stripPromptXMLTags(children)

  // Reset if text was replaced (defensive; normally unmount handles this)
  if (!stripped.startsWith(prefixRef.current)) {
    prefixRef.current = ''
    cutRef.current = 0
    prefixBoundaryRef.current = UNSAFE_BOUNDARY
    blocksRef.current = {
      blocks: [], end: 0, tokens: [], tail: '', tailGap: 0,
      boundary: undefined, definitions: false,
    }
  }

  // Lex only from current boundary — O(unstable length), not O(full text)
  const boundary = prefixRef.current.length
  const tokens = marked.lexer(stripped.substring(boundary))
  const blocks = blocksRef.current
  // Reference definitions have document-wide scope, including references
  // in the growing suffix. These documents cannot use independent parsers.
  if (!blocks.definitions && Object.keys(tokens.links).length > 0) {
    blocks.definitions = true
    blocks.blocks = []
    blocks.tokens = []
    blocks.end = 0
    blocks.boundary = undefined
  }

  // Last non-space token is the growing block; everything before is final
  let lastContentIdx = tokens.length - 1
  while (lastContentIdx >= 0 && tokens[lastContentIdx].type === 'space') {
    lastContentIdx--
  }
  // A block formula after a paragraph with an open backtick run is
  // provisional until a blank line: the run's closer may still arrive and
  // turn both into one code span, so the paragraph stays unsealed.
  let consumed = 0
  for (let i = 0; i < lastContentIdx; i++) {
    const token = tokens[i]!
    if (
      token.type === 'paragraph' && isMathBlockToken(tokens[i + 1]) &&
      mayBecomeCodeSpan(token.raw, stripped.substring(boundary + consumed + token.raw.length))
    ) {
      lastContentIdx = i
      break
    }
    consumed += token.raw.length
  }
  let advance = 0
  for (let i = 0; i < lastContentIdx; i++) {
    advance += tokens[i].raw.length
  }
  let suffixTokenIndex = 0
  if (advance > 0) {
    const stableBoundary = analyzeStableBoundary(tokens, lastContentIdx)
    if (stableBoundary.safe) {
      if (!blocks.definitions) {
        let end = boundary
        for (let index = 0; index < lastContentIdx; index++) {
          const token = tokens[index]!
          blocks.tokens.push(token)
          end += token.raw.length
          if (end - blocks.end < STABLE_BLOCK_BUDGET) continue
          const blockBoundary = analyzeStableBoundary(blocks.tokens, blocks.tokens.length)
          if (!blockBoundary.safe) continue
          const gap = blocks.boundary === undefined ? 0 : gapBetween(blocks.boundary, analyzeSuffixStart(blocks.tokens, 0))
          // Detach the sealed slice from the growing source buffer, preserving
          // UTF-16 code units rather than pinning every historical full reply.
          const text = Buffer.from(stripped.substring(blocks.end, end), 'utf16le').toString('utf16le')
          blocks.blocks.push({ text, gap })
          blocks.end = end
          blocks.boundary = blockBoundary
          blocks.tokens = []
        }
        blocks.tail = stripped.substring(blocks.end, boundary + advance)
        blocks.tailGap = blocks.boundary === undefined ? 0 : gapBetween(blocks.boundary, analyzeSuffixStart(blocks.tokens, 0))
      }
      prefixRef.current = stripped.substring(0, boundary + advance)
      prefixBoundaryRef.current = stableBoundary
      suffixTokenIndex = lastContentIdx
    }
  }

  if (blocks.definitions) {
    return <Markdown dimColor={dimColor} inlineMathImages={false} cacheTokens={false}>{stripped}</Markdown>
  }

  const stablePrefix = prefixRef.current
  const prefixTail = blocks.tail
  const suffixSource = stripped.substring(stablePrefix.length)
  const unstableSuffix = clipSuffixTail(suffixSource, cutRef)
  const suffixStart = cutRef.current > 0
    ? { type: 'paragraph', separated: false }
    : analyzeSuffixStart(tokens, suffixTokenIndex)
  const boundaryGap = gapBetween(prefixBoundaryRef.current, suffixStart)

  // A lexer boundary must be strictly outside the stable prefix. If marked
  // reports a raw span that ends at the current cursor (possible around an
  // unfinished fence/table while deltas arrive), rendering both branches can
  // paint the same tail twice. Keep the suffix authoritative and never render
  // an overlapping empty/duplicate boundary.
  const hasDistinctSuffix = unstableSuffix !== '' &&
    (stablePrefix === '' || !unstableSuffix.startsWith(stablePrefix))

  return (
    <Box flexDirection="column">
      {blocks.blocks.map((block, index) => (
        <Box key={index} flexDirection="column" marginTop={block.gap}>
          <Markdown dimColor={dimColor} inlineMathImages={false}>{block.text}</Markdown>
        </Box>
      ))}
      {prefixTail && (
        <Box key="prefix" flexDirection="column" marginTop={blocks.tailGap}>
          <Markdown dimColor={dimColor} inlineMathImages={false}>{prefixTail}</Markdown>
        </Box>
      )}
      {hasDistinctSuffix && (
        <Box key="suffix" flexDirection="column" marginTop={boundaryGap}>
          <Markdown dimColor={dimColor} inlineMathImages={false} cacheTokens={false}>{unstableSuffix}</Markdown>
        </Box>
      )}
    </Box>
  )
}

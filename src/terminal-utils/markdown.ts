/**
 * Markdown-to-ANSI renderer over marked's token stream.
 *
 * Converts the shared marked lexer output into styled terminal text: quote
 * gutters, syntax-highlighted fenced blocks, indented list bullets with
 * depth-based numbering, and alignment-padded tables. The visual conventions
 * (▎ bars for blockquotes, theme-colored inline code, OSC 8 hyperlinks) are
 * standard terminal markdown idioms, but this is an independent
 * implementation: a single dispatch switch fans tokens out to dedicated
 * per-type render functions, and all recursive calls thread one immutable
 * RenderState (parent token, list depth, list ordinal, highlighter) instead
 * of passing positional arguments.
 */

import chalk from 'chalk'
import { marked, type MarkedToken, type Token, type Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import { stringWidth } from '../ink/stringWidth.js'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'
import { colorize } from '../ink/colorize.js'
import { getActiveTheme, type Theme } from '../theme.js'
import { buildSyntaxTheme } from './syntaxTheme.js'
import type { CliHighlight } from './cliHighlight.js'
import { logForDebugging } from '../utils/debug.js'
import { createHyperlink } from './hyperlink.js'
import { fileLinkUrl, linkifyFilePaths, looksLikeFilePath } from '../utils/fileTarget.js'
import { getMathRendering } from '../tuiDisplayPrefs.js'
import { noteCodeHighlight, noteFormatToken } from '../ink/render-stats.js'
import {
  isMathBlockToken,
  isMathToken,
  MATH_MARKDOWN_EXTENSIONS,
  renderInlineMath,
  type MathToken,
} from './math.js'

// '\n' is used unconditionally — os.EOL is '\r\n' on Windows, and the stray
// '\r' breaks the character-to-segment mapping in applyStylesToWrappedText,
// shifting styled text to the right.
const EOL = '\n'

/** Left one-quarter block (U+258E), the blockquote gutter marker. */
const QUOTE_BAR = '\u258e'

/** Left one-eighth block (U+258F): quote levels past the second get the thinner bar. */
const QUOTE_BAR_DEEP = '\u258f'

/** The horizontal-rule divider: sixteen light box-drawing dashes. */
const HR_DIVIDER = '\u2500'.repeat(16)

/** Tool-analysis tag blocks that carry no user-facing content; dropped before lexing. */
const TOOL_ANALYSIS_TAG_BLOCKS =
  /<(commit_analysis|context|function_analysis|pr_analysis)>.*?<\/\1>\n?/gs

/**
 * Matches `owner/repo#NNN` style GitHub issue/PR references. Only the
 * qualified form is recognized: a bare `#NNN` would guess the current
 * repository and be wrong whenever the assistant discusses a different one.
 * The owner segment excludes dots (GitHub usernames are alphanumerics plus
 * hyphens) so hostnames like docs.example.io/guide#42 don't false-positive;
 * the repo segment allows dots (e.g. cc.kurs.web). Lookbehind is avoided —
 * it defeats YARR JIT in JSC.
 */
const ISSUE_REFERENCE_PATTERN =
  /(^|[^\w./-])([A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w.-]*)#(\d+)\b/g

/**
 * Strip tool-analysis XML blocks (`<commit_analysis>`, `<context>`,
 * `<function_analysis>`, `<pr_analysis>`) and their contents, then trim.
 * @param content - Markdown that may wrap the tool-analysis tag blocks.
 * @returns The content with those blocks removed and whitespace trimmed.
 */
export function stripPromptXMLTags(content: string): string {
  // Every alternative in the pattern is anchored on a literal '<', so content
  // without one cannot match. Skip the regex entirely in that case: the
  // backreference defeats most of the engine's fast paths, and streaming
  // re-runs this over the whole accumulated message on every frame.
  if (!content.includes('<')) return content.trim()
  return content.replace(TOOL_ANALYSIS_TAG_BLOCKS, '').trim()
}

let markedInitialized = false

/**
 * Configure the shared `marked` instance once. Strikethrough reaches
 * marked's built-in del tokenizer only for double-tilde pairs; the fork's
 * tokenizer guard keeps single tildes (`~100`, models' "approximate")
 * literal even when they pair up. LaTeX math becomes `math`/`mathBlock`
 * tokens (see math.ts). Every lexer caller — Markdown and
 * StreamingMarkdown's boundary
 * lex — must run this first so both agree on block boundaries.
 */
export function configureMarked(): void {
  if (markedInitialized) return
  markedInitialized = true

  marked.use({
    tokenizer: {
      del(src) {
        return src.startsWith('~~') ? false : undefined
      },
    },
    extensions: [...MATH_MARKDOWN_EXTENSIONS],
  })
}

/** Inline code uses its own semantic slot, not the UI focus accent. */
function paintInlineCode(text: string, state: RenderState): string {
  return colorize(text, renderTheme(state).markdownCode, 'foreground')
}

/**
 * Inline code that reads as a file path becomes a clickable target (the
 * OSC 8 wrap keeps the code's semantic color via the identity style —
 * createHyperlink's default blue would otherwise override it). Terminals
 * without OSC 8 support keep the plain painted code span.
 */
function renderCodeSpan(token: Tokens.Codespan, state: RenderState): string {
  // Paint via the style callback so the semantic color is applied AFTER
  // createHyperlink's anti-smuggle content scrub: passing the painted
  // string as content would have its ESC bytes stripped, leaving
  // `[38;2;…m` parameter text on screen.
  const paint = (text: string): string => paintInlineCode(text, state)
  if (!looksLikeFilePath(token.text)) return paint(token.text)
  if (!supportsHyperlinks()) return paint(token.text)
  return createHyperlink(fileLinkUrl(token.text), token.text, {
    style: paint,
  })
}

/**
 * Linkify path-like text into clickable file targets, then issue
 * references (owner/repo#123). File spans exclude `#`, so the two
 * linkifiers cannot nest or overlap. Without OSC 8 support the text stays
 * untouched (createHyperlink's URL fallback would show the raw encoded
 * `dsh-file:` payload — worse than plain text).
 */
function markdownHyperlink(url: string, label: string | undefined, state: RenderState): string {
  // Paint after the shared link helper sanitizes both OSC targets and labels.
  // This also colors the visible URL fallback on terminals without OSC 8.
  return chalk.underline(colorize(createHyperlink(url, label, { style: text => text }), renderTheme(state).markdownLink, 'foreground'))
}

function linkifyText(text: string, state: RenderState): string {
  const withFiles = supportsHyperlinks()
    ? linkifyFilePaths(text, (path, display) =>
        markdownHyperlink(fileLinkUrl(path), display, state),
      )
    : text
  return linkifyIssueReferences(withFiles, state)
}

/**
 * Immutable rendering context threaded through the token tree.
 * `listDepth` and `ordinal` only matter inside list items; `parent` decides
 * whether issue references are linkified (inside links they must stay plain
 * to avoid nested OSC 8 sequences).
 */
interface RenderState {
  /** Syntax highlighter for code blocks; null renders them as plain text. */
  readonly highlight: CliHighlight | null
  readonly palette?: Theme
  readonly layout?: Map<Token, readonly number[]>
  /** The token whose children are being rendered (link / list_item). */
  readonly parent: Token | null
  /** Nesting depth of the enclosing list; drives indentation and numbering style. */
  readonly listDepth: number
  /** Ordinal of the current ordered-list item, or null for unordered lists. */
  readonly ordinal: number | null
  /** Nesting depth of the enclosing blockquote; deeper levels get a more muted bar. */
  readonly quoteDepth: number
  /**
   * Absolute column where the enclosing list item's body block starts
   * (indent + marker + checkbox). Soft-break continuations and nested
   * blocks align there, and a nested list's items inherit it as their
   * indent so the ladder advances by one marker width per level.
   */
  readonly hang: number
}

/** A fresh context for block-level children: list state reset, no parent. */
function fresh(state: RenderState): RenderState {
  return { highlight: state.highlight, palette: state.palette, layout: state.layout, parent: null, listDepth: 0, ordinal: null, quoteDepth: 0, hang: 0 }
}

/** Same context, different parent token. */
function withParent(state: RenderState, parent: Token | null): RenderState {
  return { ...state, parent }
}

/** Inline-styled children keep the outer parent but shed list context. */
function inlineChildren(state: RenderState): RenderState {
  return { ...state, listDepth: 0, ordinal: null, quoteDepth: 0, hang: 0 }
}

function renderTheme(state: RenderState): Theme {
  return state.palette ?? getActiveTheme()
}

export interface FormattedMarkdown {
  readonly text: string
  /** Content column of each source logical line; zero means ordinary wrap. */
  readonly continuationIndent: readonly number[]
}

/** Whitespace and intentionally invisible top-level tokens do not make nodes. */
export function isBlankMarkdownToken(type: string): boolean {
  return type === 'space' || type === 'br' || type === 'def' || type === 'html'
}

/** Shared settled/streaming policy: structure gets one blank row; adjacent
 * paragraphs get one only when the source separated them. No outer padding. */
export function markdownBlockGap(previous: string | undefined, next: string | undefined, separated: boolean): number {
  if (previous === undefined || next === undefined) return 0
  return previous === 'paragraph' && next === 'paragraph' ? Number(separated) : 1
}

export function markdownBlocks(tokens: readonly Token[]): Array<{ token: Token; gap: number }> {
  const blocks: Array<{ token: Token; gap: number }> = []
  let previous: Token | undefined
  let separated = false
  for (const token of tokens) {
    if (isBlankMarkdownToken(token.type)) {
      separated ||= token.type === 'space' || token.type === 'br' || /\n\n$/.test(token.raw)
      continue
    }
    blocks.push({ token, gap: markdownBlockGap(previous?.type, token.type, separated || /\n\n$/.test(previous?.raw ?? '')) })
    previous = token
    separated = false
  }
  return blocks
}

/** Top-level blocks end in exactly one LF; inter-block blank rows belong to
 * markdownBlockGap. Nested list/quote formatting retains its own whitespace. */
export function formatMarkdownBlockWithLayout(token: Token, highlight: CliHighlight | null = null, palette: Theme = getActiveTheme()): FormattedMarkdown {
  const part = formatTokenWithLayout(token, highlight, palette)
  const body = part.text.replace(/\n+$/, '')
  return body === '' ? { text: '', continuationIndent: [0] } : {
    text: body + EOL,
    continuationIndent: [...part.continuationIndent.slice(0, body.split(EOL).length), 0],
  }
}

export function joinFormattedMarkdown(parts: readonly FormattedMarkdown[]): FormattedMarkdown {
  let text = ''
  const continuationIndent = [0]
  let tailWidth = 0
  for (const part of parts) {
    const last = continuationIndent.length - 1
    const first = part.continuationIndent[0] ?? 0
    if (first > 0) continuationIndent[last] = tailWidth + first
    for (const indent of part.continuationIndent.slice(1)) continuationIndent.push(indent)
    const newline = part.text.lastIndexOf(EOL)
    tailWidth = newline >= 0
      ? stringWidth(stripAnsi(part.text.slice(newline + 1)))
      : tailWidth + stringWidth(stripAnsi(part.text))
    text += part.text
  }
  return { text, continuationIndent }
}

export function trimFormattedMarkdown(part: FormattedMarkdown, start: boolean, end: boolean): FormattedMarkdown {
  const text = end ? (start ? part.text.trim() : part.text.trimEnd()) : (start ? part.text.trimStart() : part.text)
  const removedStart = start ? part.text.slice(0, part.text.length - part.text.trimStart().length) : ''
  const skippedLines = removedStart.split(EOL).length - 1
  const continuationIndent = part.continuationIndent.slice(skippedLines, skippedLines + text.split(EOL).length)
  if (continuationIndent.length > 0) {
    continuationIndent[0] = Math.max(0, (continuationIndent[0] ?? 0) - stringWidth(removedStart.slice(removedStart.lastIndexOf(EOL) + 1)))
  }
  return { text, continuationIndent }
}

export function formatTokenWithLayout(token: Token, highlight: CliHighlight | null = null, palette: Theme = getActiveTheme()): FormattedMarkdown {
  const layout = new Map<Token, readonly number[]>()
  const text = dispatch(token, { highlight, palette, layout, parent: null, listDepth: 0, ordinal: null, quoteDepth: 0, hang: 0 })
  return { text, continuationIndent: layout.get(token) ?? [0] }
}

function formattedChild(token: Token, state: RenderState): FormattedMarkdown {
  const text = dispatch(token, state)
  return { text, continuationIndent: state.layout?.get(token) ?? text.split(EOL).map(() => 0) }
}

/**
 * Render one marked token to ANSI text, recursing into child tokens.
 * @param token - The marked token to render.
 * @param listDepth - Nesting depth of the enclosing list; drives indentation and numbering style.
 * @param orderedListNumber - Current ordinal of the enclosing ordered list item, or null for unordered lists.
 * @param parent - The parent token; linkification is skipped inside links and prefixes are added inside list items.
 * @param highlight - Optional cli-highlight surface for code blocks; null disables syntax highlighting.
 * @returns The rendered ANSI string for the token, or '' for unrendered token types.
 */
export function formatToken(
  token: Token,
  listDepth = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
  highlight: CliHighlight | null = null,
): string {
  return dispatch(token, {
    highlight,
    parent,
    listDepth,
    ordinal: orderedListNumber,
    quoteDepth: 0,
    hang: 0,
  })
}

/**
 * Render markdown content to ANSI-styled text via the shared `marked` instance.
 * @param content - Markdown source to render.
 * @param highlight - Optional cli-highlight surface for code blocks; null disables syntax highlighting.
 * @returns The rendered ANSI string, trimmed.
 */
export function applyMarkdown(
  content: string,
  highlight: CliHighlight | null = null,
): string {
  configureMarked()
  return markdownBlocks(marked.lexer(stripPromptXMLTags(content)))
    .map(({ token, gap }) => EOL.repeat(gap) + formatMarkdownBlockWithLayout(token, highlight).text)
    .join('')
    // trimEnd only: the input is already trimmed, so leading whitespace in
    // the output is renderer-intended (e.g. the code block's 2-space indent
    // on its first line). A full trim() would eat that first-line indent.
    .trimEnd()
}

/**
 * Type guard that narrows to the concrete marked token of `kind`.
 * Plain `switch` narrowing fails here: Tokens.Generic declares `type: string`,
 * so every case keeps Generic in the union. Guarding against MarkedToken
 * (which excludes Generic) yields exact types for the per-type renderers.
 */
function isToken<K extends MarkedToken['type']>(
  token: Token,
  kind: K,
): token is Extract<MarkedToken, { type: K }> {
  return token.type === kind
}

/** Fan-out point: narrows the token union, then delegates to the per-type render functions. */
function dispatch(token: Token, state: RenderState): string {
  noteFormatToken(token.raw ?? '')
  const text = renderToken(token, state)
  if (state.layout && !state.layout.has(token)) state.layout.set(token, text.split(EOL).map(() => 0))
  return text
}

function renderToken(token: Token, state: RenderState): string {
  if (isToken(token, 'blockquote')) return renderBlockquote(token, state)
  if (isToken(token, 'checkbox')) return renderCheckbox(token, state)
  if (isToken(token, 'code')) return renderCodeBlock(token, state)
  if (isToken(token, 'codespan')) return renderCodeSpan(token, state)
  if (isToken(token, 'em')) return renderEmphasis(token, state)
  if (isToken(token, 'strong')) return renderStrong(token, state)
  if (isToken(token, 'del')) return renderDel(token, state)
  if (isToken(token, 'heading')) return renderHeading(token, state)
  if (isToken(token, 'hr')) return renderHr(state)
  if (isToken(token, 'image')) return renderImage(token, state)
  if (isToken(token, 'link')) return renderLink(token, state)
  if (isToken(token, 'list')) return renderList(token, state)
  if (isToken(token, 'list_item')) return renderListItem(token, state)
  if (isToken(token, 'paragraph')) return renderParagraph(token, state)
  if (isToken(token, 'space') || isToken(token, 'br')) return EOL
  if (isToken(token, 'text')) return renderText(token, state)
  if (isToken(token, 'table')) return renderTable(token, state)
  if (isToken(token, 'escape')) return token.text
  if (isMathToken(token)) return renderInlineMathToken(token)
  // Top-level math blocks are standalone MathBlock nodes; this path only
  // sees blocks nested in list items / blockquotes (or formatToken callers).
  if (isMathBlockToken(token)) return renderNestedMathBlock(token)
  if (isToken(token, 'def') || isToken(token, 'html')) {
    // Link definitions and raw HTML carry no ANSI representation.
    return ''
  }
  // Unknown token types (a marked upgrade or extension) echo their raw
  // source instead of silently dropping it; verify-markdown-token-coverage
  // fails until the type gets a renderer or an explicit ignore.
  logForDebugging(`Markdown token without a renderer, echoing raw source: ${token.type}`)
  return (token as { raw?: string }).raw ?? ''
}

/** Inline math as single-line Unicode; the exact source when it has none
 *  or rendering is switched off. */
function renderInlineMathToken(token: MathToken): string {
  return (getMathRendering() !== 'source' ? renderInlineMath(token.text) : undefined) ?? token.raw
}

/**
 * A math block inside a list item or blockquote has no width of its own to
 * lay out a 2D formula against (and would be cut by the container prefix),
 * so it gets the single-line form, else its source.
 */
function renderNestedMathBlock(token: MathToken): string {
  const rendered = getMathRendering() !== 'source' && !token.pending ? renderInlineMath(token.text) : undefined
  return (rendered ?? token.raw.trim()) + EOL
}

/**
 * The gutter for one blockquote level: the first level in the theme's
 * muted color, the second dimmed, deeper levels the thinner one-eighth
 * bar, so nesting fades instead of repeating identical rails.
 */
function quoteGutter(depth: number): string {
  if (depth === 0) return colorize(QUOTE_BAR, getActiveTheme().subtle, 'foreground')
  if (depth === 1) return chalk.dim(QUOTE_BAR)
  return chalk.dim(QUOTE_BAR_DEEP)
}

function renderBlockquote(token: Tokens.Blockquote, state: RenderState): string {
  const depth = state.quoteDepth
  // Children keep the quote context (a nested blockquote increments the
  // depth) but shed list state, exactly like fresh().
  const childState = { ...fresh(state), quoteDepth: depth + 1 }
  const formatted = joinFormattedMarkdown(token.tokens.map(child => formattedChild(child, childState)))
  const inner = formatted.text
  const innerLines = inner.split(EOL)
  state.layout?.set(token, formatted.continuationIndent.map((indent, i) => {
    const plain = stripAnsi(innerLines[i] ?? '')
    if (!plain.trim()) return 0
    return 2 + (indent > 0 ? indent : plain.match(/^ */)?.[0].length ?? 0)
  }))
  // Gutter bar per line; keep the text italic but at normal brightness —
  // chalk.dim is nearly invisible on dark themes. Blank lines inside the
  // quote keep a bare gutter so the quote stays visible across paragraph
  // gaps; only the empty piece after inner's final newline stays empty.
  const gutter = quoteGutter(depth)
  // An empty quote (`>` on its own line) still shows one rail.
  if (innerLines.every(line => line === '')) return gutter + EOL
  return innerLines
    .map((line, index) => {
      if (line === '' || stripAnsi(line).trim() === '') {
        return index === innerLines.length - 1 ? line : gutter
      }
      return `${gutter} ${chalk.italic(colorize(line, renderTheme(state).markdownBlockQuote, 'foreground'))}`
    })
    .join(EOL)
}

function renderCodeBlock(token: Tokens.Code, state: RenderState): string {
  // Tagged blocks use the original fence info as a muted caption. Untagged
  // blocks keep a fence cue; neither needs a closing fence or another node.
  // This ANSI form serves nested code (inside lists/quotes) and the narrow
  // fallback of CodeBlockFrame; top-level fences render through the frame
  // component sharing formatCodeBody below.
  const theme = renderTheme(state)
  const caption = colorize(token.lang?.trim() ? token.lang : '```', theme.subtle, 'foreground')
  const indent = '  '
  const body = formatCodeBody(token, state.highlight)
  if (body === '') {
    return `${caption}${EOL}`
  }
  return (
    caption +
    EOL +
    body
      .split(EOL)
      .map(line => (line === '' ? line : indent + line))
      .join(EOL) + EOL
  )
}

/**
 * The fence info string trimmed to its first word: a fence opening with
 * "js meta" names js. Everything after the first whitespace run is meta
 * the renderer never consumes; the full source stays in token.text.
 */
export function codeLanguageTag(token: Tokens.Code): string {
  return (token.lang ?? '').trim().split(/\s+/)[0] ?? ''
}

/**
 * Highlighted (or plain) body of a fenced code block, with trailing blank
 * lines stripped. Shared by the ANSI fence and CodeBlockFrame so both
 * surfaces agree on highlighting, language resolution and trimming.
 *
 * NEVER throws: cli-highlight feeds highlight.js, which converts to HTML
 * fragments and can raise synchronously on hostile inputs. Any failure in
 * the highlighting pipeline degrades to the plain body - the fence and
 * language label survive - instead of unwinding the React render that
 * called it.
 */
export function formatCodeBody(token: Tokens.Code, highlight: CliHighlight | null): string {
  const plain = token.text.replace(/\n+$/, '')
  if (!highlight || plain === '') return plain
  try {
    let language = 'plaintext'
    const tag = codeLanguageTag(token)
    if (tag) {
      if (highlight.supportsLanguage(tag)) {
        language = tag
      } else {
        logForDebugging(
          `Language not supported while highlighting code, falling back to plaintext: ${tag}`,
        )
      }
    }
    const theme = getActiveTheme()
    noteCodeHighlight()
    const highlighted = highlight.highlight(token.text, { language, theme: buildSyntaxTheme(theme) })
    // Strip ALL trailing newlines: trailing blank lines would otherwise leak
    // a stray blank line at the end of the block.
    return highlighted.replace(/\n+$/, '') || plain
  } catch (error) {
    logForDebugging(
      `Code highlighting threw, degrading the block to plaintext: ${String(error)}`,
    )
    return plain
  }
}

function renderEmphasis(token: Tokens.Em, state: RenderState): string {
  const inner = token.tokens.map(child => dispatch(child, inlineChildren(state))).join('')
  return chalk.italic(colorize(inner, renderTheme(state).markdownEmph, 'foreground'))
}

function renderStrong(token: Tokens.Strong, state: RenderState): string {
  const inner = token.tokens.map(child => dispatch(child, inlineChildren(state))).join('')
  return chalk.bold(colorize(inner, renderTheme(state).markdownStrong, 'foreground'))
}

/** Double-tilde strikethrough; marked's del tokenizer never pairs single
 *  tildes, so approximate notation like ~100 stays literal. */
function renderDel(token: Tokens.Del, state: RenderState): string {
  const inner = token.tokens.map(child => dispatch(child, inlineChildren(state))).join('')
  return chalk.strikethrough(inner)
}

/**
 * The hr divider: sixteen light box-drawing dashes in the theme's
 * dedicated markdown rule color.
 *
 * The trailing newline ends the divider's row; inter-block blank rows
 * come from markdownBlockGap, not from here.
 */
function renderHr(state: RenderState): string {
  return colorize(HR_DIVIDER, renderTheme(state).markdownHorizontalRule, 'foreground') + EOL
}

/**
 * Append one block token's rendered text to the accumulated run. When an
 * unterminated block (historically the newline-free hr divider) is
 * followed directly by content that does not open with its own line
 * break, the row break is inserted here so the two never merge into one
 * row.
 */
export function appendBlockText(accumulated: string, block: string): string {
  if (accumulated !== '' && !accumulated.endsWith(EOL) && block !== '' && !block.startsWith(EOL)) {
    return accumulated + EOL + block
  }
  return accumulated + block
}

function renderHeading(token: Tokens.Heading, state: RenderState): string {
  const text = token.tokens.map(child => dispatch(child, fresh(state))).join('')
  // Palette color on the ladder's loud end and muted tail (kimi-style):
  // H1 gets the heading color + underline, H2 bold, H3/H4 stay near-text
  // (bold, bold italic), H5 italic and H6 upright in the muted heading
  // color, so each level reads one step quieter.
  const heading = colorize(text, renderTheme(state).markdownHeading, 'foreground')
  const styled =
    token.depth === 1
      ? chalk.bold.underline(heading)
      : token.depth === 2
        ? chalk.bold(heading)
        : token.depth === 3
          ? chalk.bold(text)
          : token.depth === 4
            ? chalk.bold.italic(text)
            : token.depth === 5
              ? chalk.italic(heading)
              : heading
  // One trailing newline: blank rows below a heading come from the
  // source's own blank lines (the following space token), not from here.
  return styled + EOL
}

/**
 * Image reference: `[img]` plus the alt text, linked to the source URL
 * with OSC 8. Nothing is fetched; the href is only a click target.
 * Without hyperlink support the plain form shows both the alt and the URL.
 */
function renderImage(token: Tokens.Image, state: RenderState): string {
  const alt = token.text.replace(/\s+/g, ' ').trim()
  if (state.parent?.type === 'link') {
    // Inside a link's OSC 8 wrap a nested sequence would override the real
    // href; show the alt (or the URL) as plain text, like nested labels.
    return alt || token.href
  }
  if (!supportsHyperlinks()) {
    return alt ? `[img] ${alt} (${token.href})` : token.href
  }
  return createHyperlink(token.href, alt ? `[img] ${alt}` : '[img]')
}

function renderLink(token: Tokens.Link, state: RenderState): string {
  // mailto: links are shown as plain email addresses, not clickable links.
  if (token.href.startsWith('mailto:')) {
    return token.href.slice('mailto:'.length)
  }
  const label = token.tokens
    .map(child => dispatch(child, withParent(fresh(state), token)))
    .join('')
  const plainLabel = stripAnsi(label)
  // Meaningful display text (different from the URL) becomes a clickable
  // hyperlink; otherwise just show the URL.
  if (plainLabel && plainLabel !== token.href) {
    return markdownHyperlink(token.href, label, state)
  }
  return markdownHyperlink(token.href, undefined, state)
}

function renderList(token: Tokens.List, state: RenderState): string {
  // ordered lists always carry a numeric start ("" only occurs for unordered),
  // but the type says otherwise, so coerce defensively.
  const start = typeof token.start === 'number' ? token.start : 1
  const result = joinFormattedMarkdown(token.items.map((item, index) => {
    const ordinal = token.ordered ? start + index : null
    return formattedChild(item, { ...state, ordinal })
  }))
  state.layout?.set(token, result.continuationIndent)
  return result.text
}

function renderListItem(token: Tokens.ListItem, state: RenderState): string {
  // Tight task items carry their checkbox as a sibling token AHEAD of the
  // text token (loose items inline it inside the paragraph). Lift it out
  // here so it lands between the marker and the body.
  const isTightTask = token.task === true && token.tokens[0]?.type === 'checkbox'
  const children = isTightTask ? token.tokens.slice(1) : token.tokens
  const checkbox = isTightTask ? renderCheckbox(token.tokens[0] as Tokens.Checkbox, state) : ''
  const indent = '  '.repeat(state.listDepth)
  const depth = state.listDepth + 1
  const bullet = state.ordinal === null ? '-' : `${formatListMarker(depth, state.ordinal)}.`
  const theme = renderTheme(state)
  const marker = colorize(bullet, state.ordinal === null ? theme.markdownListItem : theme.markdownListEnumeration, 'foreground')
  const prefix = `${indent}${marker} ${checkbox}`
  const continuation = indent + ' '.repeat(stringWidth(bullet + ' ' + stripAnsi(checkbox)))
  const childState = withParent({ ...state, listDepth: depth }, token)
  let first = true
  const indents: number[] = []
  const body = children.map(child => {
    let body = dispatch(child, childState).replace(/\n+$/, '')
    if (!body) {
      if (child.type === 'space') indents.push(0)
      return child.type === 'space' ? EOL : ''
    }
    const nestedIndent = child.type === 'list' ? '  '.repeat(depth) : ''
    const childIndents = state.layout?.get(child)
    if (nestedIndent) {
      body = body.split(EOL)
        .map(line => line.startsWith(nestedIndent) ? line.slice(nestedIndent.length) : line)
        .join(EOL)
    }
    return body.split(EOL).map((line, index) => {
      if (!stripAnsi(line).trim()) {
        indents.push(0)
        return ''
      }
      const lead = first ? prefix : continuation
      first = false
      const contentIndent = nestedIndent
        ? Math.max(0, (childIndents?.[index] ?? 0) - nestedIndent.length)
        : (childIndents?.[index] ?? 0) > 0
          ? childIndents![index]!
          : stripAnsi(line).match(/^ */)?.[0].length ?? 0
      indents.push(stringWidth(stripAnsi(lead)) + contentIndent)
      return lead + line
    }).join(EOL) + EOL
  }).join('')
  if (first) indents.unshift(stringWidth(stripAnsi(prefix)))
  indents.push(0)
  state.layout?.set(token, indents)
  return first ? prefix + EOL + body : body
}

/**
 * Task checkbox as width-safe ASCII: literal [x] / [ ] keeps its state
 * through display, copy, and ANSI-stripping measurements alike; a styled
 * glyph pair would not survive every terminal font. The trailing space is
 * the separator to the item text.
 */
function renderCheckbox(token: Tokens.Checkbox, state: RenderState): string {
  const mark = token.checked ? '[x]' : '[ ]'
  const color = token.checked ? renderTheme(state).success : renderTheme(state).subtle
  return colorize(mark, color, 'foreground') + ' '
}

function renderParagraph(token: Tokens.Paragraph, state: RenderState): string {
  return token.tokens.map(child => dispatch(child, fresh(state))).join('') + EOL
}

function renderText(token: Tokens.Text, state: RenderState): string {
  if (state.parent?.type === 'link') {
    // Already inside a link: the link handler wraps everything in one OSC 8
    // sequence, and a nested one would override the real href. Stay plain.
    return token.text
  }

  // List markers, checkboxes and indentation belong to renderListItem:
  // a loose item's paragraph reaches here with a fresh state, and inline
  // em/strong children recurse through here with the list_item parent.
  if (token.tokens) {
    return token.tokens.map(child => dispatch(child, withParent(state, token))).join('')
  }
  return linkifyText(token.text, state)
}

function renderTable(token: Tokens.Table, state: RenderState): string {
  const rows = [token.header, ...token.rows]

  // Column widths derive from the visible (ANSI-stripped) cell text; 3 is
  // the minimum so a separator row always reads as a table divider.
  const columnWidths = token.header.map((_, colIndex) => {
    let widest = 3
    for (const row of rows) {
      widest = Math.max(widest, stringWidth(cellDisplayText(row[colIndex], state)))
    }
    return widest
  })

  const headerLine = renderTableRow(token.header, columnWidths, token.align, state)
  // Dashes only — alignment colons are not echoed into the output.
  const divider = `|${columnWidths.map(width => `${'-'.repeat(width + 2)}|`).join('')}${EOL}`
  const bodyLines = token.rows
    .map(row => renderTableRow(row, columnWidths, token.align, state))
    .join('')
  return headerLine + divider + bodyLines + EOL
}

/** Rendered cell content, stripped of ANSI codes, for width measurement. */
function cellDisplayText(cell: Tokens.TableCell, state: RenderState): string {
  return stripAnsi(
    cell.tokens.map(child => dispatch(child, fresh(state))).join(''),
  )
}

function renderTableRow(
  cells: Tokens.TableCell[],
  columnWidths: number[],
  aligns: Tokens.Table['align'],
  state: RenderState,
): string {
  let line = '| '
  cells.forEach((cell, index) => {
    const content = cell.tokens.map(child => dispatch(child, fresh(state))).join('')
    line +=
      padAligned(
        content,
        stringWidth(cellDisplayText(cell, state)),
        columnWidths[index],
        aligns[index],
      ) + ' | '
  })
  return line.trimEnd() + EOL
}

/**
 * Replace `owner/repo#123` references with clickable GitHub links.
 * No-op when the terminal lacks OSC 8 hyperlink support.
 */
function linkifyIssueReferences(text: string, state: RenderState): string {
  if (!supportsHyperlinks()) {
    return text
  }
  return text.replace(
    ISSUE_REFERENCE_PATTERN,
    (_match, prefix, repo, issueNumber) =>
      prefix +
      markdownHyperlink(
        `https://github.com/${repo}/issues/${issueNumber}`,
        `${repo}#${issueNumber}`,
        state,
      ),
  )
}

/**
 * Ordered-list marker for a given nesting depth: decimal at depth 1,
 * letters at depth 2, roman numerals at depth 3, decimal beyond.
 */
function formatListMarker(listDepth: number, ordinal: number): string {
  switch (listDepth) {
    case 2:
      return toAlphaIndex(ordinal)
    case 3:
      return toRomanNumeral(ordinal)
    default:
      return ordinal.toString()
  }
}

/** Bijective base-26 conversion: 1 → a, 26 → z, 27 → aa. */
function toAlphaIndex(n: number): string {
  if (n <= 0) return ''
  const digit = String.fromCharCode(97 + ((n - 1) % 26))
  return toAlphaIndex(Math.floor((n - 1) / 26)) + digit
}

/** Standard greedy roman-numeral symbol table (lowercase). */
const ROMAN_SYMBOLS: ReadonlyArray<readonly [number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]

function toRomanNumeral(n: number): string {
  let out = ''
  for (const [value, glyph] of ROMAN_SYMBOLS) {
    while (n >= value) {
      out += glyph
      n -= value
    }
  }
  return out
}

/**
 * Pad `content` to `targetWidth` according to alignment. `displayWidth` is
 * the visible width of `content` (callers compute it via stringWidth on the
 * ANSI-stripped text, so embedded escape codes don't affect padding).
 * @param content - The text to pad, which may carry ANSI codes.
 * @param displayWidth - Visible width of `content` without ANSI codes.
 * @param targetWidth - Column width to pad `content` to.
 * @param align - Alignment: 'left', 'center', 'right', or null/undefined for left.
 * @returns `content` padded with spaces to `targetWidth`.
 */
export function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const extra = Math.max(0, targetWidth - displayWidth)
  if (align === 'center') {
    const left = Math.floor(extra / 2)
    return ' '.repeat(left) + content + ' '.repeat(extra - left)
  }
  if (align === 'right') {
    return ' '.repeat(extra) + content
  }
  return content + ' '.repeat(extra)
}

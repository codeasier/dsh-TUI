import React from 'react'
import { extname } from 'node:path'
import { Box, Text, useTerminalSize } from '../../ui.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useAnimationFrame } from '../../ink/hooks/use-animation-frame.js'
import type { ToolCallView, ToolFileDiff, ToolResultView, ToolRow } from '../../dsh-adapter/channel.js'
import { ToolUseLoader } from '../ToolUseLoader.js'
import { SplitDiffView, SPLIT_DIFF_MIN_WIDTH } from '../SplitDiffView.js'
import { SyntaxText } from '../SyntaxText.js'
import { useTooltip } from '../Tooltip.js'
import { formatDuration } from '../../terminal-utils/format.js'
import { formatClock } from '../../trajectory/format.js'
import { foldLongLines } from '../../utils/fold-long-lines.js'
import { getLang, t, type I18nKey } from '../../i18n.js'
import type { ToolBackground } from '../../tuiDisplayPrefs.js'
import type { Theme } from '../../theme.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import { primaryComboString } from '../../utils/keymap.js'
import { usePageInset } from '../PageMargin.js'
// Left border + horizontal padding; kept in sync with the card Box below.
const CARD_CHROME_WIDTH = 3
const BODY_INDENT = 2

type Props = {
  tool: ToolRow
  /** Adds the top margin between messages. */
  marginTopOnTurn: boolean
  /** Ctrl+O verbose: show full args/result instead of previews. */
  verbose: boolean
  /** Message-selection mode highlight. */
  isSelected?: boolean
  /** Row expanded on its own (disclosure indicator state). */
  isExpanded?: boolean
  /**
   * Mouse click (fullscreen): toggles the row's expansion — same action as
   * clicking other transcript rows. Also makes the localized ctrl+o expand
   * hint (lines-folded-expand) actionable with the mouse.
   */
  onClick?(event: ClickEvent): void
  /**
   * Trajectory pointer, rendered after the failed call's output preview.
   *
   * It appears on the NEWEST unseen failure only, so a session with a dozen
   * failed calls still shows exactly one pointer — the moment of failure is
   * where the trajectory is worth mentioning, and mentioning it twelve times
   * is worth less than mentioning it once.
   */
  footnote?: string
  /** Diff presentation preference; `auto` picks by terminal width. */
  diffLayout?: 'auto' | 'split' | 'unified'
  /** Background treatment for the ordinary, unselected tool card surface. */
  toolBackground?: ToolBackground
  /** Transcript surfaces extend into page margins, but never into the gutter. */
  bleed?: boolean
  /**
   * Click-to-act (fullscreen): opens the file-action menu for the tool's
   * file path. When provided, the path in the card header (and diff path
   * rows) renders underlined and clickable; the click stops propagation so
   * the row's own fold-toggle does not fire.
   */
  onOpenFile?: (path: string) => void
  /**
   * Terminal-card header folding (settings `dsh-tui.foldTerminalCommand`):
   * collapsed cards keep the command title's first source line plus a
   * `+N lines` hint; verbose/expanded cards render the full title.
   */
  foldTerminalCommand?: boolean
}

/** Tool display names localize through the `tool-name-*` dictionary family
 *  (i18n.ts): DSH emits lowercase tool ids (`bash`), display names resolve
 *  per language — proper nouns (Bash, PowerShell) stay identical in zh.
 *  Unmapped ids (plugins, new upstream tools) fall back to the id with its
 *  first letter uppercased: that is a name, not copy — there is nothing to
 *  translate. Keys appear as literals here, so verify-i18n's dead-key scan
 *  sees them without a DYNAMIC_PREFIXES entry. */
const TOOL_NAME_KEYS: Record<string, I18nKey> = {
  bash: 'tool-name-bash',
  powershell: 'tool-name-powershell',
  read: 'tool-name-read',
  glob: 'tool-name-glob',
  grep: 'tool-name-grep',
  write: 'tool-name-write',
  edit: 'tool-name-edit',
  todo_write: 'tool-name-todo_write',
  subagent: 'tool-name-subagent',
  web_search: 'tool-name-web_search',
}

function displayName(name: string): string {
  const key = TOOL_NAME_KEYS[name]
  if (key !== undefined) return t(key)
  if (name.length === 0) return name
  return name[0]!.toUpperCase() + name.slice(1)
}

function parseJsonArgs(args: string): unknown {
  try { return JSON.parse(args) } catch { return undefined }
}

function jsonArgsLanguage(args: string): 'json' | undefined {
  return parseJsonArgs(args) === undefined ? undefined : 'json'
}

function filePathFromTool(tool: ToolRow, view: ToolCallView | ToolResultView | undefined): string | undefined {
  if (view !== undefined && 'path' in view && typeof view.path === 'string') return view.path
  const parsed = parseJsonArgs(tool.argsFull ?? tool.argsText)
  if (parsed !== null && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>
    for (const key of ['file_path', 'path']) if (typeof record[key] === 'string') return record[key]
  }
  return undefined
}

function languageFromPath(path: string | undefined): string | undefined {
  const language = path === undefined ? undefined : extname(path).slice(1).toLowerCase()
  return language === '' ? undefined : language
}

// --- structured body lines --------------------------------------------------
// The tool's presentation view (captured by the channel) becomes per-line
// render intents. Output aligns with the title inside an independent card.

/** `hint` is the trajectory pointer: recessive, never competing with output. */
type BodyTone = 'add' | 'del' | 'dim' | 'plain' | 'error' | 'hint' | 'path'
type BodyLine = {
  readonly text: string
  readonly tone: BodyTone
  /** The row's collapse hint: dim at rest, steps to text while hovered so the
   *  toggle reads before the click (the compaction row's pattern). */
  readonly revealOnHover?: boolean
}

/** The collapsed text body keeps three lines. */
const TEXT_BODY_MAX_LINES = 3
/** Diff bodies cap at the upstream chat row's 8 (dsh-client-ui-tool's
 *  CHAT_DIFF_MAX_LINES) — denser information than log output. */
const DIFF_BODY_MAX_LINES = 8
/** Minimum terminal width for the two-pane diff: below this the panes
 *  would squeeze under ~50 columns each and the unified view reads better. */
const SPLIT_DIFF_MIN_COLS = 110

/** Split alignment can be quadratic for unequal replacements. Default
 * previews must not pay that cost for a large hunk just to paint eight rows. */
function canPreviewSplitDiff(diffs: readonly ToolFileDiff[]): boolean {
  let remaining = 200
  let remainingChars = 8_000
  for (const diff of diffs) {
    for (const text of [diff.oldText, diff.newText]) {
      if (!text) continue
      remainingChars -= text.length
      if (remainingChars < 0 || --remaining < 0) return false
      for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
        if (--remaining < 0) return false
      }
    }
  }
  return true
}

const add = (text: string): BodyLine => ({ text, tone: 'add' })
const del = (text: string): BodyLine => ({ text, tone: 'del' })
const dim = (text: string): BodyLine => ({ text, tone: 'dim' })
const plain = (text: string): BodyLine => ({ text, tone: 'plain' })

/** Tool-name color by category (mist-blue accents): read/search tools keep
 *  the brand blue, file-mutating tools get the warm gold accent, exec /
 *  terminal tools get mist cyan. Exported for the subagent card, which
 *  mirrors the transcript tool-card name styling. */
const TOOL_NAME_MUTATE = new Set(['edit', 'write', 'multiedit', 'notebookedit'])
const TOOL_NAME_EXEC = new Set(['bash', 'bashpersistent', 'sh', 'shell', 'terminal'])
export function toolNameColor(raw: string): keyof Theme {
  const n = raw.toLowerCase()
  if (TOOL_NAME_MUTATE.has(n)) return 'toolNameMutate'
  if (TOOL_NAME_EXEC.has(n)) return 'toolNameExec'
  return 'accent'
}

/** One side's text → display lines (upstream contentLines rule: empty text
 *  is zero lines; a single trailing newline is a terminator, not a line;
 *  interior blanks survive). */
function sideLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Diff hunks → add/del rows. The header already carries the path for the
 *  common single-hunk case; with several hunks a path row separates files
 *  and `⋯` separates scattered hunks of one file (upstream DiffBlock). */
function diffLines(diffs: readonly ToolFileDiff[]): BodyLine[] {
  const out: BodyLine[] = []
  let prevPath: string | undefined
  for (const diff of diffs) {
    if (diffs.length > 1) {
      if (diff.path !== prevPath) out.push({ text: diff.path, tone: 'path' })
      else out.push(dim('⋯'))
    }
    prevPath = diff.path
    if (diff.oldText !== null) {
      for (const line of sideLines(diff.oldText)) out.push(del(`- ${line}`))
    }
    for (const line of sideLines(diff.newText)) out.push(add(`+ ${line}`))
  }
  return out
}

/** Join the text blocks of a view's content payload (read/generic cards). */
function contentLines(content: ReadonlyArray<{ readonly type: string; readonly text?: string }> | undefined): BodyLine[] {
  const text = (content ?? []).map(block => (block.type === 'text' ? block.text ?? '' : '')).join('').trimEnd()
  if (text === '') return []
  return text.split('\n').map(plain)
}

/** Per-card body lines; unknown/absent shapes yield [] so the caller falls
 *  back to the raw result text. */
function viewLines(view: ToolCallView | ToolResultView): BodyLine[] {
  switch (view.card) {
    case 'diff':
      return diffLines(view.diffs)
    case 'terminal': {
      // The call-side terminal card has no output yet; only presentResult's
      // does. `in` narrows the call/result union without extra types.
      const out = (('output' in view ? view.output : undefined) ?? '').trimEnd()
      const lines: BodyLine[] = out === '' ? [] : out.split('\n').map(plain)
      if ('exitCode' in view && view.exitCode !== undefined && view.exitCode !== 0) {
        lines.push({ text: t('tool-exit-code', { code: view.exitCode }), tone: 'error' })
      }
      if ('signal' in view && view.signal !== undefined) {
        lines.push({ text: t('tool-killed-signal', { name: String(view.signal) }), tone: 'error' })
      }
      return lines
    }
    case 'read':
      return contentLines('content' in view ? view.content : undefined)
    case 'generic':
      return contentLines('content' in view ? view.content : undefined)
    case 'search': {
      if (view.shape === 'paths') {
        const lines = view.paths.map(plain)
        if (view.truncated) lines.push(dim(t('search-results-total', { n: view.total })))
        return lines
      }
      const lines: BodyLine[] = []
      for (const file of view.files) {
        lines.push(plain(file.path))
        for (const match of file.matches) {
          lines.push(plain(`${match.lineNumber}: ${match.line}`))
        }
      }
      if (view.truncated) lines.push(dim(t('search-results-total', { n: view.total })))
      return lines
    }
    default:
      return []
  }
}

/** Preview rows are bounded; click / Ctrl+O reveals the complete result. */
function capLines(lines: BodyLine[], max: number, verbose: boolean): BodyLine[] {
  if (verbose) return lines
  if (max <= 0) return []
  if (lines.length <= max) return lines
  return [
    ...lines.slice(0, max),
    { ...dim(t('lines-folded-expand', { n: lines.length - max, key: primaryComboString('transcript') })), revealOnHover: true },
  ]
}

/** Long-line clip for the body rows (utils/fold-long-lines.ts): the line cap
 *  above bounds how MANY rows a card paints, this bounds how many rows ONE
 *  row can paint. A `read` of a minified file, a terminal result whose last
 *  line never broke, or a `write` payload is a single 100k-char line — under
 *  `wrap="wrap"` the body would lay out thousands of visual rows per frame
 *  no matter what the line budget says. Identity-preserving (same array, same
 *  line objects) when every line fits, so the ordinary card allocates
 *  nothing. */
function foldBodyLines(lines: BodyLine[]): BodyLine[] {
  let out: BodyLine[] | undefined
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const folded = foldLongLines(line.text)
    if (folded.hiddenChars === 0) {
      out?.push(line)
      continue
    }
    out ??= lines.slice(0, index)
    out.push({ ...line, text: folded.text })
  }
  return out ?? lines
}

/** Header args display budget: the parenthesized summary is a pointer, not
 * the payload — full args live in the verbose/expanded body. A streaming
 * tool call's args can grow to hundreds of KB, and wrapping that in the
 * header Text every frame was the dominant long-output stall (string-width
 * via wrap-ansi, 60%+ of CPU in profiles). */
const HEADER_ARGS_BUDGET = 480
const headerGraphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function clipHeaderArgs(args: string): string {
  if (args.length <= HEADER_ARGS_BUDGET) return args
  // A little lookahead identifies the last complete grapheme without walking
  // a potentially huge streamed argument. An unfinished cluster is omitted.
  let end = 0
  for (const part of headerGraphemes.segment(args.slice(0, HEADER_ARGS_BUDGET + 64))) {
    const next = part.index + part.segment.length
    if (next > HEADER_ARGS_BUDGET) break
    end = next
  }
  return `${args.slice(0, end)}…`
}

/** Terminal-card header folding shape: the line actually rendered, the source
 *  lines the multi-line fold hid, and the characters the long-line clip hid. */
type FoldedTitle = { first: string; hiddenLines: number; hiddenChars: number }

/** Fold a multi-line terminal command title to its first SOURCE line.
 *  Counts '\n' separators in place instead of materializing a line array —
 *  running cards re-render every second and a streamed command can reach
 *  hundreds of KB, and the exact cost the HEADER_ARGS_BUDGET comment above
 *  keeps out of the header must not sneak back in through folding. (Lone-\r
 *  titles are not a thing presentCall produces; CRLF is normalized on the
 *  first line only.)
 *
 *  Two independent folds:
 *   - `foldLines` (the `dsh-tui.foldTerminalCommand` setting): a multi-line
 *     script collapses to its first source line, reported as `+N lines`.
 *   - The long-line clip (always on — utils/fold-long-lines.ts): a command is
 *     frequently ONE enormous line (`python -c …`, a minified blob, a pasted
 *     `curl` body). Bound the preview before the header's width truncation;
 *     full text stays available through expansion and the tooltip.
 *
 *  Single short titles return undefined: nothing to fold, rendering stays
 *  byte-identical to the unfolded card (and the header stays tooltip-silent). */
function foldTerminalTitle(title: string, foldLines: boolean): FoldedTitle | undefined {
  const firstEnd = title.indexOf('\n')
  let hiddenLines = 0
  let body = title
  if (firstEnd !== -1 && foldLines) {
    let separators = 1
    for (let at = title.indexOf('\n', firstEnd + 1); at !== -1; at = title.indexOf('\n', at + 1)) separators++
    // Same trailing-newline rule as sideLines: a terminator is not a line.
    hiddenLines = separators - (title.endsWith('\n') ? 1 : 0)
    body = title.slice(0, title.charCodeAt(firstEnd - 1) === 13 ? firstEnd - 1 : firstEnd)
  }
  const clipped = foldLongLines(body)
  if (hiddenLines <= 0 && clipped.hiddenChars === 0) return undefined
  return { first: clipped.text, hiddenLines: Math.max(0, hiddenLines), hiddenChars: clipped.hiddenChars }
}

/** Addendum line appended to the header hover tooltip when the header hides
 *  content (folded script / clipped args / width-truncated title): start or
 *  finish wall-clock and the terminal result's exit code / signal —
 *  everything the header's relative `· 2m` chip and the body's
 *  `Running… (…)` line do NOT say. Durations stay out on purpose: showing
 *  a value twice, once on the card and once in the float, is exactly the
 *  noise class this tooltip exists to avoid. A fully visible header pops
 *  NOTHING (meta included) — a float that repeats or annotates content
 *  already on screen is noise, not detail. Returns '' when the row carries
 *  no timing data. */
function toolCardMetaTooltip(tool: ToolRow, isRunning: boolean, isError: boolean): string {
  const parts: string[] = []
  const startedAt = tool.startedAt
  if (isRunning) {
    if (startedAt !== undefined) parts.push(t('tool-tip-started', { time: formatClock(startedAt) }))
  } else {
    const durationMs = tool.durationMs
    if (startedAt !== undefined && durationMs !== undefined) {
      parts.push(t(isError ? 'tool-tip-failed' : 'tool-tip-finished', { time: formatClock(startedAt + durationMs) }))
    }
  }
  const resultView = tool.resultView
  if (resultView !== undefined && resultView.card === 'terminal') {
    if ('exitCode' in resultView && resultView.exitCode !== undefined && resultView.exitCode !== 0) {
      parts.push(t('tool-tip-exit', { code: resultView.exitCode }))
    }
    if ('signal' in resultView && resultView.signal !== undefined) {
      parts.push(t('tool-tip-signal', { name: String(resultView.signal) }))
    }
  }
  return parts.join(' · ')
}

function HeaderTitle({ name, title, isTerminal, folded, displayArgs, argsLanguage, nameColor, filePath, onOpenFile, metaTooltip, headerTextBudget, compact, headerColor }: {
  name: string
  title: string | undefined
  isTerminal: boolean
  /** Terminal-card fold result (multi-line title, folding on, not verbose). */
  folded: FoldedTitle | undefined
  displayArgs: string
  argsLanguage?: 'json'
  nameColor: keyof Theme
  /** Clickable file target: when set and present in the title, the path
   *  segment renders underlined and clickable (opens the file menu). */
  filePath?: string
  onOpenFile?: (path: string) => void
  /** Addendum line for the header hover tooltip when the header HIDES
   *  content (folded script / clipped args / width-truncated title):
   *  start/finish wall-clock, terminal exit code/signal — everything the
   *  relative chip and the body's Running… line do NOT say. Lazy getter,
   *  resolved at show time so a running card's start stays fresh. '' =
   *  nothing. A fully visible header pops no tooltip at all. */
  metaTooltip: () => string
  /**
   * Column budget for the header's title/summary —
   * `useTerminalSize().columns` (already margin-adjusted) minus the fixed
   * chrome of the row: loader dot 2 + hover ▾ indicator 2 (present while
   * the pointer dwells) + the settled elapsed chip + slack for the
   * transcript gutter. Every compact summary truncates to this row; expanded
   * terminal titles wrap while expanded non-terminal titles still truncate.
   */
  headerTextBudget: number
  compact: boolean
  headerColor: keyof Theme
}): React.ReactNode {
  const compactTitle = React.useMemo(() => {
    const source = title === undefined ? displayArgs : folded?.first ?? title.trim()
    const clipped = clipHeaderArgs(source)
    const text = clipped.replace(/[\r\n]+/g, ' ')
    const label = title === undefined
      ? `${name}${text ? `(${text})` : ''}`
      : isTerminal ? `$ ${text}` : text || name
    const hint = folded && folded.hiddenLines > 0
      ? ` ${t('lines-folded-expand', { n: folded.hiddenLines, key: primaryComboString('transcript') })}`
      : ''
    return { text: label + hint, hidden: clipped !== source || /[\r\n]/.test(clipped) || folded !== undefined }
  }, [name, title, isTerminal, folded, displayArgs])
  // Hover tooltip rule: pop ONLY when the header genuinely hides content —
  // a folded terminal script, args clipped past the 480-char budget, or a
  // non-terminal one-line title cut by layout width (truncate-end). A header
  // that fully fits its row stays silent: a float that repeats or annotates
  // text already visible next to the pointer is noise, not detail. Empty
  // content is a no-op inside the hook.
  const headerTooltip = useTooltip(() => {
    const meta = metaTooltip()
    const withMeta = (full: string): string => (meta === '' ? full : `${full}\n${meta}`)
    if (compact) {
      return compactTitle.hidden || stringWidth(compactTitle.text) > headerTextBudget
        ? withMeta(title ?? displayArgs)
        : ''
    }
    if (folded !== undefined) return withMeta(title ?? '')
    if (title === undefined && clipHeaderArgs(displayArgs) !== displayArgs) return withMeta(displayArgs)
    // Expanded width truncation: the non-terminal title Text is truncate-end —
    // a long one-line title is really cut by layout when it overflows the
    // row. Terminal titles WRAP instead (default Text wrap, nothing hidden)
    // and args within the 480 budget wrap too; they never reach this gate.
    if (title !== undefined && !isTerminal && stringWidth(title.trim()) > headerTextBudget) {
      return withMeta(title.trim())
    }
    // Header fully visible: nothing hidden, nothing to add — stay silent.
    return ''
  })
  if (compact) {
    const trimmed = title?.trim() ?? ''
    const at = filePath && !isTerminal ? trimmed.indexOf(filePath) : -1
    const clickable = onOpenFile !== undefined && filePath !== undefined && filePath !== '' && at >= 0
    return (
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} {...headerTooltip}>
        {clickable ? (
          <>
            <Text color={headerColor} wrap="truncate-end">{clipHeaderArgs(trimmed.slice(0, at)).replace(/[\r\n]+/g, ' ')}</Text>
            <Box flexGrow={1} flexShrink={1} minWidth={0} onClick={(event: ClickEvent) => {
              event.stopImmediatePropagation()
              onOpenFile(filePath)
            }}>
              <Text color={headerColor} underline wrap="truncate-end">{clipHeaderArgs(filePath).replace(/[\r\n]+/g, ' ')}</Text>
            </Box>
            <Text color={headerColor} wrap="truncate-end">{clipHeaderArgs(trimmed.slice(at + filePath.length)).replace(/[\r\n]+/g, ' ')}</Text>
          </>
        ) : (
          <Text color={headerColor} wrap="truncate-end">{compactTitle.text}</Text>
        )}
      </Box>
    )
  }
  if (title === undefined) {
    return (
      <>
        <Box flexShrink={0}>
          <Text bold color={nameColor} wrap="truncate-end">{name}</Text>
        </Box>
        {displayArgs !== '' && (
          <Box flexWrap="nowrap" {...headerTooltip}>
            <Text>(</Text>
            <SyntaxText text={clipHeaderArgs(displayArgs)} sourceText={displayArgs} language={argsLanguage} />
            <Text>)</Text>
          </Box>
        )}
      </>
    )
  }
  if (isTerminal) {
    return (
      <Box flexGrow={1} flexShrink={1} minWidth={0} {...headerTooltip}>
        <Text>{`$ ${title}`}</Text>
      </Box>
    )
  }
  const trimmed = title.trim()
  if (trimmed === '') {
    return (
      <Box flexShrink={0}>
        <Text bold color={nameColor} wrap="truncate-end">{name}</Text>
      </Box>
    )
  }
  // Clickable path: when the caller resolved a file path that appears in
  // the title (`Edit /path (1 - 100)`), render that segment underlined and
  // clickable. The click stops propagation so the row's fold toggle does
  // not fire. indexOf keeps the split exact even for paths with regex
  // metacharacters.
  if (onOpenFile !== undefined && filePath !== undefined && filePath !== '' && trimmed.includes(filePath)) {
    const at = trimmed.indexOf(filePath)
    const before = trimmed.slice(0, at)
    const after = trimmed.slice(at + filePath.length)
    return (
      <Box flexWrap="nowrap" {...headerTooltip}>
        <Text bold color={nameColor} wrap="truncate-end">{before}</Text>
        <Box
          onClick={(event: ClickEvent) => {
            event.stopImmediatePropagation()
            onOpenFile(filePath)
          }}
        >
          <Text underline wrap="truncate-end">{filePath}</Text>
        </Box>
        {after !== '' && (
          <Text bold={false} color="text" wrap="truncate-end">{after}</Text>
        )}
      </Box>
    )
  }
  const space = trimmed.indexOf(' ')
  const head = space === -1 ? trimmed : trimmed.slice(0, space)
  const tail = space === -1 ? '' : trimmed.slice(space)
  return (
    <Box flexWrap="nowrap" {...headerTooltip}>
      <Text bold color={nameColor} wrap="truncate-end">
        {head}
        <Text bold={false} color="text">{tail}</Text>
      </Text>
    </Box>
  )
}

/** Ordinary calls collapse to quiet inline summaries; output-heavy and failed
 * calls retain their cards. Shared with the transcript's spacing pre-pass. */
export function isInlineToolSummary(tool: ToolRow): boolean {
  const card = (tool.resultView ?? tool.callView)?.card
  return tool.status !== 'error' && !tool.errorText && card !== 'terminal' && card !== 'diff'
    && !TOOL_NAME_EXEC.has(tool.name.toLowerCase()) && tool.name !== 'powershell'
    && !TOOL_NAME_MUTATE.has(tool.name.toLowerCase())
}

/** Structured views remain channel-owned; expansion only changes presentation. */
export function AssistantToolUseMessage({
  tool,
  marginTopOnTurn,
  verbose,
  isSelected = false,
  isExpanded = false,
  onClick,
  footnote,
  diffLayout = 'auto',
  toolBackground = 'subtle',
  bleed = false,
  onOpenFile,
  foldTerminalCommand = false,
}: Props): React.ReactNode {
  const isRunning = tool.status === 'running'
  const isError = tool.status === 'error'
  const inlineSummary = !verbose && isInlineToolSummary(tool)
  const displayArgs = verbose ? tool.argsFull ?? tool.argsText : tool.argsText
  const result = tool.resultFull ?? tool.resultText
  const name = displayName(tool.name)
  const minWidth = stringWidth(name) + 2
  // The settled view carries the applied diff / actual output; while running,
  // the call view already shows the pending change.
  const view = tool.resultView ?? tool.callView
  const filePath = filePathFromTool(tool, view)
  const syntaxLanguage = view?.card === 'read' || view?.card === 'generic' || view === undefined
    ? languageFromPath(filePath)
    : undefined
  // presentResult may omit a title (terminal results carry output, not a
  // command) — then the call view's title stands.
  const headerTitle = tool.resultView?.title ?? tool.callView?.title
  const headerIsTerminal = view?.card === 'terminal'
  // Fold the terminal header: multi-line command script (setting-gated) plus
  // the always-on long-line clip, both off once the card is verbose/expanded
  // (Ctrl+O and the row click both land in `verbose`, so expansion reuses the
  // existing state machine). Memoized on the title reference: settled titles
  // never change, so the 1s useAnimationFrame tick of a running card
  // re-renders without rescanning. `lang` joins the deps because the inline
  // marker is localized.
  const lang = getLang()
  const foldedHeader = React.useMemo(
    () => headerIsTerminal && !verbose && headerTitle !== undefined
      ? foldTerminalTitle(headerTitle, foldTerminalCommand)
      : undefined,
    [headerIsTerminal, foldTerminalCommand, verbose, headerTitle, lang],
  )

  // Live elapsed clock while the call runs: the
  // 1s tick re-renders the card; elapsed derives from wall-clock refs.
  const [viewportRef] = useAnimationFrame(isRunning ? 1000 : null)
  const elapsedMs = isRunning
    ? tool.startedAt !== undefined
      ? Date.now() - tool.startedAt
      : undefined
    : tool.durationMs
  const elapsedText = elapsedMs !== undefined ? ` · ${formatDuration(elapsedMs)}` : ''

  // Body lines: the structured view first, raw result text as the fallback
  // (tools without a presenter, or a folded row awaiting loadOlder).
  // Wide terminals render diffs as a two-pane side-by-side instead: one
  // source line per terminal row (truncate) keeps the panes row-aligned,
  // which the flat add/del line model cannot express.
  const { columns } = useTerminalSize()
  const pageInset = usePageInset()
  // Keep one canvas column on the left and two gutter columns on the right.
  // Inline summaries remain prose-sized; standalone cards do not bleed.
  const bleedLeft = bleed && !inlineSummary ? Math.max(0, pageInset.x - 1) : 0
  const bleedRight = bleed && !inlineSummary ? Math.max(0, pageInset.x - 2) : 0
  const cardColumns = columns + bleedLeft + bleedRight
  // Interactive rows grow a ▾/▴ disclose column while the pointer dwells
  // (fixed, no layout shift elsewhere). The tooltip resolves at show time —
  // i.e. exactly while that column is present — so the budget must reserve
  // it for clickable cards only; non-interactive rows never render it.
  const interactive = onClick !== undefined
  // TerminalSize is already page-margin adjusted. Reserve the card border,
  // padding, status dot, hover indicator and settled elapsed chip.
  const headerTextBudget = Math.max(0, cardColumns - (inlineSummary ? 0 : CARD_CHROME_WIDTH) - 2 - (interactive ? 2 : 0)
    - (!inlineSummary && !isRunning && elapsedText !== '' ? stringWidth(elapsedText) : 0))
  const bodyWidth = Math.max(1, cardColumns - CARD_CHROME_WIDTH - BODY_INDENT)
  const splitPreviewSafe = React.useMemo(
    () => view?.card === 'diff' && canPreviewSplitDiff(view.diffs),
    [view],
  )
  const useSplitDiff = !isError && view?.card === 'diff' && bodyWidth >= SPLIT_DIFF_MIN_WIDTH &&
    (verbose || splitPreviewSafe) &&
    (diffLayout === 'split' || (diffLayout !== 'unified' && columns >= SPLIT_DIFF_MIN_COLS))
  let body: BodyLine[] = []
  if (isError && tool.errorText) {
    body = tool.errorText.trimEnd().split('\n').map(text => ({ text, tone: 'error' }))
  } else if (!useSplitDiff && !inlineSummary) {
    if (view !== undefined) body = viewLines(view)
    if (body.length === 0 && result) {
      body = result.trimEnd().split('\n').map(plain)
    }
    if (isRunning && body.length === 0) {
      body = [dim(t('tool-running-elapsed', { duration: formatDuration(Math.max(0, Date.now() - (tool.startedAt ?? Date.now()))) }))]
    }
  }
  const cap = view?.card === 'diff' ? DIFF_BODY_MAX_LINES : TEXT_BODY_MAX_LINES
  // Long-line clip before anything downstream reads the body: the syntax
  // highlighter walks `bodySource` by line index, so the folded text must be
  // the single source of truth for both.
  const bodyLines = verbose ? body : foldBodyLines(body)
  const bodySource = bodyLines.map(line => line.text).join('\n')
  const argsLanguage = jsonArgsLanguage(displayArgs)
  // The footnote rides OUTSIDE the cap: it is a pointer, not content, and a
  // long error body must not be the reason it disappears.
  // Exit status and signals are not output: keep them visible even when a
  // long terminal log is capped. Error messages themselves still use the cap.
  const terminalStatus = view?.card === 'terminal' && !tool.errorText
    ? bodyLines.filter(line => line.tone === 'error')
    : []
  const lines = terminalStatus.length === 0
    ? capLines(bodyLines, cap, verbose)
    : [...capLines(bodyLines.filter(line => line.tone !== 'error'), cap, verbose), ...terminalStatus]
  const rendered: BodyLine[] =
    footnote === undefined || useSplitDiff ? lines : [...lines, { text: footnote, tone: 'hint' }]
  // Expanded cards keep their surface; selected cards let the highlight show
  // through the split diff's unchanged context panes.
  const ordinaryToolBackground = isSelected ? 'none' : toolBackground
  const ordinaryBackground = ordinaryToolBackground === 'subtle'
    ? 'toolCardBackgroundDim'
    : ordinaryToolBackground === 'strong'
      ? 'toolCardBackground'
      : undefined
  // Hover affordance for the click-to-toggle row: the theme's tool-card blue
  // face marks the call's content area while the pointer dwells (the
  // toolBackground treatment steps up one level to the strong card face), the
  // collapsed fold hint (lines-folded-expand) steps from dim to text, the
  // elapsed clock stops dimming, and a ▾/▴ discloses the row is a toggle.
  // No layout change: the indicator is a fixed column on the header line, the
  // body never moves.
  const [hovered, setHovered] = React.useState(false)
  const hoverTint = interactive && hovered && !isSelected

  return (
    <Box
      ref={viewportRef}
      flexDirection="column"
      borderStyle={inlineSummary ? undefined : 'single'}
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      borderColor={isError ? 'error' : isRunning ? 'accent' : 'subtle'}
      paddingX={inlineSummary ? 0 : 1}
      paddingY={inlineSummary ? 0 : 1}
      marginTop={marginTopOnTurn ? 1 : 0}
      width={bleedLeft > 0 || bleedRight > 0 ? cardColumns : '100%'}
      marginLeft={-bleedLeft}
      marginRight={-bleedRight}
      onClick={onClick}
      // Only selection paints a highlight; the configured treatment applies
      // to an ordinary card. Diff line tints stay - they are content, not chrome.
      backgroundColor={isSelected ? 'messageActionsBackground' : inlineSummary ? undefined : hoverTint ? 'toolCardBackground' : ordinaryBackground}
      onMouseEnter={interactive ? () => setHovered(true) : undefined}
      onMouseLeave={interactive ? () => setHovered(false) : undefined}
    >
      <Box flexDirection="column" flexGrow={1} minWidth={0}>
        <Box flexDirection="row" flexWrap="nowrap" minWidth={verbose ? minWidth : 0}>
          {inlineSummary && !isRunning ? (
            <Text color={hovered ? 'text' : 'inactive'}>{view?.card === 'search' || tool.name === 'grep' || tool.name === 'glob' ? '* ' : '→ '}</Text>
          ) : (
            <ToolUseLoader
              shouldAnimate={isRunning}
              isUnresolved={isRunning}
              isError={isError}
              toolName={tool.name}
            />
          )}
          <HeaderTitle name={name} title={headerTitle} isTerminal={headerIsTerminal} folded={foldedHeader} displayArgs={displayArgs} argsLanguage={argsLanguage} nameColor={toolNameColor(tool.name)} filePath={filePath} onOpenFile={onOpenFile} metaTooltip={() => toolCardMetaTooltip(tool, isRunning, isError)} headerTextBudget={headerTextBudget} compact={!verbose} headerColor={isError ? 'error' : inlineSummary && !hovered && !isRunning ? 'inactive' : 'text'} />
          {!isRunning && !inlineSummary && (
            // flexShrink={0}: the elapsed chip is two cells of chrome and must
            // never be the thing that yields. Without it a long title pushed
            // the chip past the row and `· 0s` wrapped onto a second line,
            // orphaning a bare `·` at the right edge.
            <Box flexWrap="nowrap" flexShrink={0}>
              <Text dimColor={!hovered} wrap="truncate">{elapsedText}</Text>
            </Box>
          )}
          {hovered && (
            <Box flexShrink={0}>
              <Text dimColor>{isExpanded ? '▴' : '▾'}</Text>
            </Box>
          )}
        </Box>
        {(rendered.length > 0 || useSplitDiff) && <Box height={1} />}
        {useSplitDiff && view?.card === 'diff' ? (
          <Box flexDirection="row" paddingLeft={BODY_INDENT}>
            <SplitDiffView
              diffs={view.diffs}
              width={bodyWidth}
              maxRows={DIFF_BODY_MAX_LINES}
              verbose={verbose}
              toolBackground={ordinaryToolBackground}
            />
          </Box>
        ) : (
          rendered.map((line, index) => (
            <Box key={index} flexDirection="row" paddingLeft={BODY_INDENT}>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                {line.tone === 'path' && onOpenFile !== undefined ? (
                  <Box
                    onClick={(event: ClickEvent) => {
                      // Stop propagation so the row's fold toggle does not
                      // fire when clicking the path.
                      event.stopImmediatePropagation()
                      onOpenFile(line.text)
                    }}
                  >
                    <Text color="ide" underline wrap={verbose ? 'wrap' : 'truncate-end'}>{line.text}</Text>
                  </Box>
                ) : (
                  <Text
                    color={
                      line.tone === 'add'
                        ? 'diffAddedWord'
                        : line.tone === 'del'
                          ? 'diffRemovedWord'
                          : line.tone === 'error'
                            ? 'error'
                            : line.tone === 'hint'
                              ? 'subtle'
                              : line.tone === 'path'
                                ? 'ide'
                                : undefined
                    }
                    dimColor={line.tone === 'dim' && !(line.revealOnHover === true && hovered)}
                    wrap={verbose || line.tone === 'hint' || line.revealOnHover ? 'wrap' : 'truncate-end'}
                  >
                    {line.tone === 'plain' && syntaxLanguage !== undefined ? (
                      <SyntaxText text={line.text} sourceText={bodySource} lineIndex={index} language={syntaxLanguage} />
                    ) : (
                      line.text === '' ? ' ' : line.text
                    )}
                  </Text>
                )}
              </Box>
            </Box>
          ))
        )}
        {useSplitDiff && footnote !== undefined && (
          <Box flexDirection="row" paddingLeft={BODY_INDENT}>
            <Text color="subtle">{footnote}</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}

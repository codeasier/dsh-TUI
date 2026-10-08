import React from 'react'
import { Box, Text, useAnimationFrame, useTerminalSize } from '../../ui.js'
import { formatJobDuration, jobTitleOf, type BackgroundJobStatus } from '../../dsh-adapter/jobs.js'
import type { JobRow } from '../../dsh-adapter/channel.js'
import type { BackgroundJobOutputChannel, BackgroundJobOutputLine } from '../../adapter/ports/channel-view.js'
import type { Theme } from '../../theme.js'
import { t } from '../../i18n.js'
import wrapText from '../../ink/wrap-text.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { isMinimalUiMode } from '../../minimalUiMode.js'
import { ProgressBar } from '../design-system/ProgressBar.js'
import { MachineRail, RAIL_WIDTH } from '../messages/MachineRail.js'

/** The waterfall window mirrors the subagent card: a constant-height region. */
const WATERFALL_ROWS = 3
/** The waterfall's own `  │ ` gutter prefix (the machine rail is separate). */
const WATERFALL_GUTTER = 4

/** Static status marker — deliberately NOT the animated activity-indicator
 *  preset: a background job is parked work, and reusing the main spinner
 *  language for every card reads as clutter. ● = live background work
 *  (echoing the status-line chip), ✓/✗ for terminal states. NOTE: no ⚙ —
 *  U+2699 is East-Asian Ambiguous: ink measures it 1 cell while CJK
 *  terminal fonts paint it 2, so the following text overlaps the glyph. */
function statusInfo(status: BackgroundJobStatus): { glyph: string; label: string; color: keyof Theme | undefined } {
  const minimalUi = isMinimalUiMode()
  switch (status) {
    case 'completed':
      return { glyph: '✓', label: t('jobs-status-completed'), color: minimalUi ? undefined : 'success' }
    case 'failed':
      return { glyph: '✗', label: t('jobs-status-failed'), color: minimalUi ? undefined : 'error' }
    case 'killed':
      return { glyph: '✗', label: t('jobs-status-killed'), color: minimalUi ? undefined : 'error' }
    case 'stopping':
      return { glyph: '●', label: t('jobs-status-stopping'), color: minimalUi ? undefined : 'warning' }
    default:
      return { glyph: '●', label: t('jobs-status-running'), color: minimalUi ? undefined : 'warning' }
  }
}

/**
 * Producer progress as the design system's bar: `n/m` draws a 5-cell
 * sub-cell-accurate `ProgressBar` (same primitive the rest of the TUI uses)
 * plus the raw counter; any other shape passes through verbatim. Exported for
 * the /jobs panel so both surfaces read the same.
 */
export function JobProgress({ progress }: { progress: string }): React.ReactNode {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(progress.trim())
  const current = match === null ? Number.NaN : Number(match[1])
  const total = match === null ? Number.NaN : Number(match[2])
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
    return <Text color="accent" wrap="truncate-end">{progress}</Text>
  }
  return (
    <Box flexDirection="row" gap={1}>
      <ProgressBar ratio={Math.min(current, total) / total} width={5} fillColor="accent" emptyColor="inactive" />
      <Text color="accent">{progress.trim()}</Text>
    </Box>
  )
}

/** One rendered waterfall row: a wrapped piece of an output line, or a gap
 *  banner standing on its own row. */
interface WaterfallRow {
  key: string
  text: string
  channel?: BackgroundJobOutputChannel
  gap?: true
}

/**
 * The waterfall window: every entry is WRAPPED at the card width FIRST, then
 * the last `budget` VISUAL rows are kept. A 400-cell JSON line therefore
 * shows its ending folded over the rows instead of a clipped head — and the
 * window still costs a constant number of rows, which is what the
 * transcript's virtualization measures.
 */
function waterfallWindow(
  entries: ReadonlyArray<{ kind: 'line'; line: BackgroundJobOutputLine } | { kind: 'gap' }>,
  width: number,
  budget: number,
): WaterfallRow[] {
  const rows: WaterfallRow[] = []
  // One cell of slack: a line that lands exactly on the boundary is re-wrapped
  // by ink's own renderer, which would silently double that row's height.
  const textWidth = Math.max(1, width - 1)
  for (let index = entries.length - 1; index >= 0 && rows.length < budget; index--) {
    const entry = entries[index]!
    if (entry.kind === 'gap') {
      rows.unshift({ key: `gap-${index}`, text: '', gap: true })
      continue
    }
    const wrapped = wrapText(entry.line.text, textWidth, 'wrap').split('\n')
    for (let row = wrapped.length - 1; row >= 0 && rows.length < budget; row--) {
      rows.unshift({
        key: `${index}-${row}`,
        text: wrapped[row] ?? '',
        ...(entry.line.channel === undefined ? {} : { channel: entry.line.channel }),
      })
    }
  }
  return rows
}

/**
 * Live background-job card embedded in the transcript (`kind: 'job'`),
 * sibling of the subagent card: header (overview · id · kind · elapsed ·
 * status) plus a bounded output waterfall (up to three rows) while the job
 * is live — and only when mirrored output exists: background jobs are
 * usually silent, so an outputless card is just its header line, never a
 * row of empty gutters. Settled jobs fold to the header line alone (a
 * failed/killed job keeps one detail line); the `/jobs` panel holds the
 * fuller view the card clicks to.
 *
 * The waterfall is MIRRORED, never polled: the harness job registry's read
 * is consuming and reserved for the owning agent, so the card shows the
 * tail of the agent's own job_output results as they stream through the
 * transcript.
 *
 * `rail` marks the card as a member of a job GROUP (see JobGroupRow): the
 * card gets a 2-cell chain column on its left, and `rail.open` / `rail.close`
 * round its ends (`╭` on the first line, `╰` on the last) so the run reads as
 * one bracket from the first card to the last — the group's summary line stays
 * OUTSIDE it. A lone card renders as before.
 *
 * The rail is drawn per line, which means this component owns the card's
 * HEIGHT: the label is pre-wrapped against an explicit column width (so the
 * wrap count is known, not guessed from the flex result), and the rail column
 * paints exactly that many glyphs. Both use ink's own `wrapText`/`stringWidth`,
 * so the pre-wrap breaks where the renderer would have broken.
 */
export function JobCard({ job, marginTopOnTurn, onClick, rail, expanded: _expanded, onToggle: _onToggle, onWatchOutput }: {
  job: JobRow
  marginTopOnTurn: boolean
  onClick?(): void
  /** Job GROUP member: shared chain rail, optionally rounded at either end. */
  rail?: { open?: boolean; close?: boolean } | undefined
  /** Upstream-0.14 call-site compatibility: the compact fork card keeps no
   *  command section to fold, so the command toggle props are accepted and
   *  unused; the transcript click still opens the panel focused on the job. */
  expanded?: boolean
  onToggle?(): void
  /** Live-card output watch hook (MessageList wires the panel's tail feed). */
  onWatchOutput?(id: string): () => void
}): React.ReactNode {
  const settled = job.status === 'completed' || job.status === 'failed' || job.status === 'killed'
  React.useEffect(() => (settled || onWatchOutput === undefined ? undefined : onWatchOutput(job.id)), [settled, onWatchOutput, job.id])
  // Only live cards subscribe to the shared clock; the status glyph is static.
  const [viewportRef] = useAnimationFrame(settled ? null : 1000)
  const { columns } = useTerminalSize()
  const info = statusInfo(job.status)
  const [hovered, setHovered] = React.useState(false)
  const clickable = onClick !== undefined
  const grouped = rail !== undefined
  // Both the machine rail and the group's bracket occupy the same two cells.
  const cardColumns = Math.max(1, columns - RAIL_WIDTH)
  const rowWidth = Math.max(1, cardColumns - WATERFALL_GUTTER)
  const waterfall: Array<{ kind: 'line'; line: BackgroundJobOutputLine } | { kind: 'gap' }> = []
  for (const line of settled ? [] : job.outputLines) {
    if (line.gapBefore === true) waterfall.push({ kind: 'gap' })
    waterfall.push({ kind: 'line', line })
  }
  const activity = waterfallWindow(waterfall, rowWidth, WATERFALL_ROWS)
  const headerDetail = job.detail !== undefined && job.detail !== '' ? job.detail : undefined
  const headerName = `${t('jobs-card-prefix')}${jobTitleOf(job)}`
  const duration = formatJobDuration(job)
  const liveProgress = settled || job.progress === undefined || job.progress === '' ? undefined : job.progress

  // The title is the ONLY wrapping column, with fork metadata beside it rather
  // than a second copy of the registry label. Pre-wrap the actual displayed
  // title so the bracket covers precisely the rows the renderer will paint.
  const fixedWidths = [
    stringWidth(info.glyph),
    stringWidth(job.id),
    stringWidth(job.kind),
    stringWidth(duration),
    stringWidth(info.label),
  ]
  let titleBudget = cardColumns - fixedWidths.reduce((sum, width) => sum + width, 0) - fixedWidths.length - 1
  // Optional chips move below the header when they would squeeze the title
  // into a per-character column or overflow a narrow chat column altogether.
  const progressInHeader = liveProgress !== undefined && titleBudget >= 8 + 13
  if (progressInHeader) titleBudget -= 13
  const detailInHeader = headerDetail !== undefined && titleBudget >= 8 + stringWidth(headerDetail) + 1
  if (detailInHeader) titleBudget -= stringWidth(headerDetail!) + 1
  const titleWidth = Math.max(1, titleBudget)
  const titleLines = wrapText(headerName, titleWidth, 'wrap').split('\n')
  const progressTail = liveProgress !== undefined && !progressInHeader
  const detailTail = headerDetail !== undefined && (!detailInHeader || (settled && job.status !== 'completed'))
  const contentLines = titleLines.length + activity.length + (detailTail ? 1 : 0) + (progressTail ? 1 : 0)
  const railGlyphs: string[] = []
  if (grouped) {
    for (let index = 0; index < contentLines; index++) {
      const opens = index === 0 && rail?.open === true
      const closes = index === contentLines - 1 && rail?.close === true
      railGlyphs.push(opens ? '╭' : closes ? '╰' : '│')
    }
  }

  return <Box
    flexDirection="row"
    marginTop={marginTopOnTurn ? 1 : 0}
    ref={viewportRef}
    onClick={onClick}
    onMouseEnter={clickable ? () => setHovered(true) : undefined}
    onMouseLeave={clickable ? () => setHovered(false) : undefined}
  >
    {grouped ? (
      <Box width={RAIL_WIDTH} flexShrink={0}>
        <Text color="inactive">{railGlyphs.join('\n')}</Text>
      </Box>
    ) : <MachineRail />}
    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={0}>
          <Text color={hovered && clickable ? 'accent' : info.color}>{info.glyph}</Text>
        </Box>
        <Box width={titleWidth} flexShrink={0} flexDirection="column">
          {titleLines.map((line, index) => (
            <Text key={index} bold color={hovered && clickable ? 'accent' : undefined}>{line}</Text>
          ))}
        </Box>
        <Box flexShrink={0}><Text dimColor>{job.id}</Text></Box>
        <Box flexShrink={0}><Text dimColor>{job.kind}</Text></Box>
        {progressInHeader && (
          <Box width={12} flexShrink={0}>
            <JobProgress progress={liveProgress!} />
          </Box>
        )}
        <Box flexShrink={0}><Text dimColor>{duration}</Text></Box>
        {detailInHeader && <Box flexShrink={0}><Text dimColor>{headerDetail}</Text></Box>}
        <Box flexShrink={0}><Text color={info.color}>{info.label}</Text></Box>
      </Box>
      {progressTail && <Box paddingLeft={WATERFALL_GUTTER}><JobProgress progress={liveProgress!} /></Box>}
      {activity.map(entry => (
        entry.gap === true ? (
          <Text key={entry.key} dimColor italic wrap="truncate">
            {`  · ${t('jobs-output-gap')}`}
          </Text>
        ) : (
          <Text
            key={entry.key}
            color={entry.channel === 'stderr' ? 'error' : undefined}
            dimColor={entry.channel !== 'stderr'}
            wrap="truncate"
          >
            {`  │ ${entry.text}`}
          </Text>
        )
      ))}
      {detailTail && <Text dimColor wrap="truncate">{`  └ ${headerDetail}`}</Text>}
    </Box>
  </Box>
}

const COMMAND_MARK = process.platform === 'win32' ? '>' : '❯'

/** Command content shares normalization and wrapping with the full jobs panel. */
export function jobCommandRows(text: string, width: number, expanded: boolean): string[] {
  const command = text.trim()
  const script = command.replace(/^(?:pwsh|powershell)(?:\.exe)?\s+(?:(?:-(?:NoProfile|NoLogo|NonInteractive)|-ExecutionPolicy\s+\S+)\s+)*-Command\s+/i, '')
  const body = (script === command ? script : script.replace(/^(['"])([\s\S]*)\1$/, '$2')).replace(/\r\n?/g, '\n').trim()
  const source = body.split('\n').filter((line, index, lines) => line.trim() !== '' || index === 0 || lines[index - 1]?.trim() !== '').join('\n')
  const shown = expanded ? source : source.split('\n')[0]!
  const rows = wrapText(COMMAND_MARK + ' ' + shown, Math.max(1, width), 'wrap').split('\n')
  return expanded ? rows : rows.slice(0, 1)
}

/** The renderer draws the continuous section edge across all content rows. */
export function JobSection({ rows, color, onToggle, children }: {
  rows: readonly string[]
  color: 'accent' | 'success'
  onToggle?: () => void
  children?: React.ReactNode
}): React.ReactNode {
  if (rows.length === 0 && children === undefined) return null
  return <Box flexDirection="column" borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderLeft
    borderColor={color} paddingLeft={1}
    onClick={onToggle === undefined ? undefined : event => { event.stopImmediatePropagation(); onToggle() }}>
    {children === undefined ? rows.map((line, index) => <Text key={index} dimColor wrap="truncate-end">{line === '' ? ' ' : line}</Text>) : children}
  </Box>
}

export function jobOutputRows(
  entries: readonly BackgroundJobOutputLine[],
  width: number,
  budget: number,
): WaterfallRow[] {
  const rows: WaterfallRow[] = []
  // One cell of slack: a line that lands exactly on the boundary is re-wrapped
  // by ink's own renderer, which would silently double that row's height.
  const textWidth = Math.max(1, width - 1)
  for (let index = entries.length - 1; index >= 0 && rows.length < budget; index--) {
    const entry = entries[index]!
    const wrapped = wrapText(entry.text, textWidth, 'wrap').split('\n')
    for (let row = wrapped.length - 1; row >= 0 && rows.length < budget; row--) {
      rows.unshift({
        key: `${index}-${row}`,
        text: wrapped[row] ?? '',
      })
    }
    if (entry.gapBefore === true && rows.length < budget) rows.unshift({ key: `gap-${index}`, text: '', gap: true })
  }
  return rows
}

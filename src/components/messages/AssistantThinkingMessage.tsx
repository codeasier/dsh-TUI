import React from 'react'
import chalk from 'chalk'
import { Box, Text } from '../../ui.js'
import { t } from '../../i18n.js'
import { StreamingMarkdown } from '../StreamingMarkdown.js'
import { formatDuration, formatTokens } from '../../terminal-utils/format.js'
import {
  THINKING_SPINNER_FRAMES,
  THINKING_SPINNER_INTERVAL_MS,
  THINKING_SETTLED_MARKER,
  THINKING_EXPANDED_MARKER,
} from '../../terminal-utils/figures.js'
import { BRAND, ICE } from '../shimmer.js'
import { interpolateColor } from '../Spinner/spinnerUtils.js'
import { isMinimalUiMode } from '../../minimalUiMode.js'
import type { ClickEvent } from '../../ink/events/click-event.js'

/** Preview body rows — a FIXED row count (kimicode-style constant-height
 *  ticker). Ink's truncate slices the whole string across newlines as one
 *  logical line, so a single joined Text collapses to 1-2 rows whenever
 *  the combined width passes the terminal width, then bounces back as
 *  lines shift. One Text per row, each truncated to the width and padded
 *  to exactly this many rows, keeps the block height stream-independent. */
const PREVIEW_ROWS = 3

type Props = {
  thinking: string
  /** The FULL un-revealed text (reasoning rows under smooth streaming):
   *  `thinking` carries the revealed slice the expanded body paints, while
   *  the live preview ticker must follow the newest ARRIVED content — never
   *  a lagging reveal. Falls back to `thinking`. */
  textFull?: string
  /** Adds the top margin between messages. */
  marginTopOnTurn: boolean
  /** Show the full text (Ctrl+O, per-row expansion, or live click toggle). */
  verbose: boolean
  /** True while the reasoning block is still streaming — the leading anchor
   *  becomes a rotating braille spinner (Kimi Code style) and settles back
   *  to the anchor once the step ends. */
  streaming?: boolean
  /** Streaming compact mode (thinkingFold=preview): a 3-row live ticker of
   *  the model's latest reasoning lines instead of the full block —
   *  kimicode-style constant height; the block never resizes mid-stream. */
  preview?: boolean
  /** Thinking wall-clock duration once the reasoning block settled (ms). */
  durationMs?: number
  /** Estimated thinking tokens when the backend reports thinking only as a
   *  count (no text). Renders a one-line `Thinking · ~N tokens` header while
   *  streaming and `Thought · ~N tokens` once settled; text, when present,
   *  still wins. */
  reasoningTokens?: number
  /** Message-selection mode highlight. */
  isSelected?: boolean
  onClick?(event: ClickEvent): void
}

/**
 * Thinking block: settled rows collapse to a single line — `+ Thinking · 12s`
 * — and the leading mark flips to `-` while the block is open (click the row
 * or Ctrl+O), the pair reading like a disclosure triangle. Streaming rows
 * switch between a three-line preview and the full reasoning text on click;
 * their leading mark is a rotating braille spinner (`⠋⠙⠹…`, Kimi Code
 * style), settling back to `+`. When the channel records the reasoning
 * duration, the label carries it — dsh-tui's take on making thinking time
 * visible in the transcript.
 */
export function AssistantThinkingMessage({
  thinking,
  textFull,
  marginTopOnTurn,
  verbose,
  streaming = false,
  preview = false,
  durationMs,
  reasoningTokens,
  isSelected = false,
  onClick,
}: Props): React.ReactNode {
  if (!thinking) {
    if (reasoningTokens === undefined) return null
    return (
      <ThinkingTokensHeader
        tokens={reasoningTokens}
        streaming={streaming}
        marginTopOnTurn={marginTopOnTurn}
        isSelected={isSelected}
        onClick={onClick}
      />
    )
  }

  // The preview ticker tracks the newest ARRIVED line (smooth streaming must
  // not lag it behind the reveal); the expanded body below paints `thinking`
  // — the revealed slice under smooth streaming, the full text otherwise.
  const tickerText = textFull ?? thinking

  // Spinner frame (80ms cadence, only while the reasoning is still
  // streaming — same pattern as BtwPanel's answering spinner).
  const [frame, setFrame] = React.useState(0)
  React.useEffect(() => {
    if (!streaming) return
    const interval = setInterval(() => setFrame(f => f + 1), THINKING_SPINNER_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [streaming])

  const duration =
    durationMs !== undefined && durationMs >= 1000
      ? ` · ${formatDuration(durationMs)}`
      : ''

  // Kimi Code style blue pulse: the streaming glyph breathes along the
  // header's brand→ice ladder, one sine period per ~7 frames (≈0.56s) —
  // lively without strobing. Minimal mode drops the color (plain glyph);
  // settled labels use the theme's warning accent.
  //
  // No expand hint on the settled label: it rode every single thinking step,
  // so a long turn stacked a dozen identical `hint-expand-ctrl-o` tails —
  // `+ Thinking · 12s` plus the same words again, once per step — and spent
  // half the width repeating itself. The `+`/`-` disclosure and the `?`
  // shortcut menu carry the affordance instead. (Upstream 0.11.2 made that
  // hint keymap-aware via `primaryComboString('transcript')`; the removal
  // stands either way — the cost was the repetition, not the key name. That
  // is why the import is gone with it.)
  const label = `${t('thinking-label')}${duration}${streaming ? '…' : ''}`
  const minimalUi = isMinimalUiMode()
  const pulse = (Math.sin(frame * 0.9) + 1) / 2
  const pulseColor = interpolateColor(BRAND, ICE, pulse)
  const frameText = THINKING_SPINNER_FRAMES[frame % THINKING_SPINNER_FRAMES.length]!
  // Hover 轻指示：可点击折叠时折叠头从琥珀色切到正文色（不刷整行背景，
  // 转录视觉保持安静）。
  const [hovered, setHovered] = React.useState(false)
  const hoverProps = onClick !== undefined
    ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) }
    : {}
  const header =
    streaming ? (
      <Box flexDirection="row">
        <Text>{minimalUi ? frameText : chalk.rgb(pulseColor.r, pulseColor.g, pulseColor.b).bold(frameText)}</Text>
        {/* 流式行同样可点击折叠（hover 提亮标签给出指示，与落定态一致） */}
        <Text color={minimalUi ? undefined : hovered ? 'text' : 'warning'}>{` ${label}`}</Text>
      </Box>
    ) : (
      <Text color={minimalUi ? undefined : hovered ? 'text' : 'warning'}>{`${minimalUi ? '*' : verbose ? THINKING_EXPANDED_MARKER : THINKING_SETTLED_MARKER} ${label}`}</Text>
    )

  if (preview) {
    // Live ticker: the model's last few reasoning lines, accented, one Text
    // per row so each truncates to the width independently, padded to a
    // constant PREVIEW_ROWS-tall block that follows the stream. The folded
    // summary takes over when the step settles. The LAST row truncates
    // from the start (leading ellipsis) so the newest tokens — which grow
    // at the line's end — stay visible while the line is longer than the
    // width.
    const lines = tickerText.split('\n')
    const visible = lines.slice(-PREVIEW_ROWS)
    const clipped = lines.length > visible.length
    // Pad with single spaces — an empty-string Text renders with zero
    // height in ink, so '' padding would not hold the row open.
    const rows = Array.from(
      { length: PREVIEW_ROWS },
      (_, i) => visible[i] ?? ' ',
    )
    return (
      <ThinkingRow
        marginTop={marginTopOnTurn ? 1 : 0}
        isSelected={isSelected}
        onClick={onClick}
        hoverProps={hoverProps}
      >
        {header}
        <Box
          flexDirection="column"
          paddingLeft={2}
          height={PREVIEW_ROWS}
          flexShrink={0}
          overflow="hidden"
        >
          {rows.map((line, i) => (
            <Box key={i} flexDirection="row" height={1}>
              {/* The bar is a fixed-width column OUTSIDE the truncating text:
                * ink's truncate-start rewrites the text's leading columns, so
                * a bar inside the text would be eaten by the ellipsis. */}
              <Text dimColor italic>{'│ '}</Text>
              <Box flexDirection="row" flexGrow={1}>
                <Text
                  color={minimalUi ? undefined : 'warning'}
                  italic
                  wrap={i === rows.length - 1 ? 'truncate-start' : 'truncate'}
                >
                  {i === 0 && clipped ? `…${line}` : line}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      </ThinkingRow>
    )
  }

  if (!verbose) {
    return (
      <ThinkingRow
        marginTop={marginTopOnTurn ? 1 : 0}
        isSelected={isSelected}
        onClick={onClick}
        hoverProps={hoverProps}
      >
        {header}
      </ThinkingRow>
    )
  }

  return (
    <ThinkingRow
      marginTop={marginTopOnTurn ? 1 : 0}
      isSelected={isSelected}
      onClick={onClick}
      hoverProps={hoverProps}
      gap={1}
    >
      {header}
      <Box paddingLeft={2}>
        {/* StreamingMarkdown: the live thinking text grows per token — the
          incremental stable-prefix + tail budget keeps the per-frame layout
          cost at O(new content) instead of re-laying out the whole block. */}
        <StreamingMarkdown>{thinking}</StreamingMarkdown>
      </Box>
    </ThinkingRow>
  )
}

/** Shared unrailed shell for collapsed, preview and expanded reasoning. */
function ThinkingRow({
  marginTop,
  isSelected,
  onClick,
  hoverProps,
  gap = 0,
  children,
}: {
  marginTop: number
  isSelected: boolean
  onClick?: ((event: ClickEvent) => void) | undefined
  hoverProps: { onMouseEnter?: () => void; onMouseLeave?: () => void }
  /** Blank rows between the header and the body (verbose view). */
  gap?: number
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Box
      flexDirection="row"
      marginTop={marginTop}
      backgroundColor={isSelected ? 'messageActionsBackground' : undefined}
      onClick={onClick}
      {...hoverProps}
    >
      <Box flexDirection="column" flexGrow={1} flexShrink={1} gap={gap}>
        {children}
      </Box>
    </Box>
  )
}

/**
 * Count-only thinking: the backend streams an
 * estimated token count but no thinking text. One header line in the same
 * visual language as a text block — the pulsing braille spinner while live,
 * the settled anchor afterwards — with nothing to expand.
 */
function ThinkingTokensHeader({
  tokens,
  streaming,
  marginTopOnTurn,
  isSelected,
  onClick,
}: {
  tokens: number
  streaming: boolean
  marginTopOnTurn: boolean
  isSelected: boolean
  onClick?(event: ClickEvent): void
}): React.ReactNode {
  const [frame, setFrame] = React.useState(0)
  React.useEffect(() => {
    if (!streaming) return
    const interval = setInterval(() => setFrame(f => f + 1), THINKING_SPINNER_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [streaming])
  const minimalUi = isMinimalUiMode()
  const n = formatTokens(tokens)
  const pulse = (Math.sin(frame * 0.9) + 1) / 2
  const pulseColor = interpolateColor(BRAND, ICE, pulse)
  const frameText = THINKING_SPINNER_FRAMES[frame % THINKING_SPINNER_FRAMES.length]!
  return (
    <Box
      flexDirection="row"
      marginTop={marginTopOnTurn ? 1 : 0}
      backgroundColor={isSelected ? 'messageActionsBackground' : undefined}
      onClick={onClick}
    >
      {streaming ? (
        <>
          <Text>{minimalUi ? frameText : chalk.rgb(pulseColor.r, pulseColor.g, pulseColor.b).bold(frameText)}</Text>
          <Text dimColor italic>{` ${t('thinking-tokens-live', { n })}`}</Text>
        </>
      ) : (
        <Text dimColor italic>{`${minimalUi ? '*' : THINKING_SETTLED_MARKER} ${t('thinking-tokens-done', { n })}`}</Text>
      )}
    </Box>
  )
}

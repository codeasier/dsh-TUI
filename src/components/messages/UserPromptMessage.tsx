import React from 'react'
import { Box, Text, useTerminalSize } from '../../ui.js'
import { POINTER } from '../../terminal-utils/figures.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { wrapWidth } from '../../sessions/format.js'
import type { ClickEvent } from '../../ink/events/click-event.js'

type Props = {
  text: string
  /** Adds the top margin between turns. */
  marginTopOnTurn: boolean
  /** Message-selection mode highlight. */
  isSelected?: boolean
  onClick?(event: ClickEvent): void
}

/** Left edge bar: the turn anchor, on every visual line so the band has a
 *  spine even where a fill is invisible (`dark-ansi`). */
const TURN_BAR = '▌'

/**
 * User prompt block: `▌ ❯ text` — a full-width band in `userPromptBackground`
 * with a gold left bar and gold bold text.
 *
 * The band is what makes a turn findable when scrolling back through a long
 * transcript: prose and machine rows are unbanded at col 0 / col 2, so the
 * eye lands on the prompt before it reads anything. The bar (not a fill
 * alone) carries the anchor on palettes with no fill (`dark-ansi`) and in
 * terminals where a subtle band is invisible.
 *
 * Selection mode paints the band in `messageActionsBackground` instead.
 */
export function UserPromptMessage({
  text,
  marginTopOnTurn,
  isSelected = false,
  onClick,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const promptPrefix = `${POINTER} `
  const barPrefix = `${TURN_BAR} `
  const prefixWidth = stringWidth(barPrefix) + stringWidth(promptPrefix)
  // Wrap here instead of letting Ink wrap the whole Text node. Ink starts an
  // automatic continuation at column zero, while a prompt needs a hanging
  // indent for both explicit newlines and width-based visual lines.
  // Leave a small safety margin for the ScrollBox edge/scrollbar. The Text
  // nodes below are explicitly wrapped, so they must never be wrapped again by
  // Ink; a second wrap would move the continuation back to column zero.
  const lines = wrapWidth(text, Math.max(1, columns - prefixWidth - 3))
  // The bar's two cells are emitted separately on continuation lines too.
  const continuationIndent = ' '.repeat(stringWidth(promptPrefix))
  // No hover tooltip here, deliberately: the message is pre-wrapped so every
  // visual line is already on screen — a float would only repeat visible
  // text, and worse, the card REPLACES the cells it covers, so a drag-copy
  // crossing it yields the tooltip fragment instead of the message.
  //
  // ONE Text per visual line, no per-line row Box around the bar: a nested
  // Box per line inside a transcript row breaks the ScrollBox height floor
  // for a very tall expanded row (thousands of children), leaving the tail
  // of a folded-then-expanded prompt unreachable — see the E4/E7 checks in
  // scripts/verify-long-line-fold.tsx. The bar therefore rides the same Text
  // the prompt does, exactly like the `❯` it precedes.

  return (
    <Box
      flexDirection="column"
      marginTop={marginTopOnTurn ? 1 : 0}
      width="100%"
      backgroundColor={isSelected ? 'messageActionsBackground' : 'userPromptBackground'}
      onClick={onClick}
    >
      {lines.map((line, index) => (
        <Text key={index} color="userPromptLabel" bold wrap="truncate-end">
          {index === 0 ? barPrefix : '  '}
          {index === 0 ? promptPrefix : continuationIndent}
          {line}
        </Text>
      ))}
    </Box>
  )
}

import React from 'react'
import { Box, Text, useTerminalSize } from '../../ui.js'
import { POINTER } from '../../terminal-utils/figures.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { wrapWidth } from '../../sessions/format.js'
import { usePagePanelBleed } from '../PageMargin.js'
import type { ClickEvent } from '../../ink/events/click-event.js'

type Props = {
  text: string
  /** Adds the top margin between turns. */
  marginTopOnTurn: boolean
  /** Message-selection mode highlight. */
  isSelected?: boolean
  /** Align transcript surfaces with tool cards and the composer. */
  bleed?: boolean
  onClick?(event: ClickEvent): void
}

/**
 * Historical prompts share the composer's fill, padding rows and heavy yellow
 * rail. The continuous border remains a turn anchor even on `dark-ansi`.
 * Selection mode paints the surface in `messageActionsBackground` instead.
 */
export function UserPromptMessage({
  text,
  marginTopOnTurn,
  isSelected = false,
  bleed = false,
  onClick,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const panelBleed = usePagePanelBleed(bleed)
  const panelColumns = columns + panelBleed.left + panelBleed.right
  const promptPrefix = `${POINTER} `
  // Left border + horizontal padding + prompt prefix. Standalone consumers
  // may reserve a scrollbar outside this component without narrowing context.
  const chromeWidth = 4 + stringWidth(promptPrefix)
  // Wrap here instead of letting Ink wrap the whole Text node. Ink starts an
  // automatic continuation at column zero, while a prompt needs a hanging
  // indent for both explicit newlines and width-based visual lines.
  // Chat's bleed layout supplies the exact transcript width; standalone
  // layouts keep the existing ScrollBox safety margin. Text must not wrap a
  // second time in Ink, which would lose the continuation indent.
  const lines = wrapWidth(text, Math.max(1, panelColumns - chromeWidth - (bleed ? 0 : 3)))
  const continuationIndent = ' '.repeat(stringWidth(promptPrefix))
  // No hover tooltip here, deliberately: the message is pre-wrapped so every
  // visual line is already on screen — a float would only repeat visible
  // text, and worse, the card REPLACES the cells it covers, so a drag-copy
  // crossing it yields the tooltip fragment instead of the message.
  //
  // Keep one direct Text child per visual line. A per-line Box breaks the
  // ScrollBox height floor for very tall expanded prompts, making their tail
  // unreachable (E4/E7 in scripts/verify-long-line-fold.tsx). The outer Box
  // draws the continuous rail without adding per-line layout nodes.

  return (
    <Box
      flexDirection="column"
      marginTop={marginTopOnTurn ? 1 : 0}
      width={bleed ? panelColumns : '100%'}
      marginLeft={-panelBleed.left}
      marginRight={-panelBleed.right}
      paddingY={1}
      paddingLeft={1}
      paddingRight={2}
      borderStyle="bold"
      borderColor="userPromptLabel"
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      backgroundColor={isSelected ? 'messageActionsBackground' : 'userPromptBackground'}
      onClick={onClick}
    >
      {lines.map((line, index) => (
        <Text key={index} color="userPromptLabel" bold wrap="truncate-end">
          {index === 0 ? promptPrefix : continuationIndent}
          {line}
        </Text>
      ))}
    </Box>
  )
}

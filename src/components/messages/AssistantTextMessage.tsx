import React from 'react'
import { Box } from '../../ui.js'
import { Markdown } from '../Markdown.js'

type Props = {
  text: string
  /** Adds the top margin between messages. */
  marginTopOnTurn: boolean
  /** Message-selection mode highlight. */
  isSelected?: boolean
  /** Row expanded on its own (persistent hover-grey background). */
  isExpanded?: boolean
}

/**
 * Assistant text: markdown body at col 0, no marker, full brightness.
 *
 * The absence of chrome IS the signal — machine activity (tool cards,
 * thinking) is railed and dim at col 2, so the unmarked bright text reads as
 * the model talking. A `●` bullet here made prose and tool rows wear the same
 * leading dot at nearly the same weight, which is exactly the wall of grey
 * this layout removes.
 *
 * Deliberately not clickable: the transcript is reading material and the
 * mouse's job there is text selection (user feedback — row hover tints and
 * fold toggling were noise, not affordance).
 */
export function AssistantTextMessage({
  text,
  marginTopOnTurn,
  isSelected = false,
  isExpanded = false,
}: Props): React.ReactNode {
  return (
    <Box
      flexDirection="column"
      marginTop={marginTopOnTurn ? 1 : 0}
      width="100%"
      backgroundColor={
        isSelected
          ? 'messageActionsBackground'
          : isExpanded
            ? 'userMessageBackgroundHover'
            : undefined
      }
    >
      <Markdown>{text}</Markdown>
    </Box>
  )
}

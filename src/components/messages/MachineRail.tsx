import React from 'react'
import { Box, Text } from '../../ui.js'

/** Rail column width in terminal cells — the card content is sized against
 *  `columns - RAIL_WIDTH`, so the glyph and the arithmetic share one
 *  constant. */
export const RAIL_WIDTH = 2

/**
 * Two-column rail that prefixes MACHINE activity in the transcript — tool
 * cards, reasoning rows, subagent and job cards — against the flush-left
 * assistant prose above and below it.
 *
 * The hierarchy is the point: prose is what the model is *saying* (col 0,
 * normal brightness), the railed rows are what it is *doing* (col 2, dim).
 * Consecutive machine rows sit tight (MessageList's block-gap pre-pass), so
 * the rail reads as one continuous bracket around a step's tool calls.
 *
 * Fixed two columns, `flexShrink={0}`: the rows it prefixes size their own
 * content against the remaining width, so this column must never be squeezed
 * by a long tool title.
 */
export function MachineRail(): React.ReactNode {
  return (
    <Box width={RAIL_WIDTH} flexShrink={0}>
      <Text dimColor>{'│'}</Text>
    </Box>
  )
}

/** Source regression: node --import tsx/esm scripts/verify-copy-wrap-port.tsx */
import assert from 'node:assert/strict'
import React from 'react'
import chalk from 'chalk'
chalk.level = 3
import Box from '../src/ink/components/Box.js'
import Text from '../src/ink/components/Text.js'
import Output from '../src/ink/output.js'
import { renderToScreen } from '../src/ink/render-to-screen.js'
import { CharPool, HyperlinkPool, StylePool, createScreen, diff, resetScreen, blitRegion, shiftRows, projectCopyWrap, setCopyWrapSpan, cellAt, type Screen } from '../src/ink/screen.js'
import { createSelectionState, startSelection, updateSelection, getSelectedText, refreshSelectionFingerprint } from '../src/ink/selection.js'

function select(screen: Screen, endRow = screen.height - 1, startCol = 0, endCol = 6): string {
  const state = createSelectionState()
  startSelection(state, startCol, 0)
  updateSelection(state, endCol, endRow)
  state.fence = { colStart: startCol, colEnd: endCol }
  return getSelectedText(state, screen)
}
const styles = new StylePool()
const chars = new CharPool()
const links = new HyperlinkPool()
const source = createScreen(12, 3, styles, chars, links)
const output = new Output({ width: 12, height: 3, stylePool: styles, screen: source })
output.write(0, 0, 'aaa the\nPR.\nEND', [false, 'gap', false], undefined, 7)
output.write(9, 0, 'A\nB\nC', [false, false, false], undefined, 3)
output.get()
assert.equal(source.softWrap[1], -7)
assert.equal(source.copyWrap![12], -8)
assert.equal(source.copyWrap![21], -1)
assert.equal(select(source), 'aaa the PR.\nEND')
assert.equal(select(source, 0), 'aaa the')
assert.equal(select(source, 0, 0, 5), 'aaa th')
assert.equal(select(source, 2, 9, 11), 'A\nB\nC')
const copied = createScreen(12, 3, styles, chars, links)
blitRegion(copied, source, 0, 0, 7, 3)
projectCopyWrap(copied)
assert.equal(select(copied), 'aaa the PR.\nEND')
shiftRows(copied, 0, 2, -1, 0, 7)
projectCopyWrap(copied)
assert.equal(copied.softWrap[2], -7)
assert.equal(select(copied), '\naaa the PR.')
for (const width of [9, 11]) {
  const { screen } = renderToScreen(<Box width={width} paddingRight={2}>
    <Text continuationIndent={[2]}>- aaa the <Text bold>PR.</Text> x</Text>
  </Box>, width)
  assert.equal(select(screen, screen.height - 1, 0, width - 1), '- aaa the PR. x')
  if (width === 11) {
    assert.equal(screen.softWrap[1], -9)
    assert.notEqual(cellAt(screen, 2, 1)!.styleId, cellAt(screen, 2, 0)!.styleId)
  }
}
const watched = createSelectionState()
startSelection(watched, 0, 0)
updateSelection(watched, 6, 1)
watched.fence = { colStart: 0, colEnd: 6 }
refreshSelectionFingerprint(watched, source, false)
setCopyWrapSpan(source, 1, 0, 7, 7)
assert.equal(refreshSelectionFingerprint(watched, source, false), true, 'gap-only column provenance change invalidates a stationary selection')
console.log('PASS copy-wrap port: signed gaps, sibling hard breaks, partial selection, blit, shift and styled hanging wrap')

// IME row recovery must not blank the baseline: old glyph deletion and equal
// default-background blanks both need writes, with metadata intact until diff.
for (const nextWidth of [4, 5]) {
  const before = createScreen(4, 1, styles, chars, links)
  before.cells[0] = chars.intern('x')
  const after = createScreen(nextWidth, 1, styles, chars, links)
  before.repaintRows = new Set([0])
  after.damage = { x: 0, y: 0, width: nextWidth, height: 1 }
  const changes = diff(before, after)
  assert.equal(changes.length, 4, 'forced rows rewrite old glyphs AND equal blanks, on same-width/resize paths')
  assert.equal(cellAt(before, 0, 0)!.char, 'x', 'recovery preserves the real previous-frame baseline')
  resetScreen(before, 4, 1)
  assert.equal(before.repaintRows.size, 0, 'repaint requests do not survive buffer reuse')
}
console.log('PASS IME forced-row diff: preserved baseline, equal blanks and resize')

/** Focused source regression: node --import tsx/esm scripts/verify-hanging-wrap.tsx */
import assert from 'node:assert/strict'
import React from 'react'
import { LegacyRoot } from 'react-reconciler/constants.js'
import Text from '../src/ink/components/Text.js'
import Box from '../src/ink/components/Box.js'
import { createNode, type DOMElement } from '../src/ink/dom.js'
import { FocusManager } from '../src/ink/focus.js'
import { hangingWrap, addSyntheticIndents } from '../src/ink/hanging-wrap.js'
import wrapText from '../src/ink/wrap-text.js'
import measureText from '../src/ink/measure-text.js'
import reconciler from '../src/ink/reconciler.js'
import Output from '../src/ink/output.js'
import renderNodeToOutput from '../src/ink/render-node-to-output.js'
import { CharPool, HyperlinkPool, StylePool, createScreen, cellAt, CellWidth, type Screen } from '../src/ink/screen.js'
import { createSelectionState, startSelection, updateSelection, getSelectedText } from '../src/ink/selection.js'
import { renderToScreen } from '../src/ink/render-to-screen.js'
import { stringWidth } from '../src/ink/stringWidth.js'
import stripAnsi from 'strip-ansi'
import chalk from 'chalk'

// Headless terminals disable chalk by default; this regression inspects SGR cells.
chalk.level = 3

let checks = 0
function check(name: string, test: () => void): void {
  test()
  checks++
  console.log(`PASS ${name}`)
}
function rows(screen: Screen): string[] {
  return Array.from({ length: screen.height }, (_, y) => {
    let line = ''
    for (let x = 0; x < screen.width; x++) {
      const cell = cellAt(screen, x, y)!
      if (cell.width < CellWidth.SpacerTail) line += cell.char
    }
    return line.trimEnd()
  })
}
function copy(screen: Screen): string {
  const selection = createSelectionState()
  startSelection(selection, 0, 0)
  updateSelection(selection, screen.width - 1, screen.height - 1)
  return getSelectedText(selection, screen)
}
const fixtures = [
  { text: '- abcdefghijklmnopqrstuvwxyz0123456789', indent: 2 },
  { text: '123. abcdefghijklmnopqrstuvwxyz0123456789', indent: 5 },
  { text: '- [x] abcdefghijklmnopqrstuvwxyz0123456789', indent: 6 },
  { text: '    - abcdefghijklmnopqrstuvwxyz0123456789', indent: 6 },
  { text: '- 中文内容中文内容中文内容中文内容中文内容', indent: 2 },
]
for (const width of [1, 2, 8, 20, 55]) {
  for (const { text, indent } of fixtures) {
    check(`helper + Text width=${width} indent=${indent} ${text.slice(0, 8)}`, () => {
      const result = hangingWrap(text, width, 'wrap', [indent])
      const physical = addSyntheticIndents(result.wrapped, result.syntheticIndents)
      assert.equal(result.wrapped.replaceAll('\n', ''), text)
      assert.equal(result.softWrap?.[0], false)
      for (const line of physical.split('\n')) assert.ok(stringWidth(line) <= Math.max(width, 2))
      if (width <= indent) {
        assert.equal(result.wrapped, wrapText(text, width, 'wrap'))
        assert.ok(result.syntheticIndents.every(i => i === 0))
      }
      const actual = renderToScreen(<Text continuationIndent={[indent]}>{text}</Text>, width)
      assert.equal(actual.height, measureText(physical, Infinity).height)
      if (width === 1 && /[\u4e00-\u9fff]/.test(text)) {
        // A two-cell glyph cannot paint in a one-cell legacy output buffer.
        const legacy = renderToScreen(<Text>{text}</Text>, width)
        assert.deepEqual(rows(actual.screen), rows(legacy.screen))
        assert.equal(copy(actual.screen), copy(legacy.screen))
      } else {
        assert.deepEqual(rows(actual.screen), physical.split('\n').map(s => s.trimEnd()))
        assert.equal(copy(actual.screen), text)
      }
      result.syntheticIndents.forEach((i, row) => {
        for (let col = 0; col < i; col++) assert.equal(actual.screen.noSelect[row * width + col], 1)
        if (i < width) assert.equal(actual.screen.noSelect[row * width + i], 0)
      })
    })
  }
}
check('logical source provenance and ordinary lines', () => {
  const text = '- abcdefghijklmnop\nordinary abcdefghijklmnop\n  - nestedabcdefghijk'
  const result = hangingWrap(text, 8, 'wrap', [2, 0, 4])
  const actual = renderToScreen(<Text continuationIndent={[2, 0, 4]}>{text}</Text>, 8)
  assert.equal(copy(actual.screen), text)
  assert.equal(result.softWrap!.filter(flag => !flag).length, 3)
  assert.deepEqual(rows(actual.screen), addSyntheticIndents(result.wrapped, result.syntheticIndents).split('\n').map(s => s.trimEnd()))
})
check('ANSI and OSC helper preserve visible source', () => {
  const source = '\x1b[31m- \x1b[0m\x1b]8;;https://example.test\x07中文abcdefghijk\x1b]8;;\x07'
  for (const width of [1, 2, 8, 20, 55]) {
    const result = hangingWrap(source, width, 'wrap', [2])
    assert.equal(stripAnsi(result.wrapped).replaceAll('\n', ''), stripAnsi(source))
    assert.equal(result.syntheticIndents.length, result.wrapped.split('\n').length)
  }
})
check('multi-segment ANSI styles and OSC restore before synthetic cells', () => {
  const actual = renderToScreen(
    <Text continuationIndent={[2]}>- <Text color="ansi:red">abcdef</Text><ink-link href="https://example.test"><Text bold>ghijklmnopqrst</Text></ink-link></Text>, 8,
  )
  assert.equal(copy(actual.screen), '- abcdefghijklmnopqrst')
  assert.deepEqual(rows(actual.screen), ['- abcdef', '  ghijkl', '  mnopqr', '  st'])
  const red = cellAt(actual.screen, 2, 0)!
  const linked = cellAt(actual.screen, 2, 1)!
  assert.notEqual(red.styleId, linked.styleId)
  assert.equal(linked.hyperlink, 'https://example.test')
  for (let row = 1; row < actual.height; row++) {
    assert.equal(cellAt(actual.screen, 0, row)!.hyperlink, undefined)
    assert.equal(actual.screen.noSelect[row * 8], 1)
  }
})
check('raw ANSI OSC Text paint and copy', () => {
  const text = '- \x1b[31m\x1b]8;;https://example.test\x07中文abcdefghijk\x1b]8;;\x07\x1b[0m'
  for (const width of [1, 2, 8, 20, 55]) {
    const actual = renderToScreen(<Text continuationIndent={[2]}>{text}</Text>, width)
    if (width === 1) {
      const legacy = renderToScreen(<Text>{text}</Text>, width)
      assert.deepEqual(rows(actual.screen), rows(legacy.screen))
      assert.equal(copy(actual.screen), copy(legacy.screen))
    } else assert.equal(copy(actual.screen), stripAnsi(text))
    for (let y = 0; y < actual.height; y++) {
      for (let x = 0; x < width; x++) {
        const cell = cellAt(actual.screen, x, y)!
        if (/[a-z中]/.test(cell.char)) assert.equal(cell.hyperlink, 'https://example.test')
      }
    }
  }
})
check('wrap-trim and truncate opt-in', () => {
  for (const wrap of ['wrap-trim', 'truncate', 'truncate-middle', 'truncate-start'] as const) {
    const text = '- abcdefghijklmnopqrstuvwxyz'
    const result = hangingWrap(text, 8, wrap, [2])
    const actual = renderToScreen(<Text wrap={wrap} continuationIndent={[2]}>{text}</Text>, 8)
    assert.deepEqual(rows(actual.screen), addSyntheticIndents(result.wrapped, result.syntheticIndents).split('\n').map(s => s.trimEnd()))
    if (wrap !== 'wrap-trim') assert.ok(result.syntheticIndents.every(i => i === 0))
  }
})
check('actual Yoga content width, not outer terminal width', () => {
  let node: DOMElement | null = null
  const text = '- abcdefghijklmnopqrstuvwxyz'
  const actual = renderToScreen(<Box width={20} paddingLeft={2} paddingRight={3}><Text ref={value => { node = value }} continuationIndent={[2]}>{text}</Text></Box>, 55)
  const expected = hangingWrap(text, 15, 'wrap', [2])
  assert.equal(actual.height, expected.syntheticIndents.length)
  assert.deepEqual(rows(actual.screen), addSyntheticIndents(expected.wrapped, expected.syntheticIndents).split('\n').map(s => '  ' + s.trimEnd()))
  assert.equal(node, null) // renderToScreen releases its source tree.
})
check('persistent Text metadata-only rerender, removal, resize and cached repaint', () => {
  const root = createNode('ink-root')
  root.focusManager = new FocusManager(() => false)
  const fail = (error: unknown) => { throw error }
  // @ts-ignore runtime reconciler uses ten arguments
  const container = reconciler.createContainer(root, LegacyRoot, null, false, null, 'hanging-test', fail, fail, fail, fail)
  const styles = new StylePool()
  const chars = new CharPool()
  const links = new HyperlinkPool()
  let node: DOMElement | null = null
  const ref = (value: DOMElement | null) => { node = value }
  const text = '- abcdefghijklmnopqrstuvwxyz0123456789'
  const paint = (width: number, metadata: readonly number[] | undefined, update = true) => {
    if (update) {
      // @ts-ignore source runtime exposes sync updates
      reconciler.updateContainerSync(<Text ref={ref} continuationIndent={metadata}>{text}</Text>, container, null, () => {})
      // @ts-ignore source runtime exposes sync flush
      reconciler.flushSyncWork()
    }
    root.yogaNode!.setWidth(width)
    root.yogaNode!.calculateLayout(width)
    const height = root.yogaNode!.getComputedHeight()
    const screen = createScreen(width, height, styles, chars, links)
    const output = new Output({ width, height, stylePool: styles, screen })
    renderNodeToOutput(root, output, { prevScreen: undefined })
    return { screen: output.get(), height, node }
  }
  const ordinary = paint(8, undefined)
  const metadata = [2] as const
  const hanging = paint(8, metadata)
  assert.equal(hanging.node, ordinary.node)
  assert.ok(hanging.height > ordinary.height)
  assert.equal(copy(hanging.screen), text)
  assert.deepEqual(rows(paint(8, metadata, false).screen), rows(hanging.screen))
  assert.equal(copy(paint(20, metadata, false).screen), text)
  const removed = paint(8, undefined)
  assert.equal(removed.height, ordinary.height)
  assert.deepEqual(rows(removed.screen), rows(ordinary.screen))
  assert.ok(removed.screen.noSelect.every(i => i === 0))
  // @ts-ignore source runtime exposes sync updates
  reconciler.updateContainerSync(null, container, null, () => {})
  // @ts-ignore source runtime exposes sync flush
  reconciler.flushSyncWork()
})
check('60k single Text retains tail and source copy', () => {
  const text = '- ' + 'x'.repeat(60_000) + 'TAIL_7F31'
  const result = hangingWrap(text, 55, 'wrap', [2])
  const actual = renderToScreen(<Text continuationIndent={[2]}>{text}</Text>, 55)
  assert.equal(actual.height, result.syntheticIndents.length)
  assert.ok(rows(actual.screen).at(-1)!.endsWith('TAIL_7F31'))
  assert.equal(copy(actual.screen), text)
})
check('ordinary Text remains unchanged and helper does not accept negative body widths', () => {
  for (const width of [1, 2, 8, 20, 55]) {
    const text = 'ordinary abcdefghijklmnopqrstuvwxyz'
    assert.deepEqual(rows(renderToScreen(<Text>{text}</Text>, width).screen), wrapText(text, width, 'wrap').split('\n').map(s => s.trimEnd()))
    for (const indent of [0, -1, NaN, Infinity, 999]) {
      const result = hangingWrap(text, width, 'wrap', [indent])
      assert.equal(result.wrapped, wrapText(text, width, 'wrap'))
      assert.ok(result.syntheticIndents.every(i => i === 0))
    }
    assert.ok(stringWidth(text) > 0)
  }
})
check('empty opt-in Text paints safely', () => {
  const actual = renderToScreen(<Text continuationIndent={[2]}>{''}</Text>, 8)
  const legacy = renderToScreen(<Text>{''}</Text>, 8)
  assert.deepEqual(rows(actual.screen), rows(legacy.screen))
  assert.equal(copy(actual.screen), copy(legacy.screen))
})
console.log(`PASS ${checks} hanging-wrap checks`)

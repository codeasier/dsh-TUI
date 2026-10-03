/** Markdown hanging-indent integration: node --import tsx/esm scripts/verify-markdown-hanging.tsx */
await import('./lib/fake-home.mjs')
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_THEME = 'dark'

const [React, { default: assert }, { PassThrough, Writable }, { Box, render }, { Markdown }, { StreamingMarkdown }, { default: ScrollBox }, { renderToScreen, scanPositions }, { cellAt, CellWidth }, { createSelectionState, startSelection, updateSelection, getSelectedText }, { default: instances }, { settled }] = await Promise.all([
  import('react'), import('node:assert/strict'), import('node:stream'), import('../src/ui.js'),
  import('../src/components/Markdown.js'), import('../src/components/StreamingMarkdown.js'),
  import('../src/ink/components/ScrollBox.js'), import('../src/ink/render-to-screen.js'),
  import('../src/ink/screen.js'), import('../src/ink/selection.js'), import('../src/ink/instances.js'),
  import('./lib/term-test.mjs'),
])
import type { ScrollBoxHandle } from '../src/ink/components/ScrollBox.js'
import type { Frame } from '../src/ink/frame.js'
import type { Screen } from '../src/ink/screen.js'

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
function assertIndentBackground(screen: Screen): void {
  // At the long list's tail this body cell is plain CJK text, carrying only
  // the inherited background; compare synthetic cells to that painted surface.
  const canvasStyle = cellAt(screen, 12, 0)!.styleId
  assert.notEqual(canvasStyle, 0, 'the scrolling probe has a non-default background')
  let syntheticCells = 0
  for (let y = 0; y < screen.height; y++) {
    for (let x = 0; x < screen.width; x++) {
      if (screen.noSelect[y * screen.width + x] !== 1) continue
      syntheticCells++
      assert.equal(cellAt(screen, x, y)!.styleId, canvasStyle, `cached/scrolling indent at ${x},${y} keeps the canvas`)
    }
  }
  assert.ok(syntheticCells > 0, 'the scrolling probe includes wrapped continuation cells')
}
function copy(screen: Screen): string {
  const selection = createSelectionState()
  startSelection(selection, 0, 0)
  updateSelection(selection, screen.width - 1, screen.height - 1)
  return getSelectedText(selection, screen)
}
for (const Component of [Markdown, StreamingMarkdown]) {
  const actual = renderToScreen(<Component>{'- abcdefghijklmn'}</Component>, 8)
  assert.deepEqual(rows(actual.screen), ['- abcdef', '  ghijkl', '  mn'])
  assert.equal(copy(actual.screen), '- abcdefghijklmn')
  const constrained = renderToScreen(<Box width={12} paddingLeft={2}><Component>{'- abcdefghijklmn'}</Component></Box>, 40)
  assert.deepEqual(rows(constrained.screen), ['  - abcdefgh', '    ijklmn'])
  const task = renderToScreen(<Component>{'- [x] abcdefghijkl'}</Component>, 12)
  assert.deepEqual(rows(task.screen), ['- [\u2713] abcdef', '      ghijkl'])
  assert.equal(copy(task.screen), '- [\u2713] abcdefghijkl')
  const quote = renderToScreen(<Component>{'- > - abcdefghijkl'}</Component>, 12)
  assert.deepEqual(rows(quote.screen), ['- \u258e - abcdef', '      ghijkl'])
  assert.equal(copy(quote.screen), '- \u258e - abcdefghijkl')
  const plain = renderToScreen(<Component>{'abcdefghijklmn'}</Component>, 8)
  assert.deepEqual(rows(plain.screen), ['abcdefgh', 'ijklmn'])

  const nested = '- parent\n  - **abcdefghij** [klmnopqrstuvwxyz](https://example.test)\n  - [x] abcdefghijklmnopqrstuvwxyz'
  const unfilled = renderToScreen(<Box paddingLeft={2}><Component>{nested}</Component></Box>, 16)
  const expectedCopy = copy(unfilled.screen)
  for (const backgroundColor of ['#191919', '#F2F2F2'] as const) {
    const filled = renderToScreen(<Box paddingLeft={2} backgroundColor={backgroundColor}><Component>{nested}</Component></Box>, 16)
    const canvasStyle = cellAt(filled.screen, 0, 0)!.styleId
    assert.notEqual(canvasStyle, 0, 'the probe must paint a non-default parent background')
    let syntheticCells = 0
    for (let y = 0; y < filled.height; y++) {
      for (let x = 0; x < filled.screen.width; x++) {
        if (filled.screen.noSelect[y * filled.screen.width + x] !== 1) continue
        syntheticCells++
        const indent = cellAt(filled.screen, x, y)!
        assert.equal(indent.char, ' ')
        assert.equal(indent.styleId, canvasStyle, `synthetic indent at ${x},${y} inherits ${backgroundColor}`)
        assert.equal(indent.hyperlink, undefined, 'indent does not inherit the list body hyperlink')
      }
    }
    assert.ok(syntheticCells > 4, 'nested and task list continuations must be exercised')
    assert.equal(copy(filled.screen), expectedCopy, 'background inheritance leaves source copy unchanged')
  }
}

class Input extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  isTTY = true
  columns = 40
  rows = 12
  _write(_chunk: unknown, _encoding: BufferEncoding, done: () => void) { done() }
}
const stdout = new Output()
let scroll: ScrollBoxHandle | null = null
const full = '- [x] ' + '\u6587'.repeat(30_000) + 'TAIL_7F31'
const tree = (text: string, backgroundColor: '#191919' | '#F2F2F2' = '#191919') => <Box height={10} backgroundColor={backgroundColor} flexDirection="column"><ScrollBox flexDirection="column" flexGrow={1} ref={value => { scroll = value }}><Markdown>{text}</Markdown></ScrollBox></Box>
const app = await render(tree(full), {
  stdout: stdout as unknown as NodeJS.WriteStream,
  stdin: new Input() as unknown as NodeJS.ReadStream,
  stderr: new Output() as unknown as NodeJS.WriteStream,
  patchConsole: false, exitOnCtrlC: false,
})
const ink = instances.get(stdout as unknown as NodeJS.WriteStream) as unknown as { frontFrame: Frame }
try {
  assert.ok(await settled(() => scroll !== null && scroll.getScrollHeight() > 1000), 'long task list has its full scroll height')
  scroll!.scrollToBottom()
  assert.ok(await settled(() => (copy(ink.frontFrame.screen).match(/TAIL_7F31/g) ?? []).length === 1), 'long task-list tail is reachable exactly once')
  assertIndentBackground(ink.frontFrame.screen)
  scroll!.scrollBy(-1)
  assert.ok(await settled(() => !copy(ink.frontFrame.screen).includes('TAIL_7F31')), 'one-row scroll repaints the clipped continuation edge')
  assertIndentBackground(ink.frontFrame.screen)
  scroll!.scrollToBottom()
  assert.ok(await settled(() => copy(ink.frontFrame.screen).includes('TAIL_7F31')), 'scrolling back restores the tail')
  assertIndentBackground(ink.frontFrame.screen)
  const darkStyle = cellAt(ink.frontFrame.screen, 0, 0)!.styleId
  app.rerender(tree(full, '#F2F2F2'))
  assert.ok(await settled(() => cellAt(ink.frontFrame.screen, 0, 0)!.styleId !== darkStyle), 'parent background swap reaches the rendered frame')
  assertIndentBackground(ink.frontFrame.screen)
  app.rerender(tree('- short'))
  assert.ok(await settled(() => scanPositions(ink.frontFrame.screen, 'short').length === 1), 'collapsed list replaces the tall row')
  app.rerender(tree(full))
  assert.ok(await settled(() => scroll !== null && scroll.getScrollHeight() > 1000), 'expanded list recovers its full height')
  scroll!.scrollToBottom()
  assert.ok(await settled(() => (copy(ink.frontFrame.screen).match(/TAIL_7F31/g) ?? []).length === 1), 'expanded list tail stays reachable')
  assertIndentBackground(ink.frontFrame.screen)
  stdout.columns = 55
  stdout.emit('resize')
  assert.ok(await settled(() => ink.frontFrame.screen.width === 55 && (copy(ink.frontFrame.screen).match(/TAIL_7F31/g) ?? []).length === 1), 'wider resize retains the sticky tail')
  // Rapid reverse resize is also dropped by the legacy Text runtime.
  // Verify narrow geometry in a fresh root rather than reading a stale wide frame.
} finally {
  await app.unmount()
}
const narrowStdout = new Output()
const narrowApp = await render(tree(full), {
  stdout: narrowStdout as unknown as NodeJS.WriteStream,
  stdin: new Input() as unknown as NodeJS.ReadStream,
  stderr: new Output() as unknown as NodeJS.WriteStream,
  patchConsole: false, exitOnCtrlC: false,
})
const narrowInk = instances.get(narrowStdout as unknown as NodeJS.WriteStream) as unknown as { frontFrame: Frame }
try {
  assert.ok(await settled(() => scroll !== null && scroll.getScrollHeight() > 1000))
  scroll!.scrollToBottom()
  assert.ok(await settled(() => narrowInk.frontFrame.screen.width === 40 && (copy(narrowInk.frontFrame.screen).match(/TAIL_7F31/g) ?? []).length === 1), 'fresh narrow root preserves the task-list tail')
} finally {
  await narrowApp.unmount()
}
console.log('Markdown hanging integration passed: nested backgrounds, cached/scrolling indents, background swap, actual width, copy, streaming, 60k scroll tail and resize')

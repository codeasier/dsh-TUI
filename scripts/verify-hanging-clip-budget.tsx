/** Source regression: node --import tsx/esm scripts/verify-hanging-clip-budget.tsx
 * Also imported by the existing render-scroll verify-hanging-wrap CI entry.
 * Arithmetic ASCII oracles and operation/read counts avoid timing thresholds.
 */
await import('./lib/fake-home.mjs')
process.env.FORCE_COLOR = '0'
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_THEME = 'dark'

import type { DOMElement } from '../src/ink/dom.js'
import type { Clip, Operation } from '../src/ink/output.js'
import type { Rectangle } from '../src/ink/layout/geometry.js'
import type { Frame } from '../src/ink/frame.js'
import type { Screen } from '../src/ink/screen.js'
import type { ScrollBoxHandle } from '../src/ink/components/ScrollBox.js'
import type { ReactNode } from 'react'

const [{ default: assert }, { default: React }, { LegacyRoot }, dom, { default: Output },
  { default: renderNode }, { default: createRenderer }, screenApi, { textPaintCache },
  { default: reconciler }, { FocusManager }, { default: Box }, { default: Text },
  { default: ScrollBox }, { AssistantTextMessage }, { StreamingMarkdown }, selectionApi,
  { Markdown }, { renderToScreen }, { TerminalSizeContext }, { applyMarkdown }, { default: stripAnsi },
] = await Promise.all([
  import('node:assert/strict'), import('react'), import('react-reconciler/constants.js'),
  import('../src/ink/dom.js'), import('../src/ink/output.js'),
  import('../src/ink/render-node-to-output.js'), import('../src/ink/renderer.js'),
  import('../src/ink/screen.js'), import('../src/ink/node-cache.js'),
  import('../src/ink/reconciler.js'), import('../src/ink/focus.js'),
  import('../src/ink/components/Box.js'), import('../src/ink/components/Text.js'),
  import('../src/ink/components/ScrollBox.js'), import('../src/components/messages/AssistantTextMessage.js'),
  import('../src/components/StreamingMarkdown.js'), import('../src/ink/selection.js'),
  import('../src/components/Markdown.js'), import('../src/ink/render-to-screen.js'),
  import('../src/ink/components/TerminalSizeContext.js'), import('../src/terminal-utils/markdown.js'), import('strip-ansi'),
])
const { createNode, createTextNode, appendChildNode, setStyle, setAttribute } = dom
const { StylePool, CharPool, HyperlinkPool, createScreen, cellAt } = screenApi
const { createSelectionState, startSelection, updateSelection, getSelectedText } = selectionApi
const operations = (output: InstanceType<typeof Output>): Operation[] => Reflect.get(output, 'operations')
const masks = (output: InstanceType<typeof Output>) => operations(output).filter(op => op.type === 'noSelect')
const copy = (screen: Screen, top = 0, bottom = screen.height - 1) => {
  const selection = createSelectionState()
  startSelection(selection, 0, top)
  updateSelection(selection, screen.width - 1, bottom)
  return getSelectedText(selection, screen)
}
const row = (screen: Screen, y: number) => Array.from({ length: screen.width }, (_, x) => cellAt(screen, x, y)!.char).join('').trimEnd()

let calls = 0
const originalNoSelect = Output.prototype.noSelect
Output.prototype.noSelect = function (region: Rectangle) {
  calls++
  originalNoSelect.call(this, region)
}

// Observe the private, node-owned metadata at preparation time without adding
// a production test API. The prototype interception lasts only for cold paint;
// its array proxy then counts actual indexed traversal on warm paints.
function observeIndents(node: DOMElement, coldPaint: () => void): () => number {
  let reads = 0
  let found = false
  const originalSet = WeakMap.prototype.set
  WeakMap.prototype.set = function (key: object, value: unknown) {
    if (key === node && typeof value === 'object' && value !== null &&
      'syntheticIndents' in value && Array.isArray(value.syntheticIndents)) {
      found = true
      value.syntheticIndents = new Proxy(value.syntheticIndents, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) reads++
          return Reflect.get(target, key, receiver)
        },
      })
    }
    return originalSet.call(this, key, value)
  }
  try { coldPaint() } finally { WeakMap.prototype.set = originalSet }
  assert.ok(found, 'cold paint must prepare hanging metadata')
  reads = 0
  return () => reads
}

try {
  for (const width of [8, 20, 55]) for (const Component of [Markdown, StreamingMarkdown]) {
    const source = '```ts title=示例.ts\nconst message = "中文"\n```'
    const actual = renderToScreen(<TerminalSizeContext.Provider value={{ columns: width, rows: 24 }}>
      <Component>{source}</Component>
    </TerminalSizeContext.Provider>, width)
    assert.equal(copy(actual.screen), stripAnsi(applyMarkdown(source)),
      `CJK code caption width=${width}: source-owned separator survives without out-of-source padding`)
  }
  for (const first of ['ABCD ', 'ABCD  ']) {
    const styles = new StylePool()
    const screen = createScreen(12, 2, styles, new CharPool(), new HyperlinkPool())
    const output = new Output({ width: 12, height: 2, stylePool: styles, screen })
    output.write(0, 0, first + '\nEF', [false, true], undefined, 8)
    output.get()
    assert.equal(copy(screen), first + 'EF', 'one/two real source spaces survive while unowned trailing padding does not')
    const selected = createSelectionState()
    startSelection(selected, 0, 0)
    updateSelection(selected, 11, 1)
    selectionApi.refreshSelectionFingerprint(selected, screen, false)
    screen.copyWrap![8] = -1
    assert.equal(copy(screen), first + ' EF', 'a genuinely owned extra source space is not stripped')
    assert.equal(selectionApi.refreshSelectionFingerprint(selected, screen, false), true,
      'changing trailing blank ownership changes copy bytes and trips the stale guard')
    screen.copyWrap![8] = 0
    screenApi.markCopyRegion(screen, 10, 0, 2, 1, '$M$', 901)
    assert.equal(copy(screen), first + '  $M$EF', 'deferred gaps commit before a following copy-region insertion offset')
    output.write(10, 0, 'GP\nGP', undefined, undefined, 2)
    output.get()
    assert.equal(copy(screen), first + '  GP\nEF' + ' '.repeat(8) + 'GP',
      'unowned gaps before a later selectable pane are preserved, not blanket-trimmed')
  }
  console.log('PASS CJK code caption and source-owned/unowned padding boundary oracles')
  for (const length of [60_000, 600_000]) {
    const node = createNode('ink-text')
    const leaf = createTextNode('- ' + 'x'.repeat(length))
    appendChildNode(node, leaf)
    setStyle(node, { textWrap: 'wrap', flexShrink: 0 })
    setAttribute(node, 'continuationIndent', [2])
    node.yogaNode!.setWidth(60)
    node.yogaNode!.calculateLayout(60)
    // Independent oracle: N ASCII body cells / (60 - 2) body cells per row.
    const expectedRows = Math.ceil(length / 58)
    assert.equal(node.yogaNode!.getComputedHeight(), expectedRows)
    const styles = new StylePool()
    const chars = new CharPool()
    const links = new HyperlinkPool()
    const paint = (y: number, clips: Partial<Clip>[] = []) => {
      const screen = createScreen(60, 12, styles, chars, links)
      const output = new Output({ width: 60, height: 12, stylePool: styles, screen })
      for (const clip of clips) output.clip(clip as Clip)
      calls = 0
      renderNode(node, output, { offsetY: y, prevScreen: undefined })
      for (const _clip of clips) output.unclip()
      const queued = masks(output)
      let typeReads = 0
      for (const op of queued) Object.defineProperty(op, 'type', {
        get() { typeReads++; return 'noSelect' },
      })
      output.get()
      return { screen, queued, calls, typeReads }
    }
    try {
      const indentReads = observeIndents(node, () => { paint(0) })
      const prepared = textPaintCache.get(node)!
      let sourceReads = 0
      const source = leaf.nodeValue
      Object.defineProperty(leaf, 'nodeValue', { get() { sourceReads++; return source } })
      let lineReads = 0
      prepared.lines = new Proxy(prepared.lines, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) lineReads++
          return Reflect.get(target, key, receiver)
        },
      })
      const before = indentReads()
      const warm = paint(-1)
      assert.equal(textPaintCache.get(node), prepared)
      assert.equal(sourceReads, 0)
      assert.equal(lineReads, 13, '12 visible rows plus one copy-join predecessor')
      assert.equal(indentReads() - before, 12, 'traversal itself must be viewport-bounded')
      assert.equal(warm.calls, 12)
      assert.equal(warm.queued.length, 12)
      assert.equal(warm.typeReads, 36, 'all three operation passes remain viewport-bounded')
      assert.equal(copy(warm.screen), 'x'.repeat(12 * 58), 'soft wraps join without synthetic spaces')
      console.log(`PASS ASCII ${length}: rows=${expectedRows}, indentReads=12, calls=12, queue=12, sourceReads=0, preparedLineReads=13`)
      for (const test of [
        { clips: [{ x1: 0, x2: 60, y1: 0, y2: 12 }, { x1: 1, x2: 59, y1: 2, y2: 10 }], top: 2, bottom: 10, left: 1, right: 2 },
        { clips: [{ y1: 4 }], top: 4, bottom: 12, left: 0, right: 2 },
        { clips: [{ y2: 4 }], top: 0, bottom: 4, left: 0, right: 2 },
        { clips: [{ x1: 1 }], top: 0, bottom: 12, left: 1, right: 2 },
        { clips: [{ x2: 1 }], top: 0, bottom: 12, left: 0, right: 1 },
        { clips: [{ y1: 8 }, { y2: 4 }], top: 0, bottom: 0, left: 0, right: 0 },
        { clips: [{ x1: 40 }, { x2: 20 }], top: 0, bottom: 0, left: 0, right: 0 },
      ]) {
        const before = indentReads()
        const actual = paint(-100, test.clips)
        assert.equal(indentReads() - before, test.bottom - test.top)
        assert.equal(actual.queued.length, test.bottom - test.top)
        for (let y = 0; y < 12; y++) for (let x = 0; x < 60; x++) {
          const expected = y >= test.top && y < test.bottom && x >= test.left && x < test.right ? 1 : 0
          assert.equal(actual.screen.noSelect[y * 60 + x], expected, 'nested/single-sided/empty clip mask cells')
        }
      }
    } finally { node.yogaNode!.freeRecursive() }
  }

  // noSelect is also used by boxes/images: clip at enqueue, then apply LAST.
  for (const clips of [
    [], [{ x1: 1 }], [{ x2: 1 }], [{ y1: 4 }], [{ y2: 4 }],
    [{ x1: 1, y1: 4 }], [{ x2: 1, y2: 4 }],
    [{ x1: 1, x2: 5, y1: 2, y2: 10 }, { x2: 3, y2: 8 }],
    [{ y1: 8 }, { y2: 4 }], [{ x1: 5 }, { x2: 1 }],
  ] as Partial<Clip>[][]) {
    const styles = new StylePool()
    const screen = createScreen(6, 12, styles, new CharPool(), new HyperlinkPool())
    const output = new Output({ width: 6, height: 12, stylePool: styles, screen })
    for (const clip of clips) output.clip(clip as Clip)
    output.noSelect({ x: -1, y: -1, width: 3, height: 14 })
    for (const _clip of clips) output.unclip()
    const left = Math.max(0, ...clips.map(c => c.x1 ?? 0))
    const right = Math.min(2, ...clips.map(c => c.x2 ?? 6))
    const top = Math.max(0, ...clips.map(c => c.y1 ?? 0))
    const bottom = Math.min(12, ...clips.map(c => c.y2 ?? 12))
    assert.equal(masks(output).length, left < right && top < bottom ? 1 : 0, 'empty masks never enter the queue')
    // Later unclipped paints and a blit cannot erase the already clipped mask.
    output.blit(createScreen(6, 12, styles, screen.charPool, screen.hyperlinkPool), 0, 0, 6, 12)
    output.write(0, 0, Array(12).fill('ABCDEF').join('\n'))
    output.get()
    for (let y = 0; y < 12; y++) for (let x = 0; x < 6; x++) {
      assert.equal(screen.noSelect[y * 6 + x], x >= left && x < right && y >= top && y < bottom ? 1 : 0)
    }
    output.clip({ x1: 0, x2: 0, y1: 0, y2: 0 })
    const resized = createScreen(4, 3, styles, screen.charPool, screen.hyperlinkPool)
    output.reset(4, 3, resized)
    output.noSelect({ x: 0, y: 0, width: 4, height: 3 })
    output.get()
    assert.ok(resized.noSelect.every(value => value === 1), 'reset clears clip and old operation state')
  }
  console.log('PASS Output masks: enqueue intersection, empty queue, final paint order, reset/resize')

  // ScrollBox supplies column bounds even when its viewport spans the screen.
  // That is a whole-row shift: hard/soft copy boundaries must move with cells.
  // A genuinely narrower scope must still preserve the stationary flank state.
  for (const delta of [1, -1, 5]) {
    for (const [columnX, columnWidth] of [[0, 6], [undefined, 6], [0, undefined], [1, 4]]) {
      const styles = new StylePool()
      const chars = new CharPool()
      const links = new HyperlinkPool()
      const source = createScreen(6, 5, styles, chars, links)
      const seed = new Output({ width: 6, height: 5, stylePool: styles, screen: source })
      seed.write(0, 0, '- abcd\n  ef\n- ghij\n  kl\nEND', [false, true, false, true, false])
      seed.noSelect({ x: 0, y: 1, width: 2, height: 1 })
      seed.noSelect({ x: 0, y: 3, width: 2, height: 1 })
      seed.get()
      const screen = createScreen(6, 5, styles, chars, links)
      const output = new Output({ width: 6, height: 5, stylePool: styles, screen })
      output.blit(source, 0, 0, 6, 5)
      output.shift(0, 4, delta, columnX, columnWidth)
      output.get()
      const partial = columnX === 1
      for (let y = 0; y < 5; y++) {
        const oldY = y + delta
        const visible = oldY >= 0 && oldY < 5
        if (!partial) assert.equal(screen.softWrap[y], visible ? source.softWrap[oldY] : 0,
          'full-width scope moves/clears copy boundaries')
        for (let x = 0; x < 6; x++) {
          const flank = partial && (x === 0 || x === 5)
          const expectedY = flank ? y : oldY
          const inBounds = expectedY >= 0 && expectedY < 5
          if (partial) assert.equal(Math.max(0, screen.copyWrap![y * 6 + x]!), inBounds ? source.softWrap[expectedY] : 0,
            'active-column copy boundaries move; stationary flanks retain their own provenance')
          assert.equal(cellAt(screen, x, y)!.char, inBounds ? cellAt(source, x, expectedY)!.char : ' ')
          assert.equal(screen.noSelect[y * 6 + x], inBounds ? source.noSelect[expectedY * 6 + x] : 0)
        }
      }
    }
  }
  console.log('PASS Output shifts: full-width wrap boundaries and partial-column flank preservation')

  // Exercise applyPaddingToText's child layout offset, not just an ancestor y.
  const padded = createNode('ink-text')
  const paddedLeaf = createTextNode('- ' + 'x'.repeat(1000))
  appendChildNode(padded, paddedLeaf)
  setAttribute(padded, 'continuationIndent', [2])
  padded.yogaNode!.setWidth(60)
  padded.yogaNode!.calculateLayout(60)
  const paddingLayout = createNode('ink-box').yogaNode!
  paddingLayout.getComputedLeft = () => 3
  paddingLayout.getComputedTop = () => 2
  paddedLeaf.yogaNode = paddingLayout
  try {
    const styles = new StylePool()
    const screen = createScreen(60, 12, styles, new CharPool(), new HyperlinkPool())
    const output = new Output({ width: 60, height: 12, stylePool: styles, screen })
    output.clip({ x1: 4, x2: 60, y1: 1, y2: 4 })
    const reads = observeIndents(padded, () => { renderNode(padded, output, { offsetY: -2, prevScreen: undefined }) })
    output.get()
    output.reset(60, 12, screen)
    output.clip({ x1: 4, x2: 60, y1: 1, y2: 4 })
    renderNode(padded, output, { offsetY: -2, prevScreen: undefined })
    output.unclip()
    output.get()
    assert.equal(reads(), 3, 'padding-adjusted warm window traverses exactly three rows')
    assert.equal(masks(output).length, 3)
    for (let y = 0; y < 12; y++) for (let x = 0; x < 60; x++) {
      assert.equal(screen.noSelect[y * 60 + x], y >= 1 && y < 4 && x === 4 ? 1 : 0)
    }
  } finally {
    paddedLeaf.yogaNode = undefined
    paddingLayout.freeRecursive()
    padded.yogaNode!.freeRecursive()
  }
  console.log('PASS padding + negative y masks')

  // Column consumers must use the same own-row join and next-row clamp.
  // A selectable right sibling is copied too; an excluded pane can still be
  // copied by a pane-origin gesture, using its independent hard boundaries.
  for (const excluded of [false, true]) for (const paneFirst of [false, true]) {
    for (const [first, second, logical] of [['ABCD ', 'EF', 'ABCD EF'], ['中中 ', '文', '中中 文']]) {
      const styles = new StylePool()
      const screen = createScreen(8, 2, styles, new CharPool(), new HyperlinkPool())
      const output = new Output({ width: 8, height: 2, stylePool: styles, screen })
      const left = () => output.write(0, 0, first + '\n' + second, [false, true], undefined, 6)
      const right = () => output.write(6, 0, 'GP\nGP', undefined, undefined, 2)
      if (paneFirst) { right(); left() } else { left(); right() }
      if (excluded) output.noSelect({ x: 6, y: 0, width: 2, height: 2 })
      output.get()
      assert.equal(copy(screen), excluded ? logical : first + 'GP\n' + second + ' '.repeat(4) + 'GP',
        'own-row joining and next-row clamping never discard selectable right glyphs or word separators')
      if (excluded) {
        const pane = createSelectionState()
        startSelection(pane, 6, 0, screen)
        updateSelection(pane, 7, 1)
        assert.equal(getSelectedText(pane, screen), 'GP\nGP', 'pane-origin copy uses pane hard breaks, not Chat wraps')
        const chat = createSelectionState()
        startSelection(chat, 0, 0)
        updateSelection(chat, 7, 1)
        selectionApi.refreshSelectionFingerprint(chat, screen, false)
        screen.copyWrap!.fill(9, 6, 8)
        assert.equal(selectionApi.refreshSelectionFingerprint(chat, screen, false), false,
          'excluded-pane metadata changes cannot stale unchanged Chat text')
        screen.copyWrap!.fill(4, 8, 14)
        assert.equal(selectionApi.refreshSelectionFingerprint(chat, screen, false), true,
          'next-row column clamp changing word-separator copy latches stale')
      }
      if (first === '中中 ') {
        const clipped = createScreen(8, 2, styles, screen.charPool, screen.hyperlinkPool)
        const clippedOutput = new Output({ width: 8, height: 2, stylePool: styles, screen: clipped })
        clippedOutput.blit(screen, 0, 0, 1, 1)
        clippedOutput.get()
        assert.equal(clipped.copyWrap![1], clipped.copyWrap![0], 'a blit-created wide tail inherits its head copy ownership')
        screenApi.clearRegion(screen, 1, 0, 1, 1)
        assert.equal(screen.copyWrap![0], 0, 'clearing a wide tail clears its out-of-slice head ownership')
        assert.equal(screen.copyWrap![1], 0)
      }
      screenApi.clearRegion(screen, 6, 0, 2, 2)
      assert.ok([6, 7, 14, 15].every(index => screen.copyWrap![index] === 0), 'clearing cells clears their copy ownership')
      screenApi.resetScreen(screen, 10, 3)
      assert.ok(screen.copyWrap!.subarray(0, 30).every(value => value === 0), 'resize/reset clears column ownership at the new stride')
    }
  }
  {
    const styles = new StylePool()
    const screen = createScreen(8, 2, styles, new CharPool(), new HyperlinkPool())
    const output = new Output({ width: 8, height: 2, stylePool: styles, screen })
    output.write(0, 0, '        \n        ', [false, false], undefined, 8)
    output.write(6, 0, 'GP\nRT', [false, true], undefined, 2)
    output.get()
    assert.equal(copy(screen), '      GP\n      RT',
      'source hard whitespace keeps ownership when a later selectable wrapped pane activates column provenance')
    output.reset(8, 2, screen)
    output.write(0, 0, 'ABCD \nEF', [false, true], undefined, 6)
    output.write(6, 0, 'GP\nRT', [false, true], undefined, 2)
    output.get()
    assert.equal(copy(screen), 'ABCD GP\nEF    RT',
      'two independent selectable wrap planes do not impersonate one wide paragraph')
    output.noSelect({ x: 6, y: 0, width: 2, height: 2 })
    output.get()
    assert.equal(copy(screen), 'ABCD EF', 'Chat-only copy joins only the left source plane')
    const pane = createSelectionState()
    startSelection(pane, 6, 0, screen)
    updateSelection(pane, 7, 1)
    assert.equal(getSelectedText(pane, screen), 'GPRT', 'pane-origin copy independently joins the right source plane')
  }
  for (const borderFirst of [false, true]) {
    const styles = new StylePool()
    const chars = new CharPool()
    const links = new HyperlinkPool()
    const source = createScreen(8, 3, styles, chars, links)
    const output = new Output({ width: 8, height: 3, stylePool: styles, screen: source })
    // Unscoped structural background fill, followed by independently owned Text.
    output.write(0, 0, '\x1b[48;2;25;25;25m' + Array(3).fill('        ').join('\n') + '\x1b[0m')
    const border = () => output.write(6, 0, '│ \n│ \n│ ')
    if (borderFirst) border()
    output.write(0, 0, 'ABCD \nEF\nGH', [false, true, false], undefined, 6)
    if (!borderFirst) border()
    output.noSelect({ x: 6, y: 0, width: 2, height: 3 })
    output.get()
    assert.equal(copy(source), 'ABCD EF\nGH', 'excluded structural borders/fills cannot erase adjacent Text joins')
    const target = createScreen(8, 3, styles, chars, links)
    const overlay = new Output({ width: 8, height: 3, stylePool: styles, screen: target })
    overlay.blit(source, 0, 0, 8, 3)
    overlay.write(2, 1, '!')
    overlay.blit(source, 6, 0, 2, 3)
    overlay.get()
    assert.equal(copy(target), 'ABCD\nEF!\nGH', 'an overlapping structural glyph owns only its cell and breaks the covered join')
    overlay.blit(source, 0, 0, 6, 3)
    overlay.get()
    assert.equal(copy(target), 'ABCD EF\nGH', 'restoring only the Text column removes overlay copy provenance')
    assert.ok([6, 14, 22].every(index => cellAt(target, index % 8, Math.floor(index / 8))!.char === '│'),
      'overlay and Text restoration preserve stationary border cells')
  }
  {
    const styles = new StylePool()
    const screen = createScreen(8, 2, styles, new CharPool(), new HyperlinkPool())
    const output = new Output({ width: 8, height: 2, stylePool: styles, screen })
    output.write(0, 0, 'ABCDEFGH\nIJKLMNOP', [false, true])
    output.get()
    assert.equal(screen.copyWrap, undefined, 'pure full-width writes keep the allocation-free legacy row path')
  }
  // Normal writes also clear the other half of an overwritten wide glyph.
  // The cleared neighbour must lose its copy ownership, not just its pixels.
  for (const fixture of [
    { name: 'overwrite wide tail', width: 4, scope: 2, text: 'A \n中', x: 1, overlay: '!', cleared: [0] },
    { name: 'overwrite wide head', width: 4, scope: 2, text: ' A\n中', x: 0, overlay: '!', cleared: [1] },
    { name: 'wide over adjacent wide glyphs', width: 6, scope: 4, text: 'AB C\n中界', x: 1, overlay: '文', cleared: [0, 3] },
  ]) {
    const styles = new StylePool()
    const screen = createScreen(fixture.width, 2, styles, new CharPool(), new HyperlinkPool())
    const output = new Output({ width: fixture.width, height: 2, stylePool: styles, screen })
    output.write(0, 0, fixture.text, [false, true], undefined, fixture.scope)
    output.write(fixture.x, 1, fixture.overlay)
    output.get()
    for (const col of fixture.cleared) {
      assert.equal(cellAt(screen, col, 1)!.char, ' ', `${fixture.name}: orphan pixels are blank`)
      const selection = createSelectionState()
      startSelection(selection, col, 0, screen)
      updateSelection(selection, col, 1)
      selection.fence = { colStart: col, colEnd: col }
      assert.equal(getSelectedText(selection, screen), fixture.text[col] + '\n',
        `${fixture.name}: cleared boundary cannot retain an invisible continuation`)
      assert.equal(screen.copyWrap![fixture.width + col], 0, `${fixture.name}: orphan ownership is unowned`)
    }
  }
  console.log('PASS column copy consumers: selectable/excluded panes, both paint orders, spaces, wide cells, stale guard, clear/resize')

  function mount(content: ReactNode, name: string, list: boolean, viewportHeight = 12, screenWidth = 60, contentWidth = screenWidth, excludedText?: boolean, paneFirst = false) {
    const root = createNode('ink-root')
    root.focusManager = new FocusManager(() => false)
    const fail = (error: unknown) => { throw error }
    // @ts-ignore runtime reconciler uses ten arguments
    const container = reconciler.createContainer(root, LegacyRoot, null, false, null, name, fail, fail, fail, fail)
    let scroll: ScrollBoxHandle | null = null
    let flankText: DOMElement | null = null
    let flankLabel = 'GP'
    const scrollNode = <ScrollBox width={contentWidth} height={viewportHeight} flexShrink={0} flexDirection="column" ref={value => { scroll = value }}>{content}</ScrollBox>
    const flankNode = excludedText !== undefined && <Box width={screenWidth - contentWidth} flexShrink={0} overflow="hidden" noSelect>
      {excludedText && <Text ref={value => { flankText = value }}>{Array(viewportHeight).fill(flankLabel).join('\n')}</Text>}
    </Box>
    // @ts-ignore source runtime exposes sync updates
    reconciler.updateContainerSync(<Box height={viewportHeight + 2} flexDirection="column">
      <Text>HEADER</Text>
      <Box flexDirection={paneFirst ? 'row-reverse' : 'row'} height={viewportHeight} flexShrink={0}>
        {paneFirst ? <>{flankNode}{scrollNode}</> : <>{scrollNode}{flankNode}</>}
      </Box>
      <Text>FOOTER</Text>
    </Box>, container, null, () => {})
    // @ts-ignore source runtime exposes sync flush
    reconciler.flushSyncWork()
    root.yogaNode!.setWidth(screenWidth)
    root.yogaNode!.calculateLayout(screenWidth)
    const styles = new StylePool()
    const chars = new CharPool()
    const links = new HyperlinkPool()
    const renderer = createRenderer(root, styles)
    const screenHeight = viewportHeight + 2
    let front: Frame = { screen: createScreen(screenWidth, screenHeight, styles, chars, links), viewport: { width: screenWidth, height: screenHeight }, cursor: { x: 0, y: 0, visible: false } }
    const hanging: DOMElement[] = []
    const visit = (node: DOMElement) => {
      if (node.nodeName === 'ink-text' && node.attributes.continuationIndent) hanging.push(node)
      for (const child of node.childNodes) if (child.nodeName !== '#text') visit(child)
    }
    visit(root)
    assert.equal(hanging.length, 1, `${name} must reach one large hanging Text block`)
    const paint = () => {
      calls = 0
      front = renderer({ frontFrame: front, backFrame: { ...front, screen: createScreen(screenWidth, screenHeight, styles, chars, links) }, isTTY: true, terminalWidth: screenWidth, terminalRows: screenHeight, altScreen: true, prevFrameContaminated: false })
      assert.equal(row(front.screen, 0), 'HEADER')
      const footer = screenHeight - 1
      assert.equal(row(front.screen, footer), 'FOOTER')
      assert.equal(copy(front.screen, footer, footer), 'FOOTER', 'viewport masks must not eat footer characters')
      assert.ok(front.screen.noSelect.subarray(footer * screenWidth, screenHeight * screenWidth).every(value => value === 0))
      if (excludedText !== undefined) {
        for (let y = 1; y <= viewportHeight; y++) {
          const flank = Array.from({ length: screenWidth - contentWidth }, (_, x) => cellAt(front.screen, contentWidth + x, y)!.char).join('')
          assert.equal(flank, excludedText ? flankLabel : '  ', `${name} stationary excluded flank remains intact`)
        }
        if (excludedText) {
          const paneSelection = createSelectionState()
          startSelection(paneSelection, contentWidth, 1, front.screen)
          updateSelection(paneSelection, screenWidth - 1, viewportHeight)
          assert.equal(getSelectedText(paneSelection, front.screen), Array(viewportHeight).fill(flankLabel).join('\n'),
            `${name} pane-origin copy retains its own hard breaks`)
        }
      }
      return { frame: front, calls }
    }
    const indentReads = observeIndents(hanging[0]!, () => { paint() })
    const coldCopy = list ? Array(viewportHeight / 2).fill('- ' + 'x'.repeat(100)).join('\n')
      : '- ' + 'x'.repeat(viewportHeight * (contentWidth - 2))
    assert.equal(copy(front.screen, 1, viewportHeight), coldCopy, `${name} cold copy keeps exact source breaks`)
    const prepared = textPaintCache.get(hanging[0]!)!
    let sourceReads = 0
    const observeSource = (node: DOMElement) => {
      for (const child of node.childNodes) {
        if (child.nodeName !== '#text') observeSource(child)
        else {
          const text = child.nodeValue
          Object.defineProperty(child, 'nodeValue', { get() { sourceReads++; return text } })
        }
      }
    }
    observeSource(hanging[0]!)
    let previousOffset = 0
    return {
      paint: (offset: number) => {
        const before = indentReads()
        const actual = paint()
        assert.equal(textPaintCache.get(hanging[0]!), prepared, `${name} prepared cache hit`)
        assert.equal(sourceReads, 0, `${name} must not reread the body`)
        const delta = offset - previousOffset
        const edge = Math.abs(delta) === 1
        if (edge) assert.equal(actual.frame.scrollHint?.delta, delta, `${name} must take real blit+shift`)
        else assert.equal(actual.frame.scrollHint, null, `${name} large jump paints the viewport`)
        assert.equal(indentReads() - before, edge ? 1 : viewportHeight, `${name} metadata traversal uses edge/viewport clip`)
        const expectedCalls = list ? (edge ? ((delta > 0 ? offset + viewportHeight - 1 : offset) % 2) : viewportHeight / 2) : (edge ? 1 : viewportHeight)
        assert.equal(actual.calls, expectedCalls, `${name} mask calls follow physical source rows`)
        // Each 100-cell list item has a real two-cell prefix, then rows of
        // contentWidth-2 and the remaining body cells. Only each second row joins.
        const bodyWidth = contentWidth - 2
        const expectedCopy = list ? Array.from({ length: viewportHeight }, (_, i) => {
          const logicalRow = offset + i
          return logicalRow % 2 === 0 ? (i > 0 ? '\n' : '') + '- ' + 'x'.repeat(bodyWidth) : 'x'.repeat(100 - bodyWidth)
        }).join('') : 'x'.repeat(viewportHeight * bodyWidth)
        assert.equal(copy(actual.frame.screen, 1, viewportHeight), expectedCopy, `${name} copy excludes synthetic padding and retains hard breaks`)
        previousOffset = offset
        return actual
      },
      seek: (offset: number) => scroll!.scrollTo(offset),
      dirtyFlank: () => {
        if (!excludedText) return
        const leaf = flankText!.childNodes[0]!
        assert.equal(leaf.nodeName, '#text')
        if (leaf.nodeName !== '#text') return
        flankLabel = 'GQ'
        dom.setTextNodeValue(leaf, Array(viewportHeight).fill(flankLabel).join('\n'))
        root.yogaNode!.calculateLayout(screenWidth)
        const before = indentReads()
        const actual = paint()
        assert.equal(indentReads(), before, `${name} dirty flank does not traverse Chat hanging metadata`)
        assert.equal(sourceReads, 0, `${name} dirty flank does not reread Chat source`)
        assert.equal(copy(actual.frame.screen, 1, viewportHeight),
          Array(viewportHeight / 2).fill('- ' + 'x'.repeat(100)).join('\n'),
          `${name} dirty excluded pane cannot overwrite even-offset Chat joins`)
      },
      destroy: () => {
        // @ts-ignore source runtime exposes sync updates
        reconciler.updateContainerSync(null, container, null, () => {})
        // @ts-ignore source runtime exposes sync flush
        reconciler.flushSyncWork()
      },
    }
  }
  const full = '- ' + 'x'.repeat(60_000)
  const shortItems = Array.from({ length: 1000 }, () => '- ' + 'x'.repeat(100)).join('\n')
  const apps = [
    mount(<AssistantTextMessage text={full} marginTopOnTurn={false} />, 'assistant-expanded', false),
    mount(<AssistantTextMessage text={shortItems} marginTopOnTurn={false} />, 'assistant-short-list', true, 8),
    mount(<StreamingMarkdown>{shortItems + '\n\ntrailing paragraph'}</StreamingMarkdown>, 'streaming-stable-list', true, 6),
    ...[62, 100].flatMap(width => [false, true].flatMap(paneText => [false, true].map(paneFirst =>
      mount(<AssistantTextMessage text={shortItems} marginTopOnTurn={false} />,
        `partial-${width - 2}/${width}-${paneText ? 'pane-GP' : 'blank-gutter'}-${paneFirst ? 'pane-first' : 'chat-first'}`,
        true, 8, width, width - 2, paneText, paneFirst)))),
  ]
  try {
    for (const app of apps) {
      for (const offset of [1, 2, 500, 501, 500, 499, 500]) {
        app.seek(offset)
        app.paint(offset)
      }
      app.dirtyFlank()
    }
    // Another root has just painted; root one must retain its own clip state.
    apps[0]!.seek(501)
    const revisited = apps[0]!.paint(501)
    assert.equal(revisited.frame.scrollHint?.delta, 1)
    assert.equal(revisited.calls, 1)
    assert.equal(copy(revisited.frame.screen, 1, 12), 'x'.repeat(12 * 58))
    console.log(`PASS assistant/short list/streaming stable prefix: edge calls<=1, jump calls<=12, interleaved roots`)
    console.log(`Rendered footer: ${row(revisited.frame.screen, 13)}; copied footer: ${copy(revisited.frame.screen, 13, 13)}`)
    console.log([row(revisited.frame.screen, 12), row(revisited.frame.screen, 13)].join('\n'))
  } finally { for (const app of apps) app.destroy() }
} finally { Output.prototype.noSelect = originalNoSelect }
console.log('PASS hanging clip budget and selection boundary regression')

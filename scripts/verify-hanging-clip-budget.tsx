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
] = await Promise.all([
  import('node:assert/strict'), import('react'), import('react-reconciler/constants.js'),
  import('../src/ink/dom.js'), import('../src/ink/output.js'),
  import('../src/ink/render-node-to-output.js'), import('../src/ink/renderer.js'),
  import('../src/ink/screen.js'), import('../src/ink/node-cache.js'),
  import('../src/ink/reconciler.js'), import('../src/ink/focus.js'),
  import('../src/ink/components/Box.js'), import('../src/ink/components/Text.js'),
  import('../src/ink/components/ScrollBox.js'), import('../src/components/messages/AssistantTextMessage.js'),
  import('../src/components/StreamingMarkdown.js'), import('../src/ink/selection.js'),
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

  function mount(content: ReactNode, name: string, list: boolean, viewportHeight = 12) {
    const root = createNode('ink-root')
    root.focusManager = new FocusManager(() => false)
    const fail = (error: unknown) => { throw error }
    // @ts-ignore runtime reconciler uses ten arguments
    const container = reconciler.createContainer(root, LegacyRoot, null, false, null, name, fail, fail, fail, fail)
    let scroll: ScrollBoxHandle | null = null
    // @ts-ignore source runtime exposes sync updates
    reconciler.updateContainerSync(<Box height={viewportHeight + 2} flexDirection="column">
      <Text>HEADER</Text>
      <ScrollBox height={viewportHeight} flexShrink={0} flexDirection="column" ref={value => { scroll = value }}>{content}</ScrollBox>
      <Text>FOOTER</Text>
    </Box>, container, null, () => {})
    // @ts-ignore source runtime exposes sync flush
    reconciler.flushSyncWork()
    root.yogaNode!.setWidth(60)
    root.yogaNode!.calculateLayout(60)
    const styles = new StylePool()
    const chars = new CharPool()
    const links = new HyperlinkPool()
    const renderer = createRenderer(root, styles)
    const screenHeight = viewportHeight + 2
    let front: Frame = { screen: createScreen(60, screenHeight, styles, chars, links), viewport: { width: 60, height: screenHeight }, cursor: { x: 0, y: 0, visible: false } }
    const hanging: DOMElement[] = []
    const visit = (node: DOMElement) => {
      if (node.nodeName === 'ink-text' && node.attributes.continuationIndent) hanging.push(node)
      for (const child of node.childNodes) if (child.nodeName !== '#text') visit(child)
    }
    visit(root)
    assert.equal(hanging.length, 1, `${name} must reach one large hanging Text block`)
    const paint = () => {
      calls = 0
      front = renderer({ frontFrame: front, backFrame: { ...front, screen: createScreen(60, screenHeight, styles, chars, links) }, isTTY: true, terminalWidth: 60, terminalRows: screenHeight, altScreen: true, prevFrameContaminated: false })
      assert.equal(row(front.screen, 0), 'HEADER')
      const footer = screenHeight - 1
      assert.equal(row(front.screen, footer), 'FOOTER')
      assert.equal(copy(front.screen, footer, footer), 'FOOTER', 'viewport masks must not eat footer characters')
      assert.ok(front.screen.noSelect.subarray(footer * 60, screenHeight * 60).every(value => value === 0))
      return { frame: front, calls }
    }
    const indentReads = observeIndents(hanging[0]!, () => { paint() })
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
        // 58 and 42 body cells. Copy joins only the second of each pair.
        const expectedCopy = list ? Array.from({ length: viewportHeight }, (_, i) => {
          const logicalRow = offset + i
          return logicalRow % 2 === 0 ? (i > 0 ? '\n' : '') + '- ' + 'x'.repeat(58) : 'x'.repeat(42)
        }).join('') : 'x'.repeat(viewportHeight * 58)
        assert.equal(copy(actual.frame.screen, 1, viewportHeight), expectedCopy, `${name} copy excludes synthetic padding and retains hard breaks`)
        previousOffset = offset
        return actual
      },
      seek: (offset: number) => scroll!.scrollTo(offset),
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
  ]
  try {
    for (const app of apps) {
      for (const offset of [1, 2, 500, 501, 500]) {
        app.seek(offset)
        app.paint(offset)
      }
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

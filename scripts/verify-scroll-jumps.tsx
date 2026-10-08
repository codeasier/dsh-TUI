/**
 * Long transcript jumps: real ScrollBox + MessageList + gutter + stdin.
 * Cold and cached destinations must paint without a rescue wheel event;
 * Enter must mount only the tail, not the entire path to the bottom.
 * Tool sentinels live in always-visible titles. Real SGR clicks and Ctrl+O
 * exercise the same row's complete detail, height-cache invalidation, wheel
 * movement and resize before restoring the original jump scenarios.
 * Work is bounded by mounted-row counts, not machine-dependent timings.
 * Run: node --import tsx/esm scripts/verify-scroll-jumps.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'en'

import type { ChatRow } from '../src/dsh-adapter/channel.js'
import type { DOMElement } from '../src/ink/dom.js'
import type { ScrollBoxHandle } from '../src/ui.js'
import type { ReactNode } from 'react'
import assert from 'node:assert/strict'

const [React, { PassThrough, Writable }, { Terminal }, ui, { MessageList }, { ScrollbarGutter }, termTest] = await Promise.all([
  import('react'), import('node:stream'), import('@xterm/headless'),
  import('../src/ui.js'), import('../src/components/MessageList.js'),
  import('../src/components/ScrollbarGutter.js'), import('./lib/term-test.mjs'),
])
const { Box, Text, ScrollBox, AlternateScreen, render, useInput, useTerminalSize } = ui
const { settled, sleep, viewportLines } = termTest
const columns = Number(process.env.DSH_TEST_COLUMNS ?? 100)
const height = 36
const term = new Terminal({ cols: columns, rows: height, allowProposedApi: true })
const frames: string[][] = []
class Stdout extends Writable {
  columns = columns
  rows = height
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    term.write(String(chunk), () => { frames.push(viewportLines(term)); callback() })
  }
}
class Stdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
const stdout = new Stdout()
const stdin = new Stdin()
const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } })
const rows: ChatRow[] = []
const toolMarker = (turn: number): string => `TOOL[${turn.toString().padStart(3, '0')}]`
const detailLines = (turn: number): string[] => [
  ...Array.from({ length: 10 }, (_, i) => `DETAIL[${turn}]-${i}`),
  `${'中文 e\u0301 '.repeat(8)}WIDTH_END[${turn}]`,
  `DETAIL_END[${turn}]`,
]
for (let turn = 0; turn < 200; turn++) {
  rows.push({ id: rows.length, kind: 'user', text: `USER ${turn}` })
  rows.push({ id: rows.length, kind: 'assistant', text: Array.from({ length: 12 }, (_, i) => `ANSWER ${turn} line ${i} 中文 e\u0301`).join('\n') })
  rows.push({ id: rows.length, kind: 'tool', text: '', tool: {
    callId: `call-${turn}`, name: 'Bash', argsText: 'echo result', status: 'ok',
    callView: { card: 'generic', title: toolMarker(turn) },
    resultText: `DETAIL[${turn}]-0`, resultFull: detailLines(turn).join('\n'), startedAt: 0, durationMs: 1,
  } })
}
let handle: ScrollBoxHandle | null = null
const mounted = new Map<number, DOMElement>()
let maxMounted = 0
const registerRowRef = (id: number, el: DOMElement | null): void => {
  if (el) mounted.set(id, el)
  else mounted.delete(id)
  maxMounted = Math.max(maxMounted, mounted.size)
}
const noop = (): void => {}
function Harness(): ReactNode {
  const { columns: terminalWidth } = useTerminalSize()
  const [scroll, setScroll] = React.useState<ScrollBoxHandle | null>(null)
  const [, setTimeline] = React.useState<unknown>(null)
  const [expanded, setExpanded] = React.useState(false)
  const [expandedRows, setExpandedRows] = React.useState<ReadonlySet<number>>(new Set())
  const toggleRow = React.useCallback((id: number): void => {
    setExpandedRows(previous => {
      const next = new Set(previous)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])
  handle = scroll
  useInput((input, key) => {
    if (key.return) scroll?.scrollToBottom()
    if (key.ctrl && input === 'o') setExpanded(previous => !previous)
  })
  return <Box height={height} flexDirection="column">
    <Box height={height - 1} flexDirection="row">
      <ScrollBox ref={setScroll} flexGrow={1} flexShrink={1} flexDirection="column" stickyScroll>
        <MessageList rows={rows} expanded={expanded} expandedRows={expandedRows}
          selectedId={null} onToggleRow={toggleRow} model="test" showAll onToggleAll={noop}
          historyPaintEnabled={false} scrollHandle={scroll} registerRowRef={registerRowRef} onTimeline={setTimeline} />
      </ScrollBox>
      <ScrollbarGutter handle={scroll} terminalWidth={terminalWidth} />
    </Box>
    <Text>COMPOSER</Text>
  </Box>
}
const instance = await render(<AlternateScreen><Harness /></AlternateScreen>, {
  stdout: stdout as unknown as NodeJS.WriteStream,
  stdin: stdin as unknown as NodeJS.ReadStream,
  stderr: stderr as unknown as NodeJS.WriteStream,
  exitOnCtrlC: false, patchConsole: false,
})
const screen = (): string => viewportLines(term).join('\n')
const body = (): string => {
  const buffer = term.buffer.active
  return Array.from({ length: height - 1 }, (_, y) =>
    buffer.getLine(buffer.baseY + y)?.translateToString(true, 0, columns - 2) ?? '',
  ).join('\n')
}
try {
  assert.ok(await settled(() => screen().includes(toolMarker(199)) && screen().includes('██')), 'tail title and clickable gutter ready')
  const scroll = handle as ScrollBoxHandle | null
  assert.ok(scroll)
  scroll.scrollTo(0)
  assert.ok(await settled(() => screen().includes('USER 0') && screen().includes(toolMarker(0))), 'warm the head before jumping')

  // First visits change estimated heights. Check the rendered body, not just
  // user text (Chat's pinned prompt can survive an entirely blank transcript).
  for (const row of [9, 25, 4, 18]) {
    const oldTop = scroll.getScrollTop()
    const oldBody = body()
    stdin.write(`\x1b[<0;${columns};${row}M\x1b[<0;${columns};${row}m`)
    assert.ok(await settled(() => scroll.getScrollTop() !== oldTop && body() !== oldBody &&
      screen().includes('ANSWER') && screen().includes('TOOL[')), `gutter row ${row} paints assistant and tool titles`)
  }

  const warmRow = [...mounted].find(([id, el]) => rows[id]!.kind === 'assistant' &&
    el.yogaNode!.getComputedTop() >= scroll.getScrollTop())
  assert.ok(warmRow, 'a measured assistant row is available for a warm seek')
  const [warmId, warmEl] = warmRow
  const warmTop = warmEl.yogaNode!.getComputedTop()
  const warmMarker = `ANSWER ${Math.floor(warmId / 3)} line 0`
  for (let repeat = 0; repeat < 2; repeat++) {
    scroll.scrollTo(0)
    assert.ok(await settled(() => screen().includes('USER 0') && screen().includes(toolMarker(0))), 'return to cached head')
    scroll.scrollTo(warmTop)
    assert.ok(await settled(() => screen().includes(warmMarker) && screen().includes('TOOL[')), 'cached seek paints without a measurement tick or wheel')
  }

  // Clamp publication is itself paint state, even with no React/scroll
  // mutation. It must invalidate a clean ScrollBox and never notify its
  // React subscribers (which would form a window/paint feedback loop).
  let notifications = 0
  const unsubscribe = scroll.subscribe(() => { notifications++ })
  const clampedTop = warmTop + 4
  scroll.setClampBounds(clampedTop, clampedTop)
  assert.ok(await settled(() => viewportLines(term)[0]?.includes(`ANSWER ${Math.floor(warmId / 3)} line 3`) === true), 'changed clamp repaints clean content')
  const writes = frames.length
  scroll.setClampBounds(clampedTop, clampedTop)
  await sleep(80) // 固定窗:探针 相同边界不得重绘或通知，不能轮询已经成立的零增量
  assert.equal(frames.length, writes, 'unchanged bounds do not schedule paint')
  assert.equal(notifications, 0, 'clamp updates do not notify React subscribers')
  unsubscribe()

  scroll.scrollTo(0)
  assert.ok(await settled(() => screen().includes('USER 0') && screen().includes(toolMarker(0))), 'far-jump baseline at head')
  maxMounted = mounted.size
  const from = frames.length
  const start = performance.now()
  stdin.write('\r')
  assert.ok(await settled(() => screen().includes(toolMarker(199)) && scroll.isSticky()), 'Enter reaches the actual bottom')
  const latency = Math.round(performance.now() - start)
  await sleep(80) // 固定窗:探针 已落底的终态不得被延迟测量或绘制清成空白
  assert.ok(screen().includes(toolMarker(199)) && scroll.isSticky(), 'idle tail remains painted')
  assert.equal(scroll.getPendingDelta(), 0, 'Enter cancels wheel debt instead of animating the whole distance')
  assert.ok(maxMounted <= 40, `far jump keeps a viewport-sized mount window, got ${maxMounted} of ${rows.length} rows`)
  assert.ok(frames.slice(from).every(frame => frame.slice(0, height - 1).some(line => /ANSWER|TOOL\[/.test(line))), 'no blank body frames during the jump')
  console.log(`PASS: scroll jumps (${columns} columns, ${rows.length} rows; Enter ${latency} ms, peak ${maxMounted} mounted rows)`)

  const tailId = 599
  const rowHeight = (): number => mounted.get(tailId)?.yogaNode?.getComputedHeight() ?? 0
  const collapsedHeight = rowHeight()
  assert.equal(collapsedHeight, 9, 'preview card has padding, header, separator, three output rows, fold hint and block gap')
  assert.ok(screen().includes('DETAIL[199]-2') && !screen().includes('DETAIL_END[199]'), 'preview shows the first three lines, not the full result')
  const clickTail = (): void => {
    const y = viewportLines(term).findIndex(line => line.includes(toolMarker(199))) + 1
    assert.ok(y > 0 && y < height, 'same tool title remains on screen for the real click')
    stdin.write(`\x1b[<0;8;${y}M\x1b[<0;8;${y}m`)
  }
  const completeDetail = (): boolean => {
    const detail = screen().split(toolMarker(199))[1] ?? ''
    return detailLines(199).slice(0, 10).every(line => detail.includes(line)) &&
      detail.includes('WIDTH_END[199]') && detail.includes('DETAIL_END[199]') &&
      (detail.match(/中文/g) ?? []).length === 8
  }
  const assertExpanded = async (label: string, afterFrame = -1): Promise<void> => {
    assert.ok(await settled(() => frames.length > afterFrame && completeDetail() && rowHeight() > collapsedHeight && scroll.isSticky()),
      `${label}\nheight=${rowHeight()}, sticky=${scroll.isSticky()}\n${screen()}`)
    assert.equal(scroll.getPendingDelta(), 0, 'opening detail leaves no wheel debt')
    assert.ok(screen().includes('COMPOSER'), 'expanded detail does not displace composer')
  }
  const assertCollapsed = async (label: string): Promise<void> => {
    assert.ok(await settled(() => screen().includes(toolMarker(199)) && screen().includes('DETAIL[199]-2') && !screen().includes('DETAIL_END[199]') &&
      rowHeight() === collapsedHeight && scroll.isSticky()), label)
  }
  const detailStart = frames.length
  clickTail()
  await assertExpanded('SGR click expands the same row with complete resultFull and remeasured height')
  const expandedHeight = rowHeight()
  for (const width of [59, columns]) {
    const beforeResize = frames.length
    stdout.columns = width
    term.resize(width, height)
    stdout.emit('resize')
    await assertExpanded(`expanded tool stays complete across resize to ${width}`, beforeResize)
  }
  assert.equal(rowHeight(), expandedHeight, 'restored width restores the measured expanded height')
  const expandedTop = scroll.getScrollTop()
  stdin.write('\x1b[<64;10;10M')
  assert.ok(await settled(() => !scroll.isSticky() && scroll.getScrollTop() < expandedTop), 'real SGR wheel-up scrolls expanded detail')
  stdin.write('\r')
  await assertExpanded('Enter restores expanded tail after wheel-up')
  clickTail()
  await assertCollapsed('second SGR click collapses and invalidates the expanded height cache')
  stdin.write('\x0f')
  await assertExpanded('real Ctrl+O expands complete detail')
  stdin.write('\x0f')
  await assertCollapsed('second Ctrl+O restores the bounded preview and cached geometry')
  assert.ok(frames.slice(detailStart).every(frame => frame.slice(0, height - 1).some(line => /ANSWER|TOOL\[|DETAIL/.test(line))),
    'no blank transcript frames during click, Ctrl+O, wheel or resize')
  console.log('PASS: same-row SGR/Ctrl+O toggles, complete body, height-cache, wheel and resize protection')

  scroll.scrollTo(0)
  assert.ok(await settled(() => screen().includes(toolMarker(0))), 'head before an unmeasured tail arrives')
  rows.push({ id: rows.length, kind: 'assistant', text: `${'NEW ANSWER\n'.repeat(60)}COLD TAIL` })
  maxMounted = mounted.size
  scroll.scrollBy(120)
  scroll.scrollToBottom()
  assert.equal(scroll.getPendingDelta(), 0, 'jump replaces an in-flight wheel burst')
  assert.ok(await settled(() => screen().includes('COLD TAIL') && scroll.isSticky()), 'new tail height settles at the real bottom')
  assert.ok(maxMounted <= 40, 'cold-tail measurement keeps virtualization bounded')
  scroll.scrollBy(-10)
  assert.ok(await settled(() => !scroll.isSticky() && !screen().includes('COLD TAIL')), 'wheel-up can break sticky after a jump')
  scroll.scrollToBottom()
  assert.ok(await settled(() => scroll.isSticky() && screen().includes('COLD TAIL')), 'can jump back after wheel-up')
  console.log('PASS: cold tail, pending-wheel cancellation and sticky recovery')

  // Width changes discard cached row heights. A manual position can then
  // exceed the entire estimated list; it must not unmount every row and
  // collapse scrollHeight to the viewport (which also hides the gutter).
  scroll.scrollBy(-10)
  assert.ok(await settled(() => !scroll.isSticky() && !screen().includes('COLD TAIL')), 'manual position before resize')
  for (const width of [59, columns]) {
    const before = frames.length
    stdout.columns = width
    term.resize(width, height)
    stdout.emit('resize')
    assert.ok(await settled(() => frames.length > before && mounted.size > 0 && screen().includes('ANSWER')), `resize to ${width} never leaves an empty virtual window`)
  }
  assert.ok(await settled(() => screen().includes('██')), 'gutter returns after narrow-to-wide resize')
  console.log('PASS: nonempty virtual window and gutter restoration across resize')
} finally {
  await instance.unmount()
  term.dispose()
}

/**
 * Smooth streaming reveal regression (settings `dsh-tui.smoothStreaming`).
 *
 * Group A — scheduler/cursor units (no rendering):
 *   step math, cursor creation (active gate), append vs replacement,
 *   catch-up timing, timer refcount, line-count semantics.
 * Group B — MessageList integration (headless xterm):
 *   a live streaming row reveals gradually; a freshly SETTLED row (one-shot
 *   non-streaming delivery) reveals too; replayed rows and disabled mode
 *   paint complete immediately.
 * Group C — component contracts:
 *   thinking preview ticker follows the ARRIVED text while the expanded body
 *   paints the revealed slice; tool cards stay single-line when collapsed
 *   and explicitly opened bodies paint complete without reveal timers.
 * Group D — long-session fanout:
 *   real assistant/reasoning reveal with 80 historical tool cards uses one
 *   store subscriber, catches up and retires the timer.
 *
 * Run: node --import tsx/esm scripts/verify-smooth-reveal.tsx
 * Negative control: add --disable-animation; positive B/D animation oracles
 * must fail against the same rendered content with smoothStreaming off.
 */
// 注意：静态 import 会提升执行，下面这行 env pin 对本脚本的 i18n 解析
// 其实无效（i18n.js 在赋值前就已按启动链解析 activeLang；本脚本断言的
// en 文案此前全靠「折叠提示硬编码英文」蒙混过关，issue #980 修复后暴露）。
// 权威 pin 是 body 首句的 setLang('en')；此行保留给动态 import 的消费方。
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import { render } from '../src/ui.js'
import { setLang } from '../src/i18n.js'
import { MessageList } from '../src/components/MessageList.js'
import { AssistantThinkingMessage } from '../src/components/messages/AssistantThinkingMessage.js'
import { AssistantToolUseMessage } from '../src/components/messages/AssistantToolUseMessage.js'
import type { ChatRow, ToolRow } from '../src/dsh-adapter/channel.js'
import { settled } from './lib/term-test.mjs'
import {
  REVEAL_MIN_STEP,
  getRevealVersion,
  getRevealSubscriberCount,
  isRevealTimerRunning,
  revealLengthOf,
  revealLinesOf,
  revealStep,
  resetRevealForTest,
} from '../src/components/smoothReveal.js'

// env pin 因 import 提升而失效（见上），显式切换到 en——本脚本的断言
// 全部针对英文文案。
setLang('en')

const { Terminal: XTerm } = (await import('@xterm/headless')) as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) {
    console.log(`ok   ${label}`)
  } else {
    failures++
    console.error(`FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const animationEnabled = !process.argv.includes('--disable-animation')

// ---------------------------------------------------------------------------
// Group A — scheduler/cursor units
// ---------------------------------------------------------------------------
console.log('--- A: scheduler/cursor units ---')
resetRevealForTest()
check(revealStep(0) === REVEAL_MIN_STEP, 'A1 revealStep floors at MIN_STEP')
check(revealStep(100) === 13, 'A1 revealStep(100) = ceil(100/8) = 13', `got ${revealStep(100)}`)
check(revealStep(24) === 3, 'A1 revealStep(24) = 3')
check(revealStep(25) === 4, 'A1 revealStep(25) = 4')

{
  const text = 'a'.repeat(1000)
  check(revealLengthOf('a1', text, { enabled: true, active: true }) === 0, 'A2 active first read starts at zero')
  const grown = text + 'b'.repeat(200)
  check(
    revealLengthOf('a1', grown, { enabled: true, active: true }) === 0,
    'A2 monotonic append keeps the cursor',
  )
  // 固定窗:墙钟 采样 reveal 动画中途（每帧消化 ~1/8 backlog）：轮询会一路
  // 推进游标直到揭完，测不到 mid-flight
  await sleep(120)
  const mid = revealLengthOf('a1', grown, { enabled: true, active: true })
  check(mid > 0 && mid < grown.length, 'A2 partial reveal mid-flight', `len=${mid}/${grown.length}`)
  // 固定窗:墙钟 exponential decay over the backlog (~1/8 per frame) +
  // MIN_STEP tail: a 1200-char target needs ~1.3s to fully land.
  await sleep(2200)
  check(
    revealLengthOf('a1', grown, { enabled: true, active: true }) === grown.length,
    'A2 catch-up completes (exponential decay + MIN_STEP tail)',
  )
  check(
    revealLengthOf('a1', 'completely different', { enabled: true, active: true }) === 'completely different'.length,
    'A2 non-prefix replacement snaps',
  )
  check(
    revealLengthOf('a2', text, { enabled: true, active: false }) === text.length,
    'A2 inactive first read never creates a cursor',
  )
  check(
    revealLengthOf('a3', text, { enabled: false, active: true }) === text.length,
    'A2 disabled switch returns full text',
  )
}

{
  resetRevealForTest()
  const text = 'z'.repeat(2000)
  const before = getRevealVersion()
  revealLengthOf('a4', text, { enabled: true, active: true })
  check(isRevealTimerRunning(), 'A3 cursor creation starts the shared timer')
  check(await settled(() => getRevealVersion() > before), 'A3 ticks bump the version store')
  check(await settled(() => !isRevealTimerRunning(), { timeoutMs: 6000 }),
    'A3 timer retires once every cursor caught up')
}

{
  resetRevealForTest()
  check(revealLinesOf('c1', 2, { enabled: true, active: true }) === 2, 'A4 tiny totals skip animation')
  check(revealLinesOf('c2', 30, { enabled: true, active: true }) === 0, 'A4 line cursor starts at zero')
  check(revealLinesOf('c2', 42, { enabled: true, active: true }) === 0, 'A4 growing totals keep the cursor')
  check(revealLinesOf('c2', 10, { enabled: true, active: true }) === 10, 'A4 shrinking totals snap')
}

// ---------------------------------------------------------------------------
// Terminal harness for the render groups
// ---------------------------------------------------------------------------
const COLS = 60
const ROWS = 24
type RevealFrame = { text: string; version: number; running: boolean; subscribers: number }
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  constructor(private term: XTerm.Terminal, private frames: RevealFrame[]) { super() }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.term.write(String(chunk), () => {
      this.frames.push({ text: terminalText(this.term), version: getRevealVersion(), running: isRevealTimerRunning(), subscribers: getRevealSubscriberCount() })
      callback()
    })
  }
}
function terminalText(term: XTerm.Terminal): string {
  const buffer = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '').join('\n')
}
class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
async function withTerminal(
  make: () => React.ReactNode,
  run: (screen: () => string, rerender: (node: React.ReactNode) => void, frames: RevealFrame[]) => Promise<void>,
): Promise<void> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const frames: RevealFrame[] = []
  const stdout = new FakeStdout(term, frames) as unknown as NodeJS.WriteStream
  const instance = await render(make(), {
    stdout,
    stdin: new Input() as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const screen = (): string => terminalText(term)
  try {
    await run(screen, node => instance.rerender(node), frames)
  } finally {
    await instance.unmount()
    term.dispose()
  }
}

// Capture real terminal frames rather than sampling an empty first frame or
// missing the early phase when frame parsing is delayed on a slow runner.
async function checkAnimatedReveal(screen: () => string, frames: RevealFrame[], label: string, head: string, tail: string): Promise<void> {
  check(await settled(() => frames.some(frame => frame.version > 0 && frame.running &&
    frame.text.includes(head) && !frame.text.includes(tail))), `${label}: advancing timer paints a nonempty partial prefix`)
  const earlyVersion = frames.find(frame => frame.version > 0 && frame.running &&
    frame.text.includes(head) && !frame.text.includes(tail))?.version
  check(await settled(() => screen().includes(tail) && !isRevealTimerRunning(), { timeoutMs: 8000 }),
    `${label}: full tail paints and timer retires`)
  const version = getRevealVersion()
  check(earlyVersion !== undefined && version > earlyVersion, `${label}: version advances from partial to complete`)
  await sleep(80) // 固定窗:探针 已追平的调度器不得继续 tick 或重新动画
  check(getRevealVersion() === version && !isRevealTimerRunning() && screen().includes(tail), `${label}: caught-up content stays complete without ticks`)
}

const LONG_TEXT = [
  'alpha-start of the streamed reply',
  ...Array.from({ length: 30 }, (_, i) => `body paragraph ${i} with some words to wrap around the terminal width`),
  'omega-end of the streamed reply',
].join('\n\n')

const listProps = {
  expanded: false,
  expandedRows: new Set<number>(),
  selectedId: null as number | null,
  onToggleRow: (_rowId: number) => {},
  model: 'deepseek-chat',
  showAll: true,
  onToggleAll: () => {},
}

// ---------------------------------------------------------------------------
// Group B — MessageList integration
// ---------------------------------------------------------------------------
console.log('--- B: MessageList integration ---')

// B1: live streaming row reveals gradually.
{
  resetRevealForTest()
  const rows: ChatRow[] = [
    { id: 1, kind: 'user', text: 'question' },
    { id: 2, kind: 'assistant', text: LONG_TEXT, streaming: true, fresh: true },
  ]
  await withTerminal(
    () => <MessageList rows={rows} smoothStreaming={animationEnabled} {...listProps} />,
    async (screen, _rerender, frames) => checkAnimatedReveal(screen, frames, 'B1 streaming row', 'alpha-start', 'omega-end'),
  )
}

// B2: freshly SETTLED row (one-shot non-streaming delivery) still reveals.
{
  resetRevealForTest()
  const rows: ChatRow[] = [
    { id: 3, kind: 'assistant', text: LONG_TEXT, streaming: false, fresh: true },
  ]
  await withTerminal(
    () => <MessageList rows={rows} smoothStreaming={animationEnabled} {...listProps} />,
    async (screen, _rerender, frames) => checkAnimatedReveal(screen, frames, 'B2 settled-fresh row', 'alpha-start', 'omega-end'),
  )
}

// B3: replayed rows (no fresh flag) paint complete immediately.
{
  resetRevealForTest()
  const rows: ChatRow[] = [
    { id: 4, kind: 'assistant', text: LONG_TEXT, streaming: false },
  ]
  await withTerminal(
    () => <MessageList rows={rows} smoothStreaming {...listProps} />,
    async screen => {
      // 固定窗:探针 重放行不得逐字揭示：settled 会一直等到揭完也判过，
      // 遮蔽「开屏打字机」这个 bug；只能给一个短窗后断言已经完整
      await sleep(80)
      check(screen().includes('omega-end'), 'B3 replayed row: paints complete (no typewriting on open)')
    },
  )
}

// B4: disabled switch paints everything immediately.
{
  resetRevealForTest()
  const rows: ChatRow[] = [
    { id: 5, kind: 'assistant', text: LONG_TEXT, streaming: true, fresh: true },
  ]
  await withTerminal(
    () => <MessageList rows={rows} {...listProps} />,
    async screen => {
      // 固定窗:探针 关掉开关后不得有任何揭示动画：settled 等到揭完也判过，
      // 遮蔽 bug；只能给一个短窗后断言已经完整
      await sleep(80)
      check(screen().includes('omega-end'), 'B4 smoothStreaming=false: full text paints immediately')
    },
  )
}

// ---------------------------------------------------------------------------
// Group C — component contracts
// ---------------------------------------------------------------------------
console.log('--- C: component contracts ---')

// C1: thinking ticker follows ARRIVED text; expanded body paints the slice.
{
  resetRevealForTest()
  const full = Array.from({ length: 12 }, (_, i) => `think line ${i}`).join('\n')
  const slice = full.slice(0, 40)
  await withTerminal(
    () => (
      <AssistantThinkingMessage thinking={slice} textFull={full} marginTopOnTurn={false} verbose={false} preview streaming />
    ),
    async screen => {
      // 固定窗:探针 预览 ticker 不得被揭示节流：settled 等到揭完也判过，
      // 遮蔽「ticker 跟着 reveal 走」这个 bug
      await sleep(120)
      const text = screen()
      check(text.includes('think line 11'), 'C1 preview ticker follows the ARRIVED text (not the reveal)')
    },
  )
  await withTerminal(
    () => (
      <AssistantThinkingMessage thinking={slice} textFull={full} marginTopOnTurn={false} verbose streaming />
    ),
    async screen => {
      // 固定窗:探针 展开体不得越过已揭示切片（断言 think line 11 不出现）
      await sleep(120)
      const text = screen()
      check(!text.includes('think line 11'), 'C1 expanded body paints only the revealed slice')
      check(text.includes('think line 0'), 'C1 expanded body shows the slice head')
    },
  )
}

// C2/C3: tool detail is opt-in and complete, independent of smooth streaming.
{
  resetRevealForTest()
  const diffs = [
    {
      path: '/src/example.ts',
      oldText: Array.from({ length: 6 }, (_, i) => `old line ${i}`).join('\n'),
      newText: Array.from({ length: 6 }, (_, i) => `new line ${i}`).join('\n'),
    },
  ]
  const runningTool: ToolRow = {
    callId: 'call-1',
    name: 'edit',
    argsText: '{}',
    argsFull: '{}',
    status: 'running',
    callView: { card: 'diff', title: 'Edit /src/example.ts', diffs },
    startedAt: Date.now(),
  }
  const doneTool: ToolRow = {
    ...runningTool,
    status: 'done',
    resultView: { card: 'generic', title: 'Edited', content: [{ type: 'text', text: 'settled-result-marker' }] },
  }
  await withTerminal(
    () => <AssistantToolUseMessage tool={runningTool} marginTopOnTurn={false} verbose={false} />,
    async (screen, rerender) => {
      check(await settled(() => screen().includes('Edit /src/example.ts')), 'C2 running summary is visible')
      check(screen().split('\n').filter(line => line.trim() !== '').length === 1 && !screen().includes('old line'),
        'C2 collapsed running card occupies one physical line without body')
      check(!isRevealTimerRunning() && getRevealVersion() === 0 && getRevealSubscriberCount() === 0,
        'C2 tool card owns neither reveal cursor nor subscriber')
      rerender(<AssistantToolUseMessage tool={runningTool} marginTopOnTurn={false} verbose isExpanded />)
      check(await settled(() => Array.from({ length: 6 }, (_, i) => [`old line ${i}`, `new line ${i}`]).flat()
        .every(line => screen().includes(line))), 'C2 opened running diff paints every old/new line')
      check(!isRevealTimerRunning() && getRevealVersion() === 0, 'C2 opened diff paints complete without animation')
      rerender(<AssistantToolUseMessage tool={doneTool} marginTopOnTurn={false} verbose={false} />)
      check(await settled(() => screen().includes('Edited') && !screen().includes('old line')), 'C3 settled summary replaces call title')
      check(!screen().includes('settled-result-marker') && screen().split('\n').filter(line => line.trim() !== '').length === 1,
        'C3 settled collapsed card still hides detail')
      rerender(<AssistantToolUseMessage tool={doneTool} marginTopOnTurn={false} verbose isExpanded />)
      check(await settled(() => screen().includes('settled-result-marker')), 'C3 opened result paints complete')
      check(!isRevealTimerRunning() && getRevealVersion() === 0, 'C3 result never activates reveal')
    },
  )
}

// D: long-session tool-card fanout — only MessageList may subscribe to the
// reveal store in the production path. Real assistant/thinking content drives
// the scheduler; settled cards must not each force a store rerender.
console.log('--- D: long-session reveal subscriber fanout ---')
{
  resetRevealForTest()
  const historyTools: ChatRow[] = Array.from({ length: 80 }, (_, i) => ({
    id: 1000 + i,
    kind: 'tool' as const,
    text: '',
    fresh: false,
    tool: {
      callId: `history-${i}`,
      name: 'edit',
      argsText: '{}',
      argsFull: '{}',
      status: 'done' as const,
      resultView: { card: 'generic' as const, title: 'Edited', content: [{ type: 'text' as const, text: 'done' }] },
      startedAt: Date.now() - 1000,
      durationMs: 1000,
    },
  }))
  for (const kind of ['assistant', 'reasoning'] as const) {
    resetRevealForTest()
    const active: ChatRow = { id: 2000, kind, text: LONG_TEXT, streaming: true, fresh: true }
    const expandedRows = new Set([active.id])
    await withTerminal(
      () => <MessageList rows={historyTools} smoothStreaming={animationEnabled}
        {...listProps} expandedRows={expandedRows} />,
      async (screen, rerender, frames) => {
        // Finish the history's cold mount before delivering live content:
        // otherwise its initial layout can consume the whole early reveal
        // window before the first parsed terminal frame reaches the oracle.
        check(await settled(() => screen().includes('Edited') && getRevealSubscriberCount() === 1),
          `D1 ${kind}: historical cards painted before live delivery`)
        frames.length = 0
        rerender(<MessageList rows={[...historyTools, active]} smoothStreaming={animationEnabled}
          {...listProps} expandedRows={expandedRows} />)
        await checkAnimatedReveal(screen, frames, `D1 ${kind} with 80 history cards`, 'alpha-start', 'omega-end')
        check(frames.some(frame => frame.running) && frames.filter(frame => frame.running).every(frame => frame.subscribers === 1) &&
          getRevealSubscriberCount() === 1, `D1 ${kind}: one list subscriber throughout animation, no per-card fanout`)
      },
    )
    check(getRevealSubscriberCount() === 0, `D1 ${kind}: unmount releases the subscriber`)
  }
}

console.log('')
if (failures > 0) {
  console.error(`verify-smooth-reveal: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('verify-smooth-reveal: all checks passed')

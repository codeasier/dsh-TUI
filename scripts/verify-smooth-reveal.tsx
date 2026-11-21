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
 *   one thinking instance survives empty/text/count transitions and cleans up
 *   its spinner; preview follows ARRIVED text while expansion paints the slice;
 *   tool cards show bounded previews when collapsed
 *   and explicitly opened bodies paint complete without reveal timers.
 * Group D — long-session fanout:
 *   real assistant/reasoning reveal with 80 historical tool cards uses one
 *   store subscriber, catches up and retires the timer.
 * Group E — completed reveals survive remounts and session boundaries:
 *   a finished row does not re-reveal after thousands of later reveals, a
 *   session reset drops cross-session keys, and all three Chat reset sites
 *   (agent-id effect, scope cleanup, `/clear`) stay scoped to this root.
 * Group F — replayed history is never marked fresh:
 *   a real projector replay (cold resume and replay-over-painted-rows) leaves
 *   no row claiming `fresh`, so the transcript never typewrites history.
 * Group G — per-root reveal scopes:
 *   two Chat roots rendering the same row id keep separate completed keys; a
 *   rebind in one root neither clears nor inherits the other's, and a scoped
 *   reset drops only its own prefix.
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
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import React from 'react'
import { Box, Text, render } from '../src/ui.js'
import { setLang } from '../src/i18n.js'
import { MessageList } from '../src/components/MessageList.js'
import { RevealScopeContext } from '../src/components/revealScope.js'
import { AssistantThinkingMessage } from '../src/components/messages/AssistantThinkingMessage.js'
import { AssistantToolUseMessage } from '../src/components/messages/AssistantToolUseMessage.js'
import { THINKING_SPINNER_INTERVAL_MS } from '../src/terminal-utils/figures.js'
import type { ChatRow, ToolRow } from '../src/dsh-adapter/channel.js'
import { createDshTranslator } from '../src/dsh-adapter/backend/translate.js'
import { createChannelReadView } from '../src/adapter/channel/read-view.js'
import { settled } from './lib/term-test.mjs'
import { createProjectorHarness } from './lib/projector-harness.js'
import {
  REVEAL_MIN_STEP,
  getRevealVersion,
  getRevealSubscriberCount,
  isRevealTimerRunning,
  revealLengthOf,
  revealLinesOf,
  revealStep,
  resetRevealForTest,
  resetRevealSession,
  scopeRevealKey,
  snapReveal,
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
    'A2 inactive first read paints full and records a caught-up cursor',
  )
  check(
    revealLengthOf('a2', text, { enabled: true, active: true }) === text.length,
    'A2 the caught-up cursor keeps a later live read from restarting at zero',
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

// C1: the SAME thinking instance must survive a reveal's empty first slice,
// text disappearing, and count-only fallback. Separate mounts hide hook-order
// failures. Observe native timers without advancing or replacing their clock.
{
  resetRevealForTest()
  const full = Array.from({ length: 12 }, (_, i) => `think line ${i}`).join('\n')
  const slice = full.slice(0, 40)
  type ThinkingProps = React.ComponentProps<typeof AssistantThinkingMessage>
  const textProps = { thinking: slice, textFull: full, verbose: true }
  const stages: Array<{
    id: string
    props: Partial<ThinkingProps>
    visible: string[]
    absent: string[]
    timers: number
  }> = [
    { id: 'empty', props: { textFull: full, preview: true },
      visible: [], absent: ['Thinking', 'think line'], timers: 0 },
    { id: 'preview', props: { ...textProps, verbose: false, preview: true },
      visible: ['Thinking', 'think line 11'], absent: ['think line 0'], timers: 1 },
    { id: 'expanded', props: textProps,
      visible: ['Thinking', 'think line 0'], absent: ['think line 11'], timers: 1 },
    { id: 'empty-again', props: {},
      visible: [], absent: ['Thinking', 'think line'], timers: 0 },
    { id: 'count-live', props: { reasoningTokens: 123, preview: true },
      visible: ['Thinking', '~123 tokens'], absent: ['think line'], timers: 1 },
    { id: 'text-over-count', props: { ...textProps, reasoningTokens: 123 },
      visible: ['Thinking', 'think line 0'], absent: ['tokens', 'think line 11'], timers: 1 },
    { id: 'count-again', props: { reasoningTokens: 456 },
      visible: ['Thinking', '~456 tokens'], absent: ['think line'], timers: 1 },
    { id: 'count-settled', props: { reasoningTokens: 456, streaming: false },
      visible: ['Thought', '~456 tokens'], absent: ['Thinking', 'think line'], timers: 0 },
    { id: 'count-restarted', props: { reasoningTokens: 456 },
      visible: ['Thinking', '~456 tokens'], absent: ['Thought', 'think line'], timers: 1 },
    { id: 'text-live-again', props: textProps,
      visible: ['Thinking…', 'think line 0'], absent: ['tokens', 'think line 11'], timers: 1 },
    { id: 'text-settled', props: { ...textProps, streaming: false },
      visible: ['Thinking', 'think line 0'], absent: ['tokens', 'think line 11', '…'], timers: 0 },
    { id: 'text-restarted', props: textProps,
      visible: ['Thinking…', 'think line 0'], absent: ['tokens', 'think line 11'], timers: 1 },
  ]
  let committedStage = ''
  function ThinkingFixture({ stage }: { stage: typeof stages[number] }): React.ReactNode {
    // Child passive effects have run before this marker. The matching screen
    // sentinel also waits for terminal parsing, so absence/timer checks cannot
    // pass against the previous render (especially the initial empty frame).
    React.useEffect(() => { committedStage = stage.id }, [stage.id])
    return (
      <Box flexDirection="column">
        <AssistantThinkingMessage thinking="" marginTopOnTurn={false} verbose={false} streaming {...stage.props} />
        <Text>{`C1-stage:${stage.id}`}</Text>
      </Box>
    )
  }
  const spinnerTimers = new Set<ReturnType<typeof setInterval>>()
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const originalError = console.error
  const errors: string[] = []
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const timer = originalSetInterval(...args)
    if (args[1] === THINKING_SPINNER_INTERVAL_MS) spinnerTimers.add(timer)
    return timer
  }) as typeof setInterval
  globalThis.clearInterval = ((...args: Parameters<typeof clearInterval>) => {
    spinnerTimers.delete(args[0] as ReturnType<typeof setInterval>)
    originalClearInterval(...args)
  }) as typeof clearInterval
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
    originalError(...args)
  }
  try {
    await withTerminal(
      () => <ThinkingFixture stage={stages[0]!} />,
      async (screen, rerender) => {
        for (const [index, stage] of stages.entries()) {
          if (index > 0) rerender(<ThinkingFixture stage={stage} />)
          const ready = await settled(() => {
            const text = screen()
            return committedStage === stage.id && text.includes(`C1-stage:${stage.id}`) &&
              stage.visible.every(value => text.includes(value)) &&
              stage.absent.every(value => !text.includes(value)) && spinnerTimers.size === stage.timers
          })
          check(ready, `C1 ${stage.id}: same-instance content and ${stage.timers} active spinner timer(s)`)
          if (!ready) break
        }
      },
    )
    check(await settled(() => spinnerTimers.size === 0), 'C1 unmount releases the active spinner')
    check(!errors.some(error => /Rendered (?:more|fewer) hooks|change in the order of Hooks|Should have a queue/i.test(error)),
      'C1 transitions emit no hook-order errors')
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    console.error = originalError
    // Do not let a failed cleanup assertion leak timers into the other groups.
    for (const timer of spinnerTimers) originalClearInterval(timer)
  }
}

// C2/C3: tool previews and full detail are independent of smooth streaming.
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
    () => <AssistantToolUseMessage tool={runningTool} marginTopOnTurn={false} verbose={false} smoothReveal fresh />,
    async (screen, rerender) => {
      check(await settled(() => screen().includes('Edit /src/example.ts')), 'C2 running summary is visible')
      check(await settled(() => screen().includes('old line 0') && screen().includes('new line 1') && !screen().includes('new line 2')),
        'C2 running diff preview paints its eight-row budget without exposing the tail')
      check(!isRevealTimerRunning() && getRevealVersion() === 0 && getRevealSubscriberCount() === 0,
        'C2 tool card owns neither reveal cursor nor subscriber')
      rerender(<AssistantToolUseMessage tool={runningTool} marginTopOnTurn={false} verbose isExpanded smoothReveal fresh />)
      check(await settled(() => Array.from({ length: 6 }, (_, i) => [`old line ${i}`, `new line ${i}`]).flat()
        .every(line => screen().includes(line))), 'C2 opened running diff paints every old/new line')
      check(!isRevealTimerRunning() && getRevealVersion() === 0, 'C2 opened diff paints complete without animation')
      rerender(<AssistantToolUseMessage tool={doneTool} marginTopOnTurn={false} verbose={false} />)
      check(await settled(() => screen().includes('Edited') && !screen().includes('old line')), 'C3 settled summary replaces call title')
      check(await settled(() => screen().includes('settled-result-marker')),
        'C3 settled card immediately paints its short output preview')
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

// E: a completed reveal must outlive the row's mount. `fresh` is set when a
// live turn settles and never cleared, so a remounted history row (leaving a
// whole screen remounts the transcript tree; /resume repaints its history)
// still reads with active=true. If the completed memory is capped and evicted,
// that row typewrites itself again from the first character — the long-session
// re-reveal report (#1787). Row ids also restart at 0 across a session switch,
// so the memory must be dropped at that boundary and nowhere else.
console.log('--- E: completed reveals survive remounts ---')
{
  resetRevealForTest()
  const text = 'history row text'
  check(revealLengthOf('a1', text, { enabled: true, active: true }) === 0, 'E1 first live read starts at zero')
  await sleep(600) // 固定窗:墙钟 16 字符、步长 3 → 六帧内追平（600ms ≈ 18 帧）
  check(
    revealLengthOf('a1', text, { enabled: true, active: true }) === text.length,
    'E1 row catches up',
  )
  // A long session blows far past the old 2048-key cap; every one of these
  // settles on the next tick, which used to evict the oldest half.
  for (let i = 0; i < 2600; i++) revealLengthOf(`long${i}`, 'q', { enabled: true, active: true })
  await sleep(500) // 固定窗:墙钟 单字符游标一拍追平
  const afterChurn = revealLengthOf('a1', text, { enabled: true, active: true })
  check(
    afterChurn === text.length,
    'E1 completed row stays complete after thousands of later reveals (no replay on remount)',
    `len=${afterChurn}/${text.length}`,
  )
  // Session boundary: the same key names different content after an adopt.
  // Go through the scoped reset the production path calls, not the test seam:
  // the seam clears everything unconditionally, so a broken prefix would stay
  // green here and only G4/G4b would notice.
  const boundaryKey = scopeRevealKey('root-a', 'a1')
  revealLengthOf(boundaryKey, text, { enabled: true, active: true })
  snapReveal(boundaryKey)
  resetRevealSession('root-a')
  check(
    revealLengthOf(boundaryKey, text, { enabled: true, active: true }) === 0,
    'E2 the scoped session reset drops cross-session keys (new live row animates)',
  )
  // E1/E2 pin the primitive; neither fails if Chat stops calling the reset,
  // which is exactly how the cross-session leak would return silently. Walk
  // the real source's syntax tree for the call sites: a text regex would also
  // match the name inside the comments that sit between the two calls, and
  // a proximity window would go red the next time that comment is reworded
  // (verify-terminal-size-source walks the AST for the same reason).
  const chatSource = await readFile(new URL('../src/screens/Chat.tsx', import.meta.url), 'utf8')
  const chatAst = ts.createSourceFile('Chat.tsx', chatSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  // Count alone would pass with both calls inside one branch, so record the
  // enclosing construct. "Inside some effect" is still too weak: the reset has
  // to run in the effect that watches the agent id, and a check that only sees
  // an effect ancestor would stay green if the call drifted into any other
  // one. Keep the nearest effect's text and require the agent-id read in it.
  const resetSites: Array<{ effectText: string | undefined; inClear: boolean; scopeArg: string | undefined; callee: string }> = []
  // `case 'clear'` alone is ambiguous: Chat has two switches that both handle
  // a "clear" command (`switch (name)` for `/clear`, `switch (command.kind)`
  // for `/goal clear`). Only the former runs the session reset.
  const scanResets = (node: ts.Node, effectText: string | undefined, inClear: boolean, inNameSwitch: boolean): void => {
    const effectName = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name.text
      : ts.isCallExpression(node) && ts.isIdentifier(node.expression) ? node.expression.text : undefined
    const nextEffectText = effectName === 'useEffect' || effectName === 'useLayoutEffect'
      ? node.getText(chatAst)
      : effectText
    const nextSwitch = ts.isSwitchStatement(node) ? node.expression.getText(chatAst) === 'name' : inNameSwitch
    const nextInClear = inClear
      || (inNameSwitch && ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'clear')
    if (ts.isCallExpression(node)) {
      // Suffix match plus the import binding: an aliased or property-accessed
      // call still counts, or a refactor would turn a real reset into a
      // silently unscanned one.
      const callee = node.expression.getText(chatAst)
      if (/(^|\.)resetRevealSession$/u.test(callee)) {
        resetSites.push({ effectText: nextEffectText, inClear: nextInClear, scopeArg: node.arguments[0]?.getText(chatAst), callee })
      }
    }
    ts.forEachChild(node, child => scanResets(child, nextEffectText, nextInClear, nextSwitch))
  }
  scanResets(chatAst, undefined, false, false)
  check(
    resetSites.some(site => site.effectText?.includes('channel.agentId') === true),
    'E3a Chat resets reveal state in the effect that watches channel.agentId',
  )
  check(resetSites.some(site => site.inClear), 'E3b Chat resets reveal state in the /clear branch')
  // A bare reset wipes every root: each call site must name this root's scope.
  check(
    resetSites.length > 0 && resetSites.every(site => site.scopeArg?.includes('revealScope') === true),
    'E3d every Chat reset is scoped to this root (a bare reset would clear a sibling root)',
    resetSites.map(site => site.scopeArg ?? '<none>').join(', '),
  )
  // The reset that actually releases a replaced keyspace is the cleanup of the
  // effect that depends on the scope: a rebind bumps the binding generation,
  // and the agent-id effect above deliberately skips its reset when the
  // keyspace already moved (`sameKeyspace`), while a same-session re-adopt
  // leaves the agent id unchanged and the effect never runs at all. Without
  // this release, every replaced scope's cursors and completed keys stay in
  // the module tables for the life of the process.
  check(
    resetSites.some(site => site.effectText?.includes('[revealScope]') === true),
    'E3f Chat releases a replaced scope in the effect that depends on it (a rebind must not leak the old keyspace)',
    resetSites.map(site => site.effectText === undefined ? '<none>' : 'effect').join(', '),
  )
  // Delivering the scope is a separate promise from naming it in the reset:
  // without the Provider (or with another value) rows would read bare keys.
  let scopeDelivered = false
  const scanProvider = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(chatAst) === 'RevealScopeContext.Provider') {
      const value = node.openingElement.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(chatAst) === 'value')
      if (value !== undefined && ts.isJsxAttribute(value) && value.initializer?.getText(chatAst) === '{revealScope}') scopeDelivered = true
    }
    ts.forEachChild(node, scanProvider)
  }
  scanProvider(chatAst)
  check(scopeDelivered, 'E3e Chat hands the reveal scope to its subtree through RevealScopeContext.Provider')
  // A re-resume replays its rows in the commit that bumps the generation, so
  // the generation belongs in the keys (a reset would run after that frame).
  let scopedToBinding = false
  const scanScope = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'revealScope' && node.initializer !== undefined) {
      if (node.initializer.getText(chatAst).includes('bindingGeneration')) scopedToBinding = true
    }
    ts.forEachChild(node, scanScope)
  }
  scanScope(chatAst)
  check(scopedToBinding, 'E3c the reveal scope carries the binding generation (a re-resume keys fresh)')
  resetRevealForTest()
}

// G: reveal memory is per Chat root. The tables are module-level (the render
// path reads them), so two roots — two renderers, two stdout streams, each
// with its own agent and row ids — share them unless the key names a scope.
// A rebind in one root used to clear the other's completed keys, and that
// root's history re-typewrote from its first character.
console.log('--- G: per-root reveal scopes ---')
{
  resetRevealForTest()
  const keyA = scopeRevealKey('root-a', 'a1')
  const keyB = scopeRevealKey('root-b', 'a1')
  const toolKey = scopeRevealKey('root-b', 'tool:c1')
  check(
    revealLengthOf(keyA, 'finished', { enabled: true, active: false }) === 'finished'.length,
    'G1 a history read in root A paints full',
  )
  snapReveal(keyA)
  check(
    revealLengthOf(keyA, 'finished', { enabled: true, active: true }) === 'finished'.length,
    'G2 a completed key in root A paints full',
  )
  // `snapReveal` only records a key that already has a cursor, so root B needs
  // a real read first: snapping a never-read key made G4 pass under any reset
  // implementation, including one whose prefix never matches.
  check(
    revealLengthOf(keyB, 'finished', { enabled: true, active: false }) === 'finished'.length,
    'G1 a history read in root B paints full',
  )
  snapReveal(keyB)
  check(
    revealLengthOf(keyB, 'finished', { enabled: true, active: true }) === 'finished'.length,
    'G2 root B completes its own key',
  )
  // Seed a LIVE count cursor, not a history read: `active: false` returns the
  // total without creating anything, so snapping it is a no-op and G4b below
  // would pass for any reset implementation.
  revealLinesOf(toolKey, 30, { enabled: true, active: true })
  snapReveal(toolKey)
  check(
    revealLinesOf(toolKey, 30, { enabled: true, active: true }) === 30,
    'G4a a snapped tool-card cursor paints full until something drops its completion',
  )
  resetRevealSession('root-b')
  check(
    revealLengthOf(keyA, 'finished', { enabled: true, active: true }) === 'finished'.length,
    'G3 resetting root B keeps root A\'s completed key (no cross-root re-typewrite)',
  )
  check(
    revealLengthOf(keyB, 'live', { enabled: true, active: true }) === 0,
    'G4 resetting root B drops root B\'s own keys',
  )
  check(
    revealLinesOf(toolKey, 30, { enabled: true, active: true }) === 0,
    'G4b resetting root B drops its tool-card cursor too (count cursors are keyed the same way)',
  )
  check(
    (() => { resetRevealForTest(); return revealLengthOf(keyA, 'finished', { enabled: true, active: true }) })() === 0,
    'G5 the test seam still clears every root at once',
  )
}

// G6/G7: the wiring, not just the primitive. Two roots render the SAME row id
// with the same fresh row; a shared keyspace makes the second root inherit the
// first root's completed memory (its row paints instantly and never animates),
// and makes the first root's history re-typewrite after the second resets.
{
  resetRevealForTest()
  const rows: ChatRow[] = [
    { id: 7, kind: 'assistant', text: LONG_TEXT, streaming: false, fresh: true },
  ]
  const scoped = (scope: string): React.ReactNode => (
    <RevealScopeContext.Provider value={scope}>
      <MessageList rows={rows} smoothStreaming {...listProps} />
    </RevealScopeContext.Provider>
  )
  await withTerminal(
    () => scoped('root-a'),
    async screen => {
      check(await settled(() => screen().includes('omega-end'), { timeoutMs: 6000 }), 'G6 root A finishes its reveal')
    },
  )
  await withTerminal(
    () => scoped('root-b'),
    async screen => {
      await sleep(60) // 固定窗:墙钟 只看首帧后的两拍，此时全长文本不可能揭完
      check(
        !screen().includes('omega-end'),
        "G7 root B animates its own row even though root A completed the same id",
      )
      await sleep(2600) // 固定窗:墙钟 等 B 自己追平整段
      check(screen().includes('omega-end'), 'G7 root B finishes its reveal')
      // A rebind inside root B clears only root B's keys.
      resetRevealSession('root-b')
    },
  )
  await withTerminal(
    () => scoped('root-a'),
    async screen => {
      await sleep(60) // 固定窗:墙钟 首帧后两拍，被误清时会从头打字
      check(
        screen().includes('omega-end'),
        "G7 root A's finished row still paints full after root B reset",
      )
    },
  )
  resetRevealForTest()
}

// F: `fresh` is a live-only claim (channel-view.ts). A replay batch — resume,
// rebind, a reattaching client — folds the session's own durable deltas
// through the same row factory a live turn uses, so an unguarded `fresh: true`
// there made every replayed row claim it had just arrived and the transcript
// typewrote its history on the first frame of a resume (#1787). Row ids stay
// stable across a replay, so the reuse path has to strip the flag too.
console.log('--- F: replayed history is never marked fresh ---')
{
  // Same boundary cast the golden pipeline uses (projection-golden.ts:129).
  const logText = await readFile(new URL('./fixtures/dsh/v3-turns.jsonl', import.meta.url), 'utf8')
  const log = logText.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as unknown) as Parameters<ReturnType<typeof createDshTranslator>['translateReplay']>[0]
  const translator = createDshTranslator({ tools: () => undefined, scope: () => ({}), attachments: () => undefined })
  const live = createProjectorHarness({ agentPreset: 'ptc' })
  for (const event of log) live.apply(translator.translateEvent(event), false)
  live.projector.settleStreaming()
  const liveFresh = live.state.rows.filter(row => row.kind === 'assistant' && row.fresh === true).map(row => row.id)
  check(liveFresh.length > 0, 'F1 live assistant rows keep the fresh flag (live text still reveals)', `ids=${liveFresh.join(',')}`)

  live.apply(translator.translateReplay(log), true)
  live.projector.settleStreaming()
  const reusedStale = live.state.rows.filter(row => row.fresh === true).map(row => row.id)
  check(
    reusedStale.length === 0,
    'F2 replay over painted rows clears fresh (rebind repaints instead of re-types)',
    `ids=${reusedStale.join(',')}`,
  )

  const cold = createProjectorHarness({ agentPreset: 'ptc' })
  cold.apply(translator.translateReplay(log), true)
  cold.projector.settleStreaming()
  const coldStale = cold.state.rows.filter(row => row.fresh === true).map(row => row.id)
  check(
    cold.state.rows.length > 0 && coldStale.length === 0,
    'F3 a cold replay paints history without fresh (resume first frame)',
    `rows=${cold.state.rows.length} ids=${coldStale.join(',')}`,
  )
  const assistants = (h: typeof cold): number => h.state.rows.filter(row => row.kind === 'assistant').length
  check(assistants(live) === assistants(cold), 'F4 replay reuses painted assistant rows instead of duplicating them', `${assistants(live)} vs ${assistants(cold)}`)

  // F6: everything above reads the projector's mutable `state.rows`. The UI
  // sees frozen snapshots through the read view, which reuses the previous
  // array and row copies when their revisions did not move — so dropping
  // `fresh` without marking both would leave panels typewriting history while
  // every assertion above stays green.
  const viewer = createChannelReadView(() => {})
  const repaint = createProjectorHarness({ agentPreset: 'ptc' })
  for (const event of log) repaint.apply(translator.translateEvent(event), false)
  repaint.projector.settleStreaming()
  const before = viewer(repaint.state.rows, 1) as readonly ChatRow[]
  const beforeFresh = before.filter(row => row.fresh === true).length
  check(beforeFresh > 0, 'F6 the read view serves live rows with fresh', `fresh=${beforeFresh}`)
  repaint.apply(translator.translateReplay(log), true)
  repaint.projector.settleStreaming()
  const after = viewer(repaint.state.rows, 2) as readonly ChatRow[]
  const afterFresh = after.filter(row => row.fresh === true).length
  check(afterFresh === 0, 'F6 a snapshot taken after the replay no longer claims fresh', `fresh=${afterFresh}`)
}

// F5: a replayed row that a live turn continues must resume where the
// painted text ended. History paints full through the inactive branch, which
// used to leave no cursor behind; the live continuation then created one at
// zero and typewrote the already-visible row from its first character.
resetRevealForTest()
{
  const painted = 'replayed answer already on screen'
  check(
    revealLengthOf('a9', painted, { enabled: true, active: false }) === painted.length,
    'F5 a replayed row paints full',
  )
  const grown = `${painted} and a live tail`
  const resumed = revealLengthOf('a9', grown, { enabled: true, active: true })
  check(
    resumed >= painted.length,
    'F5 a live continuation never restarts at zero after the history read (it may paint whole if a tick already settled the cursor)',
    `len=${resumed}/${grown.length}`,
  )
  resetRevealForTest()
}

console.log('')
if (failures > 0) {
  console.error(`verify-smooth-reveal: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('verify-smooth-reveal: all checks passed')

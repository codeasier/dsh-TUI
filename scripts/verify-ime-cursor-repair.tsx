/**
 * verify-ime-cursor-repair — 输入法提交后的「光标行回收」回归（2026-10）。
 *
 * 用户报告：中文输入法（拼音）合成时，输入框右侧出现**黑方块条**、光标溢出
 * 输入框——启动页与聊天页都在。取证结论（见 PR 说明）：
 *   1. 终端/输入法按物理光标自己画 preedit，并把那一行用**终端默认底色**
 *      （#111111）刷掉一段。应用侧帧模型里那些格子仍是画布底色（#191919），
 *      逐格 diff 看不出任何变化 → **此后每一帧都不会重写它们**，黑带常驻。
 *   2. 只有整段重画（repaint()/Ctrl+L）能修回来——本组钉的就是新加的
 *      「光标行回收」（Ink#repaintCursorRow + App 的 IME 提交触发）：
 *      IME 提交是应用唯一可靠的合成结束信号，提交后回收声明光标所在的行。
 *
 * 断言口径（逐格读终端背景，xterm cell API）：
 *   A. 基线：画布挂载树下，输入行没有「终端默认底」的格子（D=0）；
 *   B. 带外涂黑后，普通帧裁掉**输入框右缘之外**的默认底（IME 尾裁，光标条
 *      不许停在页边距），框内光标旁的损伤留着——整行回收仍只在提交时发生；
 *   C. 喂一个中文字（IME 提交）→ 行被重写，D 归零；
 *   D. 喂方向键（非提交）→ 不回收（别在合成期间擦掉 preedit）；
 *   E. `isImeCommit` 判定表（含粘贴/控制字节/多码点）。
 *
 * 运行：node --import tsx/esm scripts/verify-ime-cursor-repair.tsx
 * （CI 组：render-scroll，紧随 verify-launchpad——同一套画布挂载树夹具。）
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import fakeHome from './lib/fake-home.mjs'
import { settle, settled, sleep, viewportLines, writeParsed } from './lib/term-test.mjs'

void fakeHome

let failures = 0
let checks = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  if (ok) console.log(`ok   ${name}`)
  else {
    failures++
    console.error(`FAIL ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

const { Terminal: XTerm } = xterm
const [{ render, ThemeProvider, AlternateScreen }, { Launchpad }, { resolveLaunchpadActions }, { PageMargin }, { isImeCommit }] = await Promise.all([
  import('../src/ui.js'),
  import('../src/screens/Launchpad.js'),
  import('../src/components/launchpadActions.js'),
  import('../src/components/PageMargin.js'),
  import('../src/ink/ime-commit.js'),
])

class FakeStdout extends Writable {
  isTTY = true
  constructor(private readonly terminal: InstanceType<typeof XTerm>) { super() }
  get columns(): number { return this.terminal.cols }
  get rows(): number { return this.terminal.rows }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.terminal.write(String(chunk), callback)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, callback: () => void): void { callback() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}

// ── E. isImeCommit 判定表 ───────────────────────────────────────────────────
{
  const key = (sequence: string | undefined, extra: Partial<{ isPasted: boolean; kind: string }> = {}) => ({
    kind: 'key',
    fn: false,
    name: undefined,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence,
    raw: sequence,
    isPasted: false,
    ...extra,
  }) as never
  for (const [name, k, expected] of [
    ['中文字（IME 提交）', key('已'), true],
    ['日文假名', key('あ'), true],
    ['带重音的拉丁字母', key('é'), true],
    ['emoji', key('🚀'), true],
    ['多码点 ASCII 突发', key('ab'), true],
    ['单个 ASCII 字母', key('a'), false],
    ['方向键（CSI）', key('\u001b[D'), false],
    ['裸 ESC', key('\u001b'), false],
    ['裸 LF（Ctrl+J legacy）', key('\n'), false],
    ['粘贴载荷', key('已粘贴', { isPasted: true }), false],
    ['空序列', key(''), false],
    ['非按键事件', key('已', { kind: 'mouse' }), false],
  ] as const) {
    check(`E isImeCommit：${name}`, isImeCommit(k) === expected, `got=${String(isImeCommit(k))}`)
  }
}

// ── A–D. 光标行回收（画布挂载树）────────────────────────────────────────────
const COLS = 110
const ROWS = 36
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdout = new FakeStdout(term)
const stdin = new FakeStdin()
let query = '及光标溢出对话框问题仍未解决，且这不仅仅是启动界面，用户输入框也'

function Harness(): React.ReactNode {
  const [q, setQ] = React.useState(query)
  React.useEffect(() => { setQ(query) }, [query])
  void setQ
  return (
    <AlternateScreen>
      <PageMargin>
        <Launchpad
          query={q}
          cursorOffset={q.length}
          focusIndex={-1}
          isTerminalFocused
          whale={false} whaleIdle={false} whaleGirl={false} starred={false} firstRun={false}
          actions={resolveLaunchpadActions({ lastSessionTitle: 'x', jobsRunning: false, updateAvailable: false, starDue: false })}
          cwd="/tmp/x" branch="main" tuiVersion="9.9.9"
          onQueryChange={() => {}} onSubmit={() => {}} onEscape={() => {}}
          onAction={() => {}} onFocusChange={() => {}} onBlankClick={() => {}}
        />
      </PageMargin>
    </AlternateScreen>
  )
}

const app = await render(
  <ThemeProvider theme="dark"><Harness /></ThemeProvider>,
  { stdin: stdin as never, stdout: stdout as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
)
// 等第一帧真的画出来（框顶角是这一屏的锚点），不用固定 sleep。
await settled(() => viewportLines(term).some(line => line.includes('╭')))

/** 输入框的框顶行、文本行与「终端默认底」格子数。 */
function inspect(): { textRow: number; right: number; holes: number[] } {
  const buf = term.buffer.active
  let top = -1, right = -1
  for (let y = 0; y < ROWS && top < 0; y++) {
    for (let x = 0; x < COLS; x++) {
      if (buf.getLine(y)?.getCell(x)?.getChars() === '╭') {
        top = y
        for (let rx = COLS - 1; rx > x; rx--) if (buf.getLine(y)?.getCell(rx)?.getChars() === '╮') { right = rx; break }
      }
    }
  }
  const textRow = top + 1
  const holes: number[] = []
  for (let x = 0; x < COLS; x++) {
    if (buf.getLine(textRow)?.getCell(x)?.isBgDefault() === true) holes.push(x)
  }
  return { textRow, right, holes }
}

/** 模拟终端/输入法：从 from 列起把该行刷成终端默认底色（带外写入）。 */
function paintBand(row: number, from: number): void {
  term.write(`\x1b[${row + 1};${from + 1}H\x1b[0m` + ' '.repeat(COLS - from))
}

const base = inspect()
check('A 基线：画布树下输入行没有终端默认底的格子（D=0）',
  base.holes.length === 0, `holes=${base.holes.length}@${base.holes[0]}`)

// 输入法/终端涂的是「光标右侧到行尾」那一段（preedit 就画在光标处、向右长）。
// 只涂这一段才能验出真正的缺陷：内容变化只重写光标左侧的格子，右尾的带外
// 损伤照样留着。
const caretCol = term.buffer.active.cursorX
const bandStart = Math.min(caretCol + 2, COLS - 20)
writeParsed(term, '')
paintBand(base.textRow, bandStart)
await writeParsed(term, '')
{
  const painted = inspect()
  check('B0 带外涂黑生效（模拟输入法把光标右侧刷成默认底）',
    painted.holes.length >= 15, `holes=${painted.holes.length} start=${bandStart}`)
}
// 普通帧会裁掉输入框右缘之外的默认底（IME 尾裁），但光标旁、框内的那一段
// 必须留着——那是 preedit 可能占用的格子，整行回收仍只在提交时发生。
await sleep(700) // 固定窗:墙钟 光标闪烁相位（~550ms）就是被测语义：跨一个相位看 diff
{
  const afterTick = inspect()
  const pastBox = afterTick.holes.filter(x => x > afterTick.right)
  const inside = afterTick.holes.filter(x => x <= afterTick.right)
  check('B1 普通帧裁掉框外黑带，框内光标旁的损伤留着（别擦 preedit）',
    pastBox.length === 0 && inside.length >= 4,
    `past=${pastBox.length} inside=${inside.length}@${inside[0]} right=${afterTick.right}`)
}
query = query + '吗'
app.rerender(<ThemeProvider theme="dark"><Harness /></ThemeProvider>)
await settled(() => viewportLines(term).some(line => line.includes('吗')))
{
  const afterEdit = inspect()
  const pastBox = afterEdit.holes.filter(x => x > afterEdit.right)
  check('B2 内容变化也不把框外默认底留在行尾，框内损伤仍在',
    pastBox.length === 0 && afterEdit.holes.length >= 4,
    `holes=${afterEdit.holes.length}@${afterEdit.holes[0]} past=${pastBox.length}`)
}

// C. IME 提交 → 回收光标行。
stdin.write('已')
await settle(() => inspect().holes.length === 0, { timeoutMs: 2000 }).catch(() => {})
{
  const repaired = inspect()
  check('C IME 提交（一个中文字）后光标行被重写：终端默认底归零',
    repaired.holes.length === 0, `holes=${repaired.holes.length}@${repaired.holes[0]}`)
}

// D. 非提交键不回收（合成期间别擦掉终端自己画的 preedit）。
const tail = inspect()
paintBand(tail.textRow, Math.min(term.buffer.active.cursorX + 2, COLS - 20))
await writeParsed(term, '')
stdin.write('\u001b[C')
await sleep(350) // 固定窗:探针 断言「不得改变」（方向键不许回收）：等观察窗再验不变量
{
  const afterArrow = inspect()
  const pastBox = afterArrow.holes.filter(x => x > afterArrow.right)
  check('D 方向键不回收框内损伤（合成期间别擦 preedit），框外仍被裁掉',
    pastBox.length === 0 && afterArrow.holes.length >= 4,
    `holes=${afterArrow.holes.length} past=${pastBox.length}`)
}

app.unmount()
await sleep(80) // 固定窗:pacing 卸载后给渲染器一个收尾窗口（无可轮询锚点）

// ── F. 内联模式（非备用屏）同样成立 ─────────────────────────────────────────
// 主屏模式的 park 走**相对**移动、帧坐标与滚动区相关，回收（清 prev 帧的格子
// → 下一帧重写）必须同样成立：这里不套 AlternateScreen 再走一遍 A/C 两步。
{
  const term2 = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout2 = new FakeStdout(term2)
  const stdin2 = new FakeStdin()
  let query2 = '内联模式的中文草稿也要能回收光标行'
  function InlineHarness(): React.ReactNode {
    const [q, setQ] = React.useState(query2)
    React.useEffect(() => { setQ(query2) }, [query2])
    void setQ
    return (
      <PageMargin>
        <Launchpad
          query={q} cursorOffset={q.length} focusIndex={-1} isTerminalFocused
          whale={false} whaleIdle={false} whaleGirl={false} starred={false} firstRun={false}
          actions={resolveLaunchpadActions({ lastSessionTitle: 'x', jobsRunning: false, updateAvailable: false, starDue: false })}
          cwd="/tmp/x" branch="main" tuiVersion="9.9.9"
          onQueryChange={() => {}} onSubmit={() => {}} onEscape={() => {}}
          onAction={() => {}} onFocusChange={() => {}} onBlankClick={() => {}}
        />
      </PageMargin>
    )
  }
  const app2 = await render(
    <ThemeProvider theme="dark"><InlineHarness /></ThemeProvider>,
    { stdin: stdin2 as never, stdout: stdout2 as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
  )
  await settled(() => viewportLines(term2).some(line => line.includes('╭')))
  const inspect2 = (): number[] => {
    const buf = term2.buffer.active
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (buf.getLine(y)?.getCell(x)?.getChars() !== '╭') continue
        const row = y + 1
        const holes: number[] = []
        for (let col = 0; col < COLS; col++) {
          if (buf.getLine(row)?.getCell(col)?.isBgDefault() === true) holes.push(col)
        }
        return holes
      }
    }
    return []
  }
  const inlineBase = inspect2()
  check('F0 内联模式基线：输入行没有终端默认底的格子', inlineBase.length === 0, `holes=${inlineBase.length}`)
  const row = (() => {
    const buf = term2.buffer.active
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) if (buf.getLine(y)?.getCell(x)?.getChars() === '╭') return y + 1
    }
    return -1
  })()
  const start = Math.min(term2.buffer.active.cursorX + 2, COLS - 20)
  await writeParsed(term2, `\x1b[${row + 1};${start + 1}H\x1b[0m` + ' '.repeat(COLS - start))
  check('F1 内联模式带外涂黑生效', inspect2().length >= 15, `holes=${inspect2().length}`)
  stdin2.write('已')
  await settle(() => inspect2().length === 0, { timeoutMs: 2000 }).catch(() => {})
  check('F2 内联模式 IME 提交后同样回收光标行（终端默认底归零）',
    inspect2().length === 0, `holes=${inspect2().length}`)
  app2.unmount()
  await sleep(80) // 固定窗:pacing 同 F 之前的卸载收尾窗口
}

if (failures === 0) console.log(`\nverify-ime-cursor-repair: ${checks} checks, all passed`)
else console.error(`\nverify-ime-cursor-repair: ${failures} of ${checks} checks FAILED`)
process.exit(failures === 0 ? 0 : 1)

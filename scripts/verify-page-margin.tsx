/**
 * verify-page-margin — 根级页边距（PageMargin）契约：
 * 一些终端（Windows Terminal 的 PowerShell profile 等）自带内缩 padding，
 * 另一些（裸 WSL/tmux/SSH）完全没有——文字直接贴屏幕四边。PageMargin
 * 在根布局加一圈小边距（左右 3 列、上下 1 行），同时把 TerminalSize
 * 收敛成内容区尺寸、经 PageInsetContext 报告内容区相对屏幕原点的偏移。
 *
 * 断言（headless xterm 40×12，fullscreen：AlternateScreen > PageMargin）：
 *   1. 内容区尺寸：useTerminalSize() 报告 34×10（40-2×3, 12-2×1）；
 *   2. inset：PageInsetContext 报告 {x:3, y:1}；
 *   3. 顶/底边距：第 0 行与最后一行全空；
 *   4. 左边距：内容起始于第 3 列（三格前导空格）；
 *   5. 左右边距对称：E 行从第 3 列到第 36 列，第 37/38/39 列空白；
 *   6. 档位切换（模块级 store → useSyncExternalStore 即时重布局）：
 *      roomy 32x8/inset 4,2/上下各两行空，none 40x12/无内缩/END 贴底；
 *   7. 自定义规格：`NxM` 解析/边界/规范化单元检查，3x1 与单值 5（→5x1）
 *      实时重布局，非法值回退 normal；
 *   8. 出血契约：页面级分割线（bleed）自第 0 列画满整个终端、文本仍在
 *      第 3 列；独立 prompt 默认不出血，竖条留在第 3 列；Chat prompt
 *      竖条出血至第 1 列、pointer 第 3 列、文字第 5 列，滚动轨贴 98/99 列；
 *   9. 对照组（无 PageMargin）：内容仍全宽、inset=0 —— 既有 verify
 *      直接挂 Chat 的「全宽」契约不变。
 *
 * 运行：node --import tsx/esm scripts/verify-page-margin.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen, Box, Text }, { PageMargin, PageInsetContext }, { useTerminalSize }, { settle, sleep }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/PageMargin.js'),
  import('../src/ink/hooks/use-terminal-size.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 40, ROWS = 12
let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdin = new FakeStdin(), stdout = new FakeStdout(), stderr = new FakeStderr()

/** 探针：报告内容区尺寸、inset，并画一条顶到底的可测布局。 */
function Probe() {
  const size = useTerminalSize()
  const inset = React.useContext(PageInsetContext)
  return (
    <Box flexDirection="column" flexGrow={1} width="100%">
      <Text>{`size=${size.columns}x${size.rows} inset=${inset.x},${inset.y}`}</Text>
      <Text>{`|${'E'.repeat(Math.max(0, size.columns - 2))}|`}</Text>
      <Box flexGrow={1} />
      <Text>{'END'}</Text>
    </Box>
  )
}

function screenLines(): string[] {
  const buffer = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '')
}

const inst = await render(
  <AlternateScreen>
    <PageMargin>
      <Probe />
    </PageMargin>
  </AlternateScreen>,
  { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
)

// 等首帧画出探针行再断言（渲染经节流 + xterm 异步解析）。
await settle(() => screenLines().some(line => line.includes('size=34x10')))

const lines = screenLines()
check('内容区尺寸报告 34x10（终端 40x12 扣除页边距）', lines.some(l => l.includes('size=34x10 inset=3,1')))
check('inset 报告 {x:3, y:1}', lines.some(l => l.includes('inset=3,1')))
const topBlank = lines[0]?.trim() === ''
const bottomBlank = lines[ROWS - 1]?.trim() === ''
check('顶行空白（上行边距）', topBlank, JSON.stringify(lines[0]))
check('底行空白（下行边距）', bottomBlank, JSON.stringify(lines[ROWS - 1]))
check('会话底色覆盖四角空白边距和正文',
  [[0, 0], [COLS - 1, 0], [0, ROWS - 1], [COLS - 1, ROWS - 1], [3, 1]].every(([x, y]) => {
    const cell = term.buffer.active.getLine(term.buffer.active.baseY + y!)?.getCell(x!)
    return cell?.isBgRGB() === true && cell.getBgColor() === 0x191919
  }))
const sizeRow = lines.findIndex(l => l.includes('size='))
const edgeRow = lines.findIndex(l => l.trimStart().startsWith('|'))
const endRow = lines.findIndex(l => l.trimStart().startsWith('END'))
check('size 行从第 3 列开始', sizeRow >= 0 && lines[sizeRow]!.startsWith('   size='), JSON.stringify(lines[sizeRow]))
check('边距内 E 行从第 3 列开始', edgeRow >= 0 && lines[edgeRow]!.startsWith('   |'), JSON.stringify(lines[edgeRow]))
// E 行 = 3 空格 + 34 内容列。帧切换时渲染器会把旧行残留单元格清成
// 空格（xterm buffer 中显示为 " "，translateToString 不减），所以长度
// 断言统一先 trimEnd 再量。
check('右列对称：E 行止于第 36 列（37/38/39 列空白）', edgeRow >= 0 && lines[edgeRow]!.startsWith('   |') && lines[edgeRow]!.trimEnd().length === 37 && lines[edgeRow]!.trimEnd().endsWith('|'), `len=${lines[edgeRow]?.trimEnd().length}`)
check('END 停在内容区底行（第 10 行，0-based）', endRow === ROWS - 2 && lines[endRow]!.startsWith('   '), JSON.stringify(lines[endRow]))

// ── 档位切换：模块级 store 驱动 PageMargin 即时重布局（/settings 实机路径）──
const { applyPageMargin } = await import('../src/tuiDisplayPrefs.js')
applyPageMargin('roomy')
await settle(() => screenLines().some(l => l.includes('size=32x8 inset=4,2')))
const roomy = screenLines()
check('roomy：内容区 32x8（40-2×4, 12-2×2）', roomy.some(l => l.includes('size=32x8 inset=4,2')))
check('roomy：顶部两行空白', (roomy[0]?.trim() ?? 'x') === '' && (roomy[1]?.trim() ?? 'x') === '', JSON.stringify(roomy.slice(0, 3)))
check('roomy：底部两行空白', (roomy[ROWS - 1]?.trim() ?? 'x') === '' && (roomy[ROWS - 2]?.trim() ?? 'x') === '', JSON.stringify(roomy.slice(-3)))
const roomyEdge = roomy.findIndex(l => l.trimStart().startsWith('|'))
check('roomy：内容起始第 4 列且止于第 35 列', roomyEdge >= 0 && roomy[roomyEdge]!.startsWith('    |') && roomy[roomyEdge]!.trimEnd().length === 36, `len=${roomy[roomyEdge]?.trimEnd().length}`)
applyPageMargin('none')
await settle(() => screenLines().some(l => l.includes('size=40x12 inset=0,0')))
const none = screenLines()
check('none：内容区 40x12（无内缩）', none.some(l => l.includes('size=40x12 inset=0,0')))
check('none：首行即内容（无顶部边距）', none[0]!.includes('size=40x12'), JSON.stringify(none[0]))
check('none：END 贴最后一行', none[ROWS - 1]!.trim() === 'END', JSON.stringify(none[ROWS - 1]))
check('none：关闭边距后仍保留会话底色',
  term.buffer.active.getLine(term.buffer.active.baseY)?.getCell(COLS - 1)?.getBgColor() === 0x191919)

// ── 自定义规格：NxM（预设之外手动填数值）──
const { parsePageMarginSpec, normalizePageMargin } = await import('../src/tuiDisplayPrefs.js')
check('单元：parsePageMarginSpec("2,1") → "2x1"', parsePageMarginSpec('2,1') === '2x1')
check('单元：parsePageMarginSpec("3x1") → "3x1"', parsePageMarginSpec('3x1') === '3x1')
check('单元：parsePageMarginSpec("9x9") 超界 → undefined', parsePageMarginSpec('9x9') === undefined)
check('单元：normalizePageMargin("5") 规范化为 "5x1"', normalizePageMargin('5') === '5x1')
check('单元：normalizePageMargin("abc") 回退 normal', normalizePageMargin('abc') === 'normal')
applyPageMargin('3x1')
await settle(() => screenLines().some(l => l.includes('size=34x10 inset=3,1')))
const custom = screenLines()
const customEdge = custom.findIndex(l => l.trimStart().startsWith('|'))
check('自定义 3x1：内容区 34x10（40-2×3, 12-2×1）', custom.some(l => l.includes('size=34x10 inset=3,1')))
check('自定义 3x1：内容起始第 3 列且止于第 36 列', customEdge >= 0 && custom[customEdge]!.startsWith('   |') && custom[customEdge]!.trimEnd().length === 37, `len=${custom[customEdge]?.trimEnd().length}`)
applyPageMargin('5')
await settle(() => screenLines().some(l => l.includes('size=30x10 inset=5,1')))
check('自定义 5（单值 → 5x1）：内容区 30x10', screenLines().some(l => l.includes('size=30x10 inset=5,1')))
applyPageMargin('abc')
await settle(() => screenLines().some(l => l.includes('size=34x10 inset=3,1')))
check('自定义非法值回退正常档（34x10）', screenLines().some(l => l.includes('size=34x10 inset=3,1')))
applyPageMargin('normal')
await settle(() => screenLines().some(l => l.includes('size=34x10 inset=3,1')))
check('恢复 normal：内容区回到 34x10', screenLines().some(l => l.includes('size=34x10 inset=3,1')))

// ── 出血（full-bleed）契约：结构线直通终端边缘，文本留在内容列 ──
// 页面级分割线从第 0 列画到最后一列；文本行仍从内容列开始。
const { Divider } = await import('../src/components/design-system/Divider.js')
const { UserPromptMessage } = await import('../src/components/messages/UserPromptMessage.js')
function BleedProbe() {
  return (
    <Box flexDirection="column" flexGrow={1} width="100%">
      <Text>{'line-content'}</Text>
      <Divider bleed />
      <Text>{'tail'}</Text>
      <UserPromptMessage text={'standalone\n独立续行'} marginTopOnTurn={false} />
    </Box>
  )
}
const termB = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdoutB = new (class extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { termB.write(String(chunk), cb) }
})()
const stdinB = new FakeStdin(), stderrB = new FakeStderr()
inst.unmount()
await sleep(150) // 固定窗:pacing 卸载与下一个实例挂载之间的步间，无可观测完成条件
const instB = await render(
  <AlternateScreen>
    <PageMargin>
      <BleedProbe />
    </PageMargin>
  </AlternateScreen>,
  { stdout: stdoutB as any, stdin: stdinB as any, stderr: stderrB as any, exitOnCtrlC: false, patchConsole: false },
)
function linesB(): string[] {
  const buffer = termB.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '')
}
await settle(() => linesB().some(l => l.trimStart() === '─'.repeat(COLS)))
const linesBNow = linesB()
check('分割线出血：─ 行自第 0 列画满 40 列', linesBNow.some(l => l.trimStart() === '─'.repeat(COLS) && l.trimEnd() === '─'.repeat(COLS)))
check('分割线出血：文本行仍在第 3 列（内容留边距）', linesBNow.some(l => l.includes('line-content') && l.startsWith('   line-content')), JSON.stringify(linesBNow.find(l => l.includes('line-content'))))
check('分割线出血：行高仍占 1 行（flow 不塌）', linesBNow.filter(l => l.trimStart() === '─'.repeat(COLS)).length >= 1)

const standaloneRow = linesBNow.findIndex(l => l.includes('standalone'))
const cellB = (x: number, y: number) => termB.buffer.active.getLine(termB.buffer.active.baseY + y)?.getCell(x)
check('独立 prompt：默认不出血，竖条第 3 列、pointer 第 5 列、文字第 7 列',
  standaloneRow >= 0 && linesBNow[standaloneRow]!.startsWith('   ┃ ❯ standalone'))
check('独立 prompt：续行只有两格 pointer 缩进，竖条跨上下 padding 连续且为黄色',
  linesBNow[standaloneRow + 1]?.startsWith('   ┃   独立续行') === true &&
  [standaloneRow - 1, standaloneRow, standaloneRow + 1, standaloneRow + 2].every(y =>
    cellB(3, y)?.getChars() === '┃' && cellB(3, y)?.getFgColor() === 0xffdf80) &&
  [standaloneRow - 1, standaloneRow + 2].every(y => linesBNow[y]?.trim() === '┃'))
check('独立 prompt：表面留在内容区（3..36），左右页边距保留会话底色',
  [3, 36].every(x => cellB(x, standaloneRow)?.getBgColor() === 0x303030) &&
  [0, 1, 2, 37, 38, 39].every(x => cellB(x, standaloneRow)?.getBgColor() === 0x191919))

// ── Chat 冒烟：滚动轨贴右缘（98/99 列），prompt 表面与输入框共享出血边缘 ──
const { Chat } = await import('../src/screens/Chat.js')
const { QuestionStore } = await import('../src/dsh-adapter/questions.js')
const { LOCAL_COMMANDS, completeCommands } = await import('../src/commands.js')
const CHAT_COLS = 100, CHAT_ROWS = 40
const termC = new XTerm({ cols: CHAT_COLS, rows: CHAT_ROWS, scrollback: 0, allowProposedApi: true })
const stdoutC = new (class extends Writable {
  columns = CHAT_COLS; rows = CHAT_ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { termC.write(String(chunk), cb) }
})()
const stdinC = new FakeStdin(), stderrC = new FakeStderr()
const chatRows: any[] = []
for (let turn = 1; turn <= 8; turn++) {
  chatRows.push({ id: turn * 2 - 1, kind: 'user', text: `问题 ${turn}` })
  chatRows.push({ id: turn * 2, kind: 'assistant', text: Array.from({ length: 8 }, (_, i) => `回复 ${turn} 第 ${i + 1} 行`).join('\n') })
}
const chatListeners = new Set<() => void>()
const channel: any = {
  // 探针确定性：鲸鱼欢迎期闲置动画（默认开）不进本探针的测量窗口。
  whaleIdle: false,
  version: 0, rows: chatRows, status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [],
  tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
  working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: 0,
  pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false, sandbox: undefined },
  activityFrames: 'moon8', agentPreset: undefined, subagents: [], lastUserText: '问题 8',
  scrollGutter: 'timeline',
  subscribe(cb: () => void) { chatListeners.add(cb); return () => chatListeners.delete(cb) as unknown as void },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}
instB.unmount()
await sleep(150) // 固定窗:pacing 卸载与下一个实例挂载之间的步间，无可观测完成条件
const instC = await render(
  <AlternateScreen>
    <PageMargin>
      <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
    </PageMargin>
  </AlternateScreen>,
  { stdout: stdoutC as any, stdin: stdinC as any, stderr: stderrC as any, exitOnCtrlC: false, patchConsole: false },
)
function cellAtC(y: number, col: number): string {
  const line = termC.buffer.active.getLine(termC.buffer.active.baseY + y)
  return line?.getCell(col)?.getChars() ?? ''
}
function linesC(): string[] {
  return Array.from({ length: CHAT_ROWS }, (_, y) => termC.buffer.active.getLine(termC.buffer.active.baseY + y)?.translateToString(true) ?? '')
}
await settle(() => linesC().some(l => l.includes('┃ ❯')))
// 固定窗:待迁移 等整帧（含滚动轨）画完；同一个窗口服务下面布局断言与
// railRows 快照，拆成单条 settled 会改语义
await sleep(250)
const railRows = Array.from({ length: CHAT_ROWS }, (_, y) => cellAtC(y, 98) !== '' || cellAtC(y, 99) !== '')
// 转录 prompt 的边框与输入框表面出血到第 1 列；pointer 与正文分别在 3/5 列。
const promptRow = linesC().findIndex(l => l.includes('┃ ❯'))
const promptLine = linesC()[promptRow] ?? ''
const promptCol = promptLine.indexOf('┃')
const cellC = (x: number, y: number) => termC.buffer.active.getLine(termC.buffer.active.baseY + y)?.getCell(x)
check('Chat：用户回合竖条第 1 列、pointer 第 3 列、正文第 5 列',
  promptCol === 1 && promptLine.indexOf('❯') === 3 && promptLine.indexOf('问题') === 5,
  `rail=${promptCol} pointer=${promptLine.indexOf('❯')} text=${promptLine.indexOf('问题')}`)
check('Chat：黄色粗竖条连续跨越文字与上下各一行 padding',
  [promptRow - 1, promptRow, promptRow + 1].every(y =>
    cellC(1, y)?.getChars() === '┃' && cellC(1, y)?.getFgColor() === 0xffdf80) &&
  [promptRow - 1, promptRow + 1].every(y => linesC()[y]?.trim() === '┃'))
const composerRow = linesC().findIndex(l => l.includes('⌸'))
const surfaceEdgesC = (y: number) => Array.from({ length: CHAT_COLS }, (_, x) => x).filter(x =>
  cellC(x, y)?.getBgColor() === 0x303030)
check('Chat：prompt 文字/padding 与输入框表面同宽（1..97）且底色一致',
  composerRow >= 0 && [promptRow - 1, promptRow, promptRow + 1, composerRow].every(y => {
    const edges = surfaceEdgesC(y)
    return edges.length === CHAT_COLS - 3 && edges[0] === 1 && edges.at(-1) === CHAT_COLS - 3
  }))
check('Chat：prompt 左一格/右两格 padding 不写文字',
  [2, CHAT_COLS - 4, CHAT_COLS - 3].every(x => cellAtC(promptRow, x).trim() === '' &&
    cellC(x, promptRow)?.getBgColor() === 0x303030))
check('Chat：滚动轨在 98/99 列（贴终端右缘）', railRows.some(Boolean))
check('Chat：右缘 98/99 列只有滚动轨占用（无其他内容越界）',
  Array.from({ length: CHAT_ROWS }, (_, y) => (cellAtC(y, 98) === '' && cellAtC(y, 99) === '') || railRows[y]!).every(Boolean))
check('Chat：正文不越左缘，只有输入框图标和 prompt 黄色竖条允许出血',
  Array.from({ length: CHAT_ROWS }, (_, y) => [0, 1, 2].every(x => {
    const cell = cellC(x, y)
    const chars = cellAtC(y, x).trim()
    return chars === '' || (x > 0 && cell?.getBgColor() === 0x303030 &&
      (chars === '⌸' || (x === 1 && chars === '┃' && cell.getFgColor() === 0xffdf80)))
  })).every(Boolean))

// 对照组：无 PageMargin 的树 —— 尺寸不收敛、inset=0（verify 直挂契约不变）。
// 先卸载带边距的应用再挂对照组：同一进程并存两个 Ink 实例时，第二个实例
// 的 alt-screen 状态探测（instances.size !== 1）落空、按 inline 路径写帧
// 会丢首行——真机只有一个实例，测试里先后串行即可。
instC.unmount()
await sleep(150) // 固定窗:pacing 卸载与对照组挂载之间的步间，无可观测完成条件
const term2 = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdout2 = new (class extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term2.write(String(chunk), cb) }
})()
const stdin2 = new FakeStdin(), stderr2 = new FakeStderr()
await render(
  <AlternateScreen>
    <Probe />
  </AlternateScreen>,
  { stdout: stdout2 as any, stdin: stdin2 as any, stderr: stderr2 as any, exitOnCtrlC: false, patchConsole: false },
)
function screenLines2(): string[] {
  const buffer = term2.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '')
}
await settle(() => screenLines2().some(line => line.includes('size=40x12')))
const plain = screenLines2()
check('对照组：无页边距时尺寸仍为 40x12', plain.some(l => l.includes('size=40x12 inset=0,0')))
check('对照组：内容全宽（E 行止于第 39 列）', plain.some(l => l.trimStart().startsWith('|') && l.trimEnd().endsWith('|') && l.trimEnd().length === COLS))

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

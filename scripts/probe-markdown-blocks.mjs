#!/usr/bin/env node
/**
 * VISUAL PROBE (not a regression): render one assistant message carrying every
 * markdown construct the transcript can meet, so the styling of headings,
 * inline code, code blocks, lists, quotes and tables can be eyeballed against
 * another TUI's output.
 *
 * Run after build: `node scripts/probe-markdown-blocks.mjs [cols] [rows]`
 */
// Isolate HOME before any lib import: the real ~/.dsh-tui usage stats can
// trip the milestone "star" modal, which paints over the transcript.
await import('./lib/fake-home.mjs')

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
delete process.env.TERM_PROGRAM
delete process.env.TMUX

const [{ Writable, PassThrough }, React, xtermHeadless, { render, ThemeProvider, AlternateScreen }, { PageMargin }, { Chat }, { sleep }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../lib/types/ui.js'),
  import('../lib/types/components/PageMargin.js'),
  import('../lib/types/screens/Chat.js'),
  import('./lib/term-test.mjs'),
])

const { Terminal: XTerm } = xtermHeadless.default ?? xtermHeadless
const COLS = Number(process.argv[2] ?? 100)
const ROWS = Number(process.argv[3] ?? 60)

const MARKDOWN = `## 健康复核（只读）

- 四台改造设备均正常：**单实例**、连接稳定（\`arm 56\` / \`02 51\`）。
- \`KeepAlive\` 实际生效证据：\`15:35:53\` 自动重启并自动恢复。
- 这是一条很长的紧凑列表项，用来观察换行后的悬挂缩进：它会在终端宽度处折行，第二行应该对齐到文字列而不是破折号列。

---

- [ ] 未完成任务样例
- [x] 已完成任务样例

### 待你处理（我无法代办）

1. 隔离基线：读取产品开发规则，建独立 worktree。
2. 两机只读取证：确认实际 \`Job\` 账户、工具链与权限。
3. 性能对照：比较 \`sqlite\` 与 \`C++\` 编译耗时。

> 计划保留了两个边界：CPU 差异目前只是候选原因。

\`\`\`sh
git diff --no-index --check /dev/null specs/windows-sqlite-cache/spec.md
# (no output)
\`\`\`

| 项 | 值 |
| --- | --- |
| 应用 JSON | 532,957 B |
| WS | 533,320 B |

详见 \`specs/windows-sqlite-cache/spec.md\`（验收标准与证据记录模板）。
`

const rows = [
  { id: 0, kind: 'user', text: '检查一下 CI 恢复计划', seq: 0 },
  { id: 1, kind: 'reasoning', text: 'Troubleshooting Git commands', seq: 1, durationMs: 4700 },
  { id: 2, kind: 'assistant', text: MARKDOWN, seq: 2 },
]

function makeChannel() {
  const listeners = new Set()
  const channel = {
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: 'markdown',
    agentId: 'markdown',
    model: 'grok-4.7',
    provider: 'xai',
    tokens: { input: 0, output: 0 },
    cwd: '/tmp',
    displayCwd: '/tmp',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    pending: [],
    notifications: [],
    contextWindow: 500_000,
    reasoningEffort: 'medium',
    activityEnabled: false,
    contextBarEnabled: false,
    statusBar: {},
    agentPreset: 'standard',
    goal: undefined,
    todos: [],
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0,
    cycleMode() {},
    commandList: [],
    commandCompletions: () => [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    notify() {},
    pushLocal() {},
    subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
    emit() { channel.version += 1; for (const l of listeners) l() },
    submit() {},
    steer() {},
    removePending: () => true,
    cancel() {},
    interruptAndDeliver: () => 0,
    clear() {},
    loadOlder: () => 0,
    listModels: async () => [],
    listFiles: async () => [],
    listSessions: async () => [],
    setResumeTarget() {},
    setActivityFrames: () => true,
    activityFrames: 'claude',
    runExternalCommand: async () => '',
    mcpStatus: () => [],
    exportSession: () => null,
    initWorkspace: () => null,
    doctorInfo: () => [],
    listSubagents: async () => [],
    listPresets: async () => [],
    switchPreset: async () => false,
    switchModel: async () => false,
    rewindTo: async () => null,
    resumeTo: async () => ({ ok: false, reason: 'unavailable' }),
    newSession: async () => false,
    compact() {},
  }
  return channel
}

const term = new XTerm({ cols: COLS, rows: ROWS, allowProposedApi: true })
const stdout = new Writable({ write(chunk, _enc, cb) { term.write(String(chunk), cb) } })
stdout.columns = COLS
stdout.rows = ROWS
stdout.isTTY = true
const stderr = new Writable({ write(_c, _e, cb) { cb() } })
stderr.isTTY = true
const stdin = new PassThrough()
stdin.isTTY = true
stdin.setRawMode = () => stdin
stdin.setEncoding = () => stdin
stdin.ref = () => stdin
stdin.unref = () => stdin

const chat = React.createElement(Chat, {
  channel: makeChannel(),
  questionStore: { subscribe: () => () => {}, getSnapshot: () => null, answerCurrent() {}, arm() {}, disarm() {} },
  fullscreen: true,
  onExit() {},
})
const tree = React.createElement(ThemeProvider, {
  children: React.createElement(AlternateScreen, null, React.createElement(PageMargin, null, chat)),
})
await render(tree, { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false })
// 固定窗:探针 首帧带随机 tip，无稳定轮询锚点；只取一屏文本。
await sleep(900)

console.log(`--- ${COLS}x${ROWS} ---`)
Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(term.buffer.active.baseY + y))
  .forEach((line, i) => {
    const text = line?.translateToString(true) ?? ''
    // Cell backgrounds: shows whether a block paints a band (code fences etc.).
    let filled = 0
    for (let x = 0; x < COLS; x += 1) {
      const cell = line?.getCell(x)
      if (cell !== undefined && cell.getChars() !== '' && !cell.isBgDefault()) filled += 1
    }
    console.log(`${String(i).padStart(2, ' ')}|${text}${filled === 0 ? '' : `   [bg ${filled}]`}`)
  })
process.exit(0)

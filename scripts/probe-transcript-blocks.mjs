#!/usr/bin/env node
/**
 * VISUAL PROBE (not a regression): mount the real Chat tree over a fixture
 * transcript that mixes user prompt / assistant prose / tool cards / reasoning
 * rows, then dump the viewport as plain text.
 *
 * Purpose: judge block separation (turn start, prose vs machine activity,
 * vertical rhythm) without a human at a terminal.
 *
 * Run after build: `node scripts/probe-transcript-blocks.mjs [cols] [rows]`
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
delete process.env.TERM_PROGRAM
delete process.env.TMUX

// Dynamic imports on purpose: FORCE_COLOR must be set before chalk evaluates
// (ESM static imports are hoisted above the assignments above), or every cell
// in the dump reports the default colour and a band fill is invisible.
const [{ Writable, PassThrough }, React, xtermHeadless, { render, ThemeProvider, AlternateScreen }, { PageMargin }, { Chat }, { viewportLines, sleep }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../lib/types/ui.js'),
  import('../lib/types/components/PageMargin.js'),
  import('../lib/types/screens/Chat.js'),
  import('./lib/term-test.mjs'),
])
const { Terminal: XTerm } = xtermHeadless.default ?? xtermHeadless

const COLS = Number(process.argv[2] ?? 118)
const ROWS = Number(process.argv[3] ?? 46)

const HANDOFF = '/home/codeasier/Projects/agentmemory/.agent/handoff/agentmemory-memory-ops/HANDOFF.md'
const KB = '/home/codeasier/knowledge-base/10-projects/agentmemory-fork/sessions/2026-09-26-memory-retention-fix.md'

const rows = [
  { id: 0, kind: 'user', text: '清幽灵行', seq: 0 },
  {
    id: 1,
    kind: 'tool',
    text: '',
    seq: 1,
    tool: {
      callId: 'c1',
      name: 'Edit',
      argsText: `{"file_path":"${HANDOFF}"}`,
      status: 'ok',
      startedAt: Date.now() - 900,
      durationMs: 12,
      callView: { card: 'diff', title: HANDOFF, diffs: [] },
      resultView: { card: 'diff', title: HANDOFF, diffs: [] },
    },
  },
  { id: 2, kind: 'assistant', text: 'Remaining Work 可能重复了「上游跟进」。核对一下。', seq: 2 },
  {
    id: 3,
    kind: 'tool',
    text: '',
    seq: 3,
    tool: {
      callId: 'c2',
      name: 'Read',
      argsText: `{"file_path":"${HANDOFF}","offset":63,"limit":20}`,
      status: 'ok',
      startedAt: Date.now() - 800,
      durationMs: 8,
      callView: { card: 'generic', title: `${HANDOFF} (63 - 82)` },
      resultView: { card: 'read', title: `${HANDOFF} (63 - 82)`, path: HANDOFF, content: [{ type: 'text', text: 'body' }] },
    },
  },
  { id: 4, kind: 'assistant', text: '编号从 3 跳到 5。补上 4。', seq: 4 },
  {
    id: 5,
    kind: 'tool',
    text: '',
    seq: 5,
    tool: {
      callId: 'c3',
      name: 'Edit',
      argsText: `{"file_path":"${HANDOFF}"}`,
      status: 'ok',
      startedAt: Date.now() - 700,
      durationMs: 10,
      callView: { card: 'diff', title: HANDOFF, diffs: [] },
      resultView: { card: 'diff', title: HANDOFF, diffs: [] },
    },
  },
  {
    id: 6,
    kind: 'tool',
    text: '',
    seq: 6,
    tool: {
      callId: 'c4',
      name: 'Bash',
      argsText: '{"command":"python3 - <<\'PY\'\\nimport sqlite3\\nPY"}',
      status: 'ok',
      startedAt: Date.now() - 600,
      durationMs: 42,
      callView: { card: 'terminal', title: "python3 - <<'PY'\nimport sqlite3\nconn = sqlite3.connect('meta.db')\nPY" },
      resultView: { card: 'terminal', title: "python3 - <<'PY'\nimport sqlite3\nconn = sqlite3.connect('meta.db')\nPY", output: 'ok\n', exitCode: 0 },
    },
  },
  { id: 7, kind: 'assistant', text: '幽灵行已清。\n\n磁盘现在是 36650 unique / 全 f16 / 0 重复。meta v:4 count=36650。服务 active，orphanDeletes: 0。\n\n做法：load 时留下 f16 副本，把无 c 的重复记成孤儿，ready 之后 60s 再 state::delete（走现有 worker，没有第二套引擎）。', seq: 7 },
  { id: 8, kind: 'user', text: '记录下来', seq: 8 },
  { id: 9, kind: 'reasoning', text: '先看知识库笔记的既有结构，再决定补哪几段。', seq: 9, durationMs: 4200 },
  {
    id: 10,
    kind: 'tool',
    text: '',
    seq: 10,
    tool: {
      callId: 'c5',
      name: 'Read',
      argsText: `{"file_path":"${KB}","offset":1,"limit":80}`,
      status: 'ok',
      startedAt: Date.now() - 500,
      durationMs: 9,
      callView: { card: 'generic', title: `${KB} (1 - 80)` },
      resultView: { card: 'read', title: `${KB} (1 - 80)`, path: KB, content: [{ type: 'text', text: 'body' }] },
    },
  },
  {
    id: 11,
    kind: 'tool',
    text: '',
    seq: 11,
    tool: {
      callId: 'c6',
      name: 'Bash',
      argsText: `{"command":"tail -40 ${KB}"}`,
      status: 'ok',
      startedAt: Date.now() - 400,
      durationMs: 11,
      callView: { card: 'terminal', title: `tail -40 ${KB}` },
      resultView: { card: 'terminal', title: `tail -40 ${KB}`, output: 'body\n', exitCode: 0 },
    },
  },
  { id: 12, kind: 'reasoning', text: '笔记里已经有 09-29 那段，接着补 09-30 的量化结论。', seq: 12, durationMs: 6100 },
  {
    id: 13,
    kind: 'tool',
    text: '',
    seq: 13,
    tool: {
      callId: 'c7',
      name: 'Grep',
      argsText: `{"pattern":"2026-09-29|2026-09-30","path":"${KB}"}`,
      status: 'ok',
      startedAt: Date.now() - 300,
      durationMs: 7,
      callView: { card: 'search', shape: 'matches', title: 'Grep 2026-09-29|2026-09-30', files: [], truncated: false, total: 0 },
      resultView: { card: 'search', shape: 'matches', title: 'Grep 2026-09-29|2026-09-30', files: [], truncated: false, total: 0 },
    },
  },
  {
    id: 14,
    kind: 'tool',
    text: '',
    seq: 14,
    tool: {
      callId: 'c8',
      name: 'mcp__agentmemory__memory_lesson_save',
      argsText: '{"content":"agentmemory 本机 74 个向量桶 list 约 14s，CLI 默认 15s ready 看门狗会在 Viewer 起来前 process.exit(1)，systemd 跟着重启风暴。生产 drop-in 必须设 AGENTMEMORY_READY_TIMEOUT_MS=120000。","tags":"agentmemory,timeout"}',
      status: 'ok',
      startedAt: Date.now() - 200,
      durationMs: 15,
      callView: { card: 'generic', title: 'mcp__agentmemory__memory_lesson_save' },
      resultView: { card: 'generic', title: 'mcp__agentmemory__memory_lesson_save', content: [{ type: 'text', text: 'saved' }] },
    },
  },
  { id: 15, kind: 'assistant', text: '记忆已写入。接着补几条可复用教训，并更新知识库笔记。', seq: 15, streaming: true },
  { id: 18, kind: 'local', text: 'ls -la ~/.dsh/profiles/dsh-tui', seq: 18 },
  { id: 19, kind: 'local-output', text: 'total 12', seq: 19 },
  { id: 20, kind: 'local-output', text: 'drwxrwxr-x  node_modules', seq: 20 },
  {
    id: 16,
    kind: 'subagent',
    text: '子任务 sa-0：检索并归纳结论',
    seq: 16,
    subagent: {
      agentId: 'sa-0',
      runId: 'sa-0',
      description: '检索并归纳结论',
      provider: 'dsh',
      model: 'deepseek-v4-flash',
      effort: 'medium',
      status: 'completed',
      startedAt: Date.now() - 120_000,
      completedAt: Date.now() - 60_000,
      durationMs: 60_000,
      outputLines: [],
      toolCalls: [{ id: 'sa-0-c1', name: 'Grep', status: 'ok', startedAt: Date.now() - 100_000 }],
      tokens: { total: 2048 },
      stopReason: 'completed',
    },
  },
  {
    id: 17,
    kind: 'job',
    text: '后台任务',
    seq: 17,
    job: {
      id: 'job-1',
      kind: 'bash',
      label: 'long build',
      status: 'running',
      startedAt: Date.now() - 30_000,
      outputLines: [],
      progress: undefined,
    },
  },
]

function makeChannel() {
  const listeners = new Set()
  const channel = {
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: 'probe',
    agentId: 'probe',
    model: 'grok-4.7',
    provider: 'xai',
    tokens: { input: 0, output: 0 },
    cwd: '/home/codeasier/Projects/agentmemory',
    displayCwd: '~/Projects/agentmemory',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    pending: [],
    notifications: [],
    contextWindow: 500000,
    reasoningEffort: 'medium',
    activityEnabled: false,
    contextBarEnabled: true,
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
const tree = React.createElement(
  ThemeProvider,
  { children: React.createElement(AlternateScreen, null, React.createElement(PageMargin, null, chat)) },
)
await render(tree, { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false })
// 固定窗:探针 首帧带随机 tip，没有稳定轮询锚点；只为一屏文本取样。
await sleep(900)

console.log(`--- ${COLS}x${ROWS} ---`)
const buffer = term.buffer.active
viewportLines(term).forEach((line, i) => {
  // Cells whose background is not the terminal default — how a band fill is
  // visible at all in a plain-text dump (trailing blanks are stripped).
  const row = buffer.getLine(buffer.baseY + i)
  let filled = 0
  let lastFilled = -1
  for (let x = 0; x < COLS; x += 1) {
    const cell = row?.getCell(x)
    if (cell !== undefined && !cell.isBgDefault()) { filled += 1; lastFilled = x }
  }
  const band = filled === 0 ? '' : `   [bg ${filled} cells → col ${lastFilled}]`
  console.log(`${String(i).padStart(2, ' ')}|${line.replace(/\s+$/, '')}${band}`)
})
process.exit(0)

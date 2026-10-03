#!/usr/bin/env node
/**
 * Transcript block hierarchy regression (compiled lib).
 *
 * The transcript stacks four visual layers, and they must stay distinguishable
 * at a glance — the wall-of-grey failure mode is: prose, tool cards, thinking
 * and prompts all wearing the same leading dot at the same indentation, with a
 * blank line between everything (user report, 2026-09-30).
 *
 * Contract under test:
 *   1. USER TURN — a full-width band (`userPromptBackground`) whose left edge
 *      is `▌ ❯` at the page-margin column, the turn anchor for scrolling back.
 *   2. ASSISTANT PROSE — col 0 (page margin only), NO prefix marker.
 *   3. TOOLS — quiet, unrailed summaries; terminal/diff/error output keeps
 *      a full-width surface and continuous border. Thinking has no rail.
 *   4. Vertical rhythm — consecutive summaries stay tight; output cards have
 *      padding and a blank separator. Reasoning separates tool runs.
 *
 * Run after build: `node scripts/verify-transcript-blocks.mjs [--inline] [--narrow]`
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
delete process.env.TERM_PROGRAM
delete process.env.TMUX

// Dynamic imports on purpose: FORCE_COLOR must be set before chalk evaluates
// (static imports are hoisted above the assignments above), or every cell
// reports the default colour and the band check silently passes on nothing.
const [{ Writable, PassThrough }, React, xtermHeadless, { render, ThemeProvider, AlternateScreen }, { PageMargin }, { Chat }, { settled }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../lib/types/ui.js'),
  import('../lib/types/components/PageMargin.js'),
  import('../lib/types/screens/Chat.js'),
  import('./lib/term-test.mjs'),
])

const { Terminal: XTerm } = xtermHeadless.default ?? xtermHeadless

const fullscreen = !process.argv.includes('--inline')
const COLS = process.argv.includes('--narrow') ? 52 : 100
const ROWS = fullscreen ? 40 : 80
/** PageMargin's left inset — every transcript row starts here at the latest. */
const MARGIN = 3
const RAIL = '│ '

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || extra === '' ? '' : `  (${extra})`}`)
  if (!ok) failed += 1
}

const HANDOFF = '/tmp/handoff.md'
const row = (id, kind, extra) => ({ id, kind, text: '', seq: id, fresh: false, ...extra })
const toolRow = (id, name, title, status = 'ok') => row(id, 'tool', {
  tool: {
    callId: `call-${id}`,
    name,
    argsText: '{}',
    status,
    startedAt: Date.now() - 1_000,
    durationMs: 12,
    callView: { card: 'generic', title },
  },
})

const rows = [
  row(0, 'user', { text: '清幽灵行' }),
  toolRow(1, 'edit', `Edit ${HANDOFF}`),
  toolRow(2, 'read', `Read ${HANDOFF} (63 - 82)`),
  toolRow(8, 'read', 'Read /tmp/next.ts'),
  row(3, 'assistant', { text: '编号从 3 跳到 5。补上 4。' }),
  row(4, 'reasoning', { text: '先核对编号，再看 remaining work。', durationMs: 4_200 }),
  toolRow(5, 'bash', 'Bash(ls -la)'),
  row(6, 'user', { text: '记录下来' }),
  row(7, 'assistant', { text: '记忆已写入。', streaming: false }),
]

function makeChannel() {
  const listeners = new Set()
  const channel = {
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: 'blocks',
    agentId: 'blocks',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
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

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
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

const channel = makeChannel()
const chat = React.createElement(Chat, {
  channel,
  questionStore: { subscribe: () => () => {}, getSnapshot: () => null, answerCurrent() {}, arm() {}, disarm() {} },
  fullscreen,
  onExit() {},
})
const page = React.createElement(PageMargin, null, chat)
const tree = React.createElement(ThemeProvider, {
  children: fullscreen ? React.createElement(AlternateScreen, null, page) : page,
})
const instance = await render(tree, { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false })

/** Viewport text, trailing blanks stripped (trailing-only differences are chrome). */
const lines = () => Array.from(
  { length: ROWS },
  (_, y) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? '',
)
/** First viewport row whose text contains `needle`, or -1. */
const rowOf = needle => lines().findIndex(line => line.includes(needle))
/** Cells on `y` whose background is not the terminal default. */
function bandCells(y) {
  const line = term.buffer.active.getLine(term.buffer.active.baseY + y)
  let filled = 0
  for (let x = 0; x < COLS; x += 1) {
    const cell = line?.getCell(x)
    if (cell !== undefined && cell.getChars() !== '' && !cell.isBgDefault()) filled += 1
  }
  return filled
}

// ── 1. the user turn: band + `▌ ❯` at the page margin ─────────────────────
check('user turn paints', await settled(() => rowOf('清幽灵行') >= 0 && rowOf('记忆已写入。') >= 0))
const promptIdx = rowOf('清幽灵行')
const promptLine = lines()[promptIdx] ?? ''
check('user turn leads with the `▌ ❯` bar at the page margin',
  promptLine.startsWith(`${' '.repeat(MARGIN)}▌ ${'❯'} `), JSON.stringify(promptLine.slice(0, 12)))
check('user turn band fills the content width', bandCells(promptIdx) > COLS - MARGIN - 8,
  `cells=${bandCells(promptIdx)}`)

// ── 2. assistant prose: col 0, no marker ─────────────────────────────────
const proseIdx = rowOf('编号从 3 跳到 5。补上 4。')
check('prose renders', proseIdx >= 0)
const proseLine = lines()[proseIdx] ?? ''
check('prose is flush left with no prefix marker',
  proseLine.startsWith(`${' '.repeat(MARGIN)}编号从 3 跳到 5。补上 4。`),
  JSON.stringify(proseLine.slice(0, 16)))
check('prose carries no transcript band', bandCells(proseIdx) === 0, `cells=${bandCells(proseIdx)}`)

// ── 3. machine activity: the rail, indented two columns ──────────────────
const editIdx = rowOf('Edit /tmp/handoff.md')
const thinkIdx = rowOf('思考 · 4s')
const bashIdx = rowOf('Bash(ls -la)')
check('tool card renders', editIdx >= 0)
check('thinking row renders', thinkIdx >= 0)
check('output cards retain the rail but thinking is flush left',
  (lines()[editIdx] ?? '').startsWith(`${' '.repeat(MARGIN)}${RAIL}`)
  && (lines()[thinkIdx] ?? '').startsWith(`${' '.repeat(MARGIN)}+ 思考`),
  JSON.stringify((lines()[editIdx] ?? '').slice(0, 12)))
check('the railed content sits two columns right of prose',
  (lines()[editIdx] ?? '').indexOf('Edit') === MARGIN + RAIL.length + 2,
  `col=${(lines()[editIdx] ?? '').indexOf('Edit')}`)

// ── 4. vertical rhythm ───────────────────────────────────────────────────
const readIdx = rowOf('Read /tmp/handoff.md (63 - 82)')
check('card to summary keeps a blank separator without summary padding',
  readIdx === editIdx + 3, `edit=${editIdx} read=${readIdx}`)
check('the separator has no card background or rail',
  (lines()[editIdx + 2] ?? '').trim() === '' && bandCells(editIdx + 2) === 0)
check('card border spans top padding, title and bottom padding',
  [editIdx - 1, editIdx, editIdx + 1].every(y => (lines()[y] ?? '').startsWith(`${' '.repeat(MARGIN)}│`)))
check('tool card surface fills the content width', bandCells(editIdx) > COLS - MARGIN - 8,
  `cells=${bandCells(editIdx)}`)
check('reasoning is separated from the next tool card', thinkIdx === bashIdx - 3,
  `think=${thinkIdx} bash=${bashIdx}`)
check('a prose row keeps its blank line after a summary run', proseIdx === rowOf('Read /tmp/next.ts') + 2,
  `read=${readIdx} prose=${proseIdx}`)
check('a second user turn keeps its blank line after card padding',
  rowOf('记录下来') === bashIdx + 3, `bash=${bashIdx}`)

check('consecutive read summaries occupy adjacent rows', rowOf('Read /tmp/next.ts') === readIdx + 1)
check('read summary has an arrow and no surface',
  (lines()[readIdx] ?? '').startsWith(`${' '.repeat(MARGIN)}→ Read`) && bandCells(readIdx) === 0)
check('thinking has no surface or italic header', bandCells(thinkIdx) === 0 &&
  !term.buffer.active.getLine(thinkIdx)?.getCell(MARGIN + 2)?.isItalic())
// Status and presentation mutate in place: the gap cache must notice a
// formerly compact row turning into an error card, then returning to compact.
const nextTool = rows.find(row => row.id === 8).tool
nextTool.status = 'error'
nextTool.errorText = 'READ_FAILED'
channel.emit()
check('in-place error shows its output card', await settled(() => rowOf('READ_FAILED') >= 0))
check('error card gains a blank separator', rowOf('Read /tmp/next.ts') === rowOf('Read /tmp/handoff.md (63 - 82)') + 3)
nextTool.status = 'ok'
nextTool.errorText = undefined
channel.emit()
check('in-place recovery restores tight summaries', await settled(() =>
  rowOf('READ_FAILED') === -1 && rowOf('Read /tmp/next.ts') === rowOf('Read /tmp/handoff.md (63 - 82)') + 1))

stdin.write('\x0f')
check('Ctrl+O expands summaries into separated cards', await settled(() =>
  rowOf('Read /tmp/handoff.md (63 - 82)') >= 0 &&
  rowOf('Read /tmp/next.ts') === rowOf('Read /tmp/handoff.md (63 - 82)') + 4 &&
  bandCells(rowOf('Read /tmp/next.ts')) > COLS - MARGIN - 8))
stdin.write('\x0f')
check('Ctrl+O collapse restores tight unfilled summaries', await settled(() =>
  rowOf('Read /tmp/next.ts') === rowOf('Read /tmp/handoff.md (63 - 82)') + 1 &&
  bandCells(rowOf('Read /tmp/next.ts')) === 0))

await instance.unmount()
term.dispose()

console.log('')
if (failed > 0) {
  console.error(`verify-transcript-blocks: ${failed} FAILURE(S)`)
  process.exit(1)
}
console.log('verify-transcript-blocks: all checks passed')

/**
 * User prompt fidelity at the terminal/context width boundary (issue #3).
 * Run after pnpm build: node --import tsx/esm scripts/verify-user-prompt-wrap.mjs
 * The product imports compiled lib; the modern emoji-width helper imports src.
 * --repro limits the matrix to independent 80/78 component and real Chat cases.
 * Reads painted xterm cells and the production screen-selection extractor;
 * source/DOM text is used only to locate the block, never as the copy oracle.
 */
import './lib/fake-home.mjs'
import { PassThrough, Writable } from 'node:stream'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
delete process.env.TERM_PROGRAM
delete process.env.TMUX

const [React, xterm, { render, AlternateScreen, ThemeProvider, Box },
  { UserPromptMessage }, { PageMargin }, { applyPageMargin, resolvePageMargin },
  { TerminalSizeContext }, { Chat }, { QuestionStore }, { default: instances },
  { createSelectionState, getSelectedText }, { stringWidth }, { activateModernEmojiWidths }, { settled, writeParsed },
] = await Promise.all([
  import('react'),
  import('@xterm/headless'),
  import('../lib/types/ui.js'),
  import('../lib/types/components/messages/UserPromptMessage.js'),
  import('../lib/types/components/PageMargin.js'),
  import('../lib/types/tuiDisplayPrefs.js'),
  import('../lib/types/ink/components/TerminalSizeContext.js'),
  import('../lib/types/screens/Chat.js'),
  import('../lib/types/dsh-adapter/questions.js'),
  import('../lib/types/ink/instances.js'),
  import('../lib/types/ink/selection.js'),
  import('../lib/types/ink/stringWidth.js'),
  import('./lib/modern-widths.mjs'),
  import('./lib/term-test.mjs'),
])

const h = React.createElement
const { Terminal } = xterm.default ?? xterm
const ROWS = 40
const inputs = {
  english: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(8),
  cjk: '天地玄黄宇宙洪荒日月盈昃辰宿列张'.repeat(8),
  emoji: '😀😃😄😁😆😅😂🙂🙃😉😊😇'.repeat(10),
  mixed: ('A天地😀B玄黄😃C宇宙😄D洪荒😁').repeat(9),
  short: 'Short中😀',
}
let failed = 0
let cases = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed++
}

function channelFor(text, gutter, history) {
  const listeners = new Set()
  const rows = Array.from({ length: history ? 36 : 0 }, (_, id) => ({
    id, kind: id % 2 === 0 ? 'user' : 'assistant', text: `old ${id}`, seq: id, fresh: false,
  }))
  rows.push({ id: 36, kind: 'user', text, seq: 36, fresh: false })
  return {
    version: 0, rows, status: 'idle', sessionTitle: 'wrap regression', agentId: 'wrap-regression',
    model: 'deepseek-v4-flash', provider: 'deepseek', tokens: { input: 0, output: 0 },
    cwd: process.env.HOME, displayCwd: process.env.HOME, gitBranch: 'fixture',
    working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0,
    turnStart: 0, lastUserText: '', pending: [], notifications: [], contextWindow: 500000,
    reasoningEffort: 'medium', effortLevels: [], activityEnabled: false, contextBarEnabled: false,
    statusBar: {}, agentPreset: 'standard', goal: undefined, todos: [],
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0, cycleMode() {}, commandList: [], commandCompletions: () => [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    whaleIdle: false, whale: false, whaleGirl: false, scrollGutter: gutter,
    notify() {}, pushLocal() {}, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    submit() {}, steer() {}, removePending: () => true, cancel() {}, interruptAndDeliver: () => 0,
    clear() {}, loadOlder: () => 0, listModels: async () => [], listFiles: async () => [],
    listSessions: async () => [], setResumeTarget() {}, setActivityFrames: () => true,
    activityFrames: 'moon8', runExternalCommand: async () => '', mcpStatus: () => [],
    exportSession: () => null, initWorkspace: () => null, doctorInfo: () => [],
    listSubagents: async () => [], listPresets: async () => [], switchPreset: async () => false,
    switchModel: async () => false, rewindTo: async () => null,
    resumeTo: async () => ({ ok: false, reason: 'unavailable' }), newSession: async () => false, compact() {},
  }
}

function textOf(node) {
  return node.nodeName === '#text' ? node.nodeValue : node.childNodes.map(textOf).join('')
}
function findPrompt(node, text) {
  if (node.nodeName === 'ink-text' && textOf(node).startsWith(`❯ ${text.slice(0, 8)}`)) return node.parentNode
  for (const child of node.childNodes ?? []) {
    const found = findPrompt(child, text)
    if (found) return found
  }
}
function position(node) {
  let x = 0, y = 0
  for (let parent = node; parent; parent = parent.parentNode) {
    x += parent.yogaNode?.getComputedLeft() ?? 0
    y += parent.yogaNode?.getComputedTop() ?? 0
    if (parent !== node) y -= parent.scrollTop ?? 0
  }
  return { x: Math.round(x), y: Math.round(y) }
}

async function run({ mode, text, label, cols = 80, margin = 'none', gutter = 'timeline', history = true, resize = false, foldRoundTrip = false }) {
  const term = new Terminal({ cols, rows: ROWS, scrollback: 0, allowProposedApi: true })
  activateModernEmojiWidths(term)
  const stdout = new Writable({ write(chunk, _encoding, callback) { term.write(String(chunk), callback) } })
  Object.assign(stdout, { columns: cols, rows: ROWS, isTTY: true })
  const stdin = new PassThrough()
  Object.assign(stdin, { isTTY: true, setRawMode() { return this }, ref() { return this }, unref() { return this } })
  const stderr = new Writable({ write(chunk, _encoding, callback) { process.stderr.write(String(chunk)); callback() } })
  stderr.isTTY = true
  applyPageMargin(margin)
  const channel = mode === 'chat' ? channelFor(text, gutter, history) : undefined
  const content = channel
    ? h(PageMargin, null, h(Chat, { channel, questionStore: new QuestionStore(), fullscreen: true, onExit() {} }))
    : h(TerminalSizeContext.Provider, { value: { columns: cols, rows: ROWS } },
      h(Box, { width: cols - 2, flexDirection: 'column' }, h(UserPromptMessage, { text, marginTopOnTurn: false })))
  const instance = await render(h(ThemeProvider, null, h(AlternateScreen, null, content)), {
    stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false,
  })
  const ink = instances.get(stdout)

  function snapshot() {
    const band = findPrompt(ink.rootNode, text)
    if (!band) return null
    const { x, y } = position(band)
    const width = Math.round(band.yogaNode.getComputedWidth())
    const height = Math.round(band.yogaNode.getComputedHeight())
    const lines = band.childNodes.map((node, index) => {
      const { x: textX, y: row } = position(node)
      const textWidth = Math.round(node.yogaNode.getComputedWidth())
      const painted = (term.buffer.active.getLine(term.buffer.active.baseY + row)?.translateToString(true, textX, textX + textWidth) ?? '').trimEnd()
      const prefix = index === 0 ? '❯ ' : '  '
      const selection = createSelectionState()
      selection.anchor = { col: textX + prefix.length, row }
      selection.focus = { col: x + width - 3, row }
      return {
        painted, prefix, row, textX, textWidth, nodeName: node.nodeName,
        emittedPrefix: textOf(node).slice(0, prefix.length),
        payload: painted.slice(prefix.length), copied: getSelectedText(selection, ink.frontFrame.screen).trimEnd(),
      }
    })
    return { x, y, width, height, lines }
  }

  async function verify(stage) {
    cases++
    const name = `${mode}/${label}/${stdout.columns}/${margin}/${gutter}/${history ? 'history' : 'short-session'}${stage}`
    let previous = '', stable = 0
    check(`${name}: painted block settles`, await settled(() => {
      const snap = snapshot()
      const signature = JSON.stringify(snap)
      stable = snap?.lines.every(line => line.payload.length > 0) && signature === previous ? stable + 1 : 0
      previous = signature
      return stable >= 3
    }))
    await writeParsed(term, '')
    const snap = snapshot()
    if (!snap) return
    const shown = snap.lines.map(line => line.payload).join('')
    const copied = snap.lines.map(line => line.copied).join('')
    // Per-row payload-only selections intentionally exclude decorations and
    // join visual rows in the TEST. Production whole-block copy retains them.
    check(`${name}: every source character is painted in order`, shown === text,
      `${[...shown.replaceAll('…', '')].length}/${[...text].length} chars`)
    check(`${name}: screen selection retains every payload character`, copied === text)
    check(`${name}: every payload fits panel width minus six chrome cells`,
      snap.lines.every(line => stringWidth(line.payload) <= snap.width - 6))
    if (channel && label === 'english') {
      check(`${name}: uninterrupted Chat text uses the full panel-minus-six wrap budget`,
        snap.lines.slice(0, -1).every(line => stringWidth(line.payload) === snap.width - 6))
    }
    check(`${name}: first pointer and continuation indent both occupy two cells`,
      snap.lines.every(line => line.prefix.length === 2 && line.emittedPrefix === line.prefix))
    check(`${name}: wrapped Text nodes remain direct band children`,
      snap.lines.every(line => line.nodeName === 'ink-text'))
    check(`${name}: border and padding leave Text inset by two cells and two blank rows`,
      snap.height === snap.lines.length + 2 && snap.lines.every((line, index) =>
        line.textX === snap.x + 2 && line.textWidth === snap.width - 4 && line.row === snap.y + index + 1))
    const cell = (x, y) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.getCell(x)
    const visibleRows = Array.from({ length: snap.height }, (_, index) => snap.y + index).filter(y => y >= 0 && y < ROWS)
    check(`${name}: yellow border is continuous across padding and every visible wrapped row`,
      visibleRows.length > 0 && visibleRows.every(y =>
        cell(snap.x, y)?.getChars() === '┃' && cell(snap.x, y)?.getFgColor() === 0xffdf80))
    const badFill = visibleRows.flatMap(y => Array.from({ length: snap.width }, (_, index) => snap.x + index)
      .filter(x => cell(x, y)?.getBgColor() !== 0x303030)
      .map(x => ({ x, y, width: cell(x, y)?.getWidth(), chars: cell(x, y)?.getChars(), bg: cell(x, y)?.getBgColor() })))
    check(`${name}: left/right padding and the whole band use the prompt background`,
      badFill.length === 0 &&
      visibleRows.every(y => [snap.x + 1, snap.x + snap.width - 2, snap.x + snap.width - 1].every(x =>
        (cell(x, y)?.getChars() ?? '').trim() === '')), JSON.stringify(badFill.slice(0, 3)))
    check(`${name}: top and bottom padding contain only the border`,
      [snap.y, snap.y + snap.height - 1].filter(y => y >= 0 && y < ROWS).every(y =>
        term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true, snap.x + 1, snap.x + snap.width).trim() === ''))
    if (channel) {
      const inset = resolvePageMargin(margin).x
      // Chat reserves its transcript gutter even before the rail paints; the
      // prompt extends that context by the shared page-panel bleed on both sides.
      const gutterVisible = history && stdout.columns >= 60 && gutter !== 'hidden'
      const leftBleed = Math.max(0, inset - 1)
      const rightBleed = Math.max(0, inset - 2)
      const transcriptColumns = stdout.columns - 2 * inset - Math.max(0, (gutter === 'hidden' ? 0 : 2) - inset)
      const expectedX = inset - leftBleed
      const expectedWidth = transcriptColumns + leftBleed + rightBleed
      check(`${name}: real Chat content geometry`, snap.x === expectedX && snap.width === expectedWidth,
        `x=${snap.x} expectedX=${expectedX} width=${snap.width} expectedWidth=${expectedWidth}`)
      if (gutterVisible) {
        check(`${name}: two-column gutter is actually painted`, Array.from({ length: ROWS }, (_, row) =>
          term.buffer.active.getLine(term.buffer.active.baseY + row)?.translateToString(true, stdout.columns - 2, stdout.columns).trim() ?? '').some(Boolean))
      }
      check(`${name}: channel source remains unchanged`, channel.rows.at(-1).text === text)
    } else {
      check(`${name}: independent component has two fewer columns than its context`, snap.width === cols - 2)
    }
    if (mode === 'chat' && label === 'english' && stdout.columns === 80 && margin === 'none' && gutter === 'timeline' && history) {
      console.log(`RENDERED SCREEN (${name}):\n${snap.lines.map((_, index) => (term.buffer.active.getLine(term.buffer.active.baseY + snap.lines[index].row)?.translateToString(true) ?? '').trimEnd()).join('\n')}`)
    }
  }
  try {
    if (foldRoundTrip) {
      const verifyFolded = async () => {
        check('fold round trip: intentional preview keeps its complete 1000-character prefix', await settled(() => {
          const shown = snapshot()?.lines.map(line => line.payload).join('') ?? ''
          return shown.startsWith(text.slice(0, 1000)) && shown.includes('已折叠') && !shown.includes(text.slice(-20))
        }))
      }
      await verifyFolded()
      stdin.write('\x0f')
      await verify('/expanded')
      stdin.write('\x0f')
      await verifyFolded()
      stdin.write('\x0f')
      await verify('/reexpanded')
    } else {
      await verify('')
    }
    if (resize) {
      for (const width of [40, 100, 80]) {
        term.resize(width, ROWS)
        stdout.columns = width
        stdout.emit('resize')
        await verify('/resize')
      }
    }
  } finally {
    instance.unmount()
    term.dispose()
  }
}

await run({ mode: 'component', text: inputs.english, label: 'english' })
await run({ mode: 'chat', text: inputs.english, label: 'english' })
if (!process.argv.includes('--repro')) {
  for (const cols of [40, 80, 100]) {
    for (const [label, text] of Object.entries(inputs)) {
      for (const margin of ['none', 'slim', 'normal']) {
        for (const gutter of ['timeline', 'scrollbar', 'hidden']) {
          await run({ mode: 'chat', text, label, cols, margin, gutter })
        }
      }
      await run({ mode: 'component', text, label, cols })
    }
  }
  for (const gutter of ['timeline', 'scrollbar', 'hidden']) {
    for (const history of [true, false]) {
      await run({ mode: 'chat', text: inputs.english, label: 'gutter-control', gutter, history })
    }
  }
  await run({ mode: 'chat', text: inputs.mixed, label: 'resize', resize: true })
  await run({ mode: 'chat', text: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(40) + 'abcdefghijklmnopqrstuvwxyz', label: 'fold', foldRoundTrip: true })
}
console.log(`verify-user-prompt-wrap: ${cases} cases, ${failed} failures`)
process.exit(failed ? 1 : 0)

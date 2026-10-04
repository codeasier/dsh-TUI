#!/usr/bin/env node
/**
 * Upgrade seam: fork ICU word editing + official draft undo, selection and
 * declared cursor geometry on the grey/yellow composer surface. Exercises
 * inline/fullscreen at normal/narrow widths through real stdin and xterm.
 * Source imports; run: node --import tsx/esm scripts/verify-prompt-upgrade.mjs
 * Dependencies must be prepared first; no compiled lib is needed.
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { settle, settled, viewportLines } from './lib/term-test.mjs'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_THEME = 'dark'

const [
  { default: React },
  { Terminal: XTerm },
  { render, AlternateScreen },
  { PromptInput },
  { getWordSegmenter },
] = await Promise.all([
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/PromptInput.js'),
  import('../src/utils/intl.js'),
])
assert.equal(getWordSegmenter(), getWordSegmenter(), 'one shared memoized word segmenter')

for (const fullscreen of [false, true]) {
  for (const cols of [80, 24]) {
    const rows = 18
    const label = `${fullscreen ? 'fullscreen' : 'inline'} ${cols} cols`
    const term = new XTerm({ cols, rows, scrollback: 100, allowProposedApi: true })
    const stdout = new Writable({ write(chunk, _encoding, cb) { term.write(String(chunk), cb) } })
    Object.assign(stdout, { columns: cols, rows, isTTY: true })
    const stderr = new Writable({ write(_chunk, _encoding, cb) { cb() } })
    stderr.isTTY = true
    const stdin = new PassThrough()
    Object.assign(stdin, {
      isTTY: true,
      setRawMode: () => stdin,
      setEncoding: () => stdin,
      ref: () => stdin,
      unref: () => stdin,
    })
    const controller = { current: null }
    let clock = 0
    const channel = {
      agentId: 'prompt-upgrade',
      mode: { id: 'default', plan: false },
      commandList: [],
      commandCompletions: () => [],
      notifications: [],
      pending: [],
      working: false,
      notify() {},
      listFiles: async () => [],
    }
    const node = React.createElement(PromptInput, {
      channel,
      helpOpen: false,
      onToggleHelp() {},
      onRunCommand: () => false,
      selectionActive: false,
      controllerRef: controller,
      onOpenSessions() {},
      now: () => clock,
    })
    const app = await render(fullscreen ? React.createElement(AlternateScreen, null, node) : node,
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false })
    const text = () => controller.current?.text()
    const cell = (col, row) => term.buffer.active.getLine(term.buffer.active.baseY + row)?.getCell(col)
    const findCell = predicate => {
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          if (predicate(cell(col, row))) return { col, row }
        }
      }
      return undefined
    }
    const alignedCaret = () => {
      const caret = findCell(c => c?.isInverse())
      return caret !== undefined && caret.col === term.buffer.active.cursorX
        && caret.row === term.buffer.active.cursorY
    }
    const feedTo = async (sequence, expected) => {
      clock += 10
      stdin.write(sequence)
      assert(await settled(() => text() === expected), `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(text())}`)
    }
    const reset = async () => {
      controller.current.clear()
      await settle(() => text() === '')
    }
    try {
      await settle(() => controller.current !== null && alignedCaret())
      assert(await settled(alignedCaret), `${label}: empty hardware cursor matches inverse caret`)
      const rail = findCell(c => c?.getChars() === '┃')
      assert(rail, `${label}: heavy rail remains visible`)
      assert.equal(cell(rail.col, rail.row).getFgColor(), 0xffdf80, `${label}: yellow rail`)
      assert.equal(cell(rail.col + 1, rail.row).getBgColor(), 0x303030, `${label}: grey surface`)

      // Unicode deletion is one reversible mutation, including caret restore.
      await feedTo('你好世界\x17', '你好')
      await feedTo('\x1a', '你好世界')
      await feedTo('!', '你好世界!')
      assert(await settled(alignedCaret), `${label}: CJK caret still matches physical cursor`)
      await reset()
      await feedTo('hello 👩‍💻\x17', 'hello ')
      await feedTo('\x1a', 'hello 👩‍💻')
      await feedTo('!', 'hello 👩‍💻!')

      // Word movement does not create undo steps; marker undo restores its caret.
      await reset()
      await feedTo('hello world\x1b[1;3DX', 'hello Xworld')
      await feedTo('\x1a', 'hello world')
      await feedTo('Y', 'hello Yworld')
      assert(await settled(alignedCaret), `${label}: middle-of-word caret matches physical cursor`)

      // Mouse dispatch requires a fixed alternate viewport. SGR selection +
      // Ctrl+W is sealed against a following Backspace run there.
      if (fullscreen) {
        await reset()
        await feedTo('hello world', 'hello world')
        assert(await settled(() => viewportLines(term).some(line => line.includes('hello world'))))
        const start = findCell(c => c?.getChars() === 'h')
        assert(start, `${label}: selection text on screen`)
        const { col, row } = start
        stdin.write(`\x1b[<0;${col + 2};${row + 1}M\x1b[<32;${col + 5};${row + 1}M\x1b[<0;${col + 5};${row + 1}m`)
        assert(await settled(() => cell(col + 1, row)?.isInverse() && cell(col + 3, row)?.isInverse()))
        await feedTo('\x17', 'ho world')
        await feedTo('\x7f', 'o world')
        await feedTo('\x1a', 'ho world')
        await feedTo('\x1a', 'hello world')
        await feedTo('X', 'hellXo world')
        assert(await settled(alignedCaret), `${label}: selection undo restores correct caret`)
      }

      // A carried word at narrow widths must share wrap geometry with IME.
      await reset()
      await feedTo('alpha beta gamma delta epsilon\x1b[1;3D!', 'alpha beta gamma delta !epsilon')
      assert(await settled(alignedCaret), `${label}: wrapped word cursor matches inverse caret`)
      console.log(`PASS: ${label} word editing + undo${fullscreen ? ' + selection' : ''} + surface/cursor`)
    } finally {
      app.unmount()
      term.dispose()
    }
  }
}
console.log('verify-prompt-upgrade OK')

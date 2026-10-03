/**
 * Screenshot regression: history/composer/card edges and neutral surfaces in full Chat.
 * Run: node --import tsx/esm scripts/verify-session-surfaces.tsx
 * Covers dark/light, inline/fullscreen, 40/100 columns, margin and gutter modes,
 * plus CJK draft wrapping. No API credentials or real sessions are used.
 */
await import('./lib/fake-home.mjs')
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'
delete process.env.TERM_PROGRAM
delete process.env.TMUX

const [{ Writable, PassThrough }, React, { Terminal }, { render, AlternateScreen, ThemeProvider },
  { PageMargin }, { Chat }, { QuestionStore }, { applyPageMargin }, { settled, viewportLines }] = await Promise.all([
  import('node:stream'), import('react'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/components/PageMargin.js'), import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'), import('../src/tuiDisplayPrefs.js'), import('./lib/term-test.mjs'),
])

type Channel = import('../src/adapter/channel/ui-policy.js').ChannelUi
const configurations = [
  ['normal', 'timeline'], ['none', 'timeline'], ['slim', 'scrollbar'],
  ['roomy', 'timeline'], ['5x1', 'hidden'],
] as const
let failures = 0
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) failures++
}

for (const theme of ['dark', 'light'] as const) {
  for (const cols of [40, 100]) {
    for (const fullscreen of [true, false]) {
      for (const [margin, scrollGutter] of configurations) {
        applyPageMargin(margin)
        const term = new Terminal({ cols, rows: 48, scrollback: 200, allowProposedApi: true })
        const stdout = Object.assign(new Writable({ write(chunk, _enc, cb) { term.write(String(chunk), cb) } }),
          { columns: cols, rows: 48, isTTY: true })
        const stderr = Object.assign(new Writable({ write(_chunk, _enc, cb) { cb() } }), { isTTY: true })
        const stdin = Object.assign(new PassThrough(), {
          isTTY: true, setRawMode() { return this }, ref() { return this }, unref() { return this },
        })
        const channel = {
          version: 0, agentId: 'surface-probe', sessionTitle: 'surface-probe', status: 'idle',
          rows: [
            { id: 1, kind: 'user', text: `历史问题${'中英文Mixed'.repeat(8)}\nPROMPT_END` },
            { id: 2, kind: 'assistant', text: '正文标记' },
            { id: 3, kind: 'tool', text: '', tool: {
              callId: 'probe', name: 'bash', argsText: '{}', status: 'ok', startedAt: 0, durationMs: 12,
              callView: { card: 'terminal', title: 'echo TOOL_MARK' }, resultText: 'OUTPUT_END',
            } },
          ],
          model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'medium', effortLevels: [],
          tokens: { input: 0, output: 0 }, cwd: '/tmp', displayCwd: '/tmp',
          working: false, responseChars: 0, activeToolCount: 0, turnStart: 0, lastUserText: '',
          pending: [], notifications: [], subagents: [], commandList: [],
          mode: { plan: false }, scrollGutter, whale: false, whaleIdle: false, whaleGirl: false,
          smoothStreaming: false, statusBar: {}, activityFrames: 'moon8',
          subscribe: () => () => {}, commandCompletions: () => [], mcpStatus: () => [],
          submit() {}, cancel() {}, clear() {}, notify() {}, pushLocal() {}, loadOlder() {},
          listModels: async () => [], listSessions: async () => [], listFiles: async () => [],
        } as unknown as Channel
        const chat = <PageMargin><Chat channel={channel} questionStore={new QuestionStore()} fullscreen={fullscreen} /></PageMargin>
        const instance = await render(
          <ThemeProvider theme={theme}>{fullscreen ? <AlternateScreen>{chat}</AlternateScreen> : chat}</ThemeProvider>,
          { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream,
            stdin: stdin as unknown as NodeJS.ReadStream, exitOnCtrlC: false, patchConsole: false },
        )
        const lines = () => viewportLines(term)
        const rowOf = (text: string) => lines().findIndex(line => line.includes(text))
        const edges = (y: number, bg: number) => {
          const line = term.buffer.active.getLine(term.buffer.active.baseY + y)
          const xs = Array.from({ length: cols }, (_, x) => x).filter(x => {
            const cell = line?.getCell(x)
            return cell?.isBgRGB() === true && cell.getBgColor() === bg
          })
          return xs.length ? `${xs[0]}:${xs.at(-1)}` : ''
        }
        const toolBg = theme === 'dark' ? 0x2a2a2a : 0xffffff
        const inputBg = theme === 'dark' ? 0x303030 : 0xffffff
        const label = `${theme} ${cols} ${fullscreen ? 'fullscreen' : 'inline'} ${margin}/${scrollGutter}`
        check(`${label}: card/composer paint aligned neutral surfaces`, await settled(() => {
          const card = rowOf('TOOL_MARK'), input = rowOf('⌸')
          return card >= 0 && input >= 0 && edges(card, toolBg) !== '' && edges(card, toolBg) === edges(input - 1, inputBg)
        }))
        check(`${label}: history prompt matches composer fill, padding and continuous yellow rail`, await settled(() => {
          const prompt = rowOf('历史问题'), tail = rowOf('PROMPT_END'), input = rowOf('⌸')
          if (prompt < 0 || tail < prompt || input < 0) return false
          const bounds = edges(input - 1, inputBg)
          if (bounds === '') return false
          const left = Number(bounds.split(':')[0])
          const yellow = theme === 'dark' ? 0xffdf80 : 0xa67600
          return Array.from({ length: tail - prompt + 3 }, (_, i) => prompt - 1 + i).every(y => {
            const rail = term.buffer.active.getLine(term.buffer.active.baseY + y)?.getCell(left)
            return edges(y, inputBg) === bounds && rail?.getChars() === '┃' && rail.getFgColor() === yellow
          }) && lines()[prompt - 1]?.trim() === '┃' && lines()[tail + 1]?.trim() === '┃' &&
            lines()[prompt]?.indexOf('❯') === left + 2 && lines()[tail]?.indexOf('PROMPT_END') === left + 4
        }))
        check(`${label}: heavy yellow composer rail differs from the thin tool border`, await settled(() => {
          const card = rowOf('TOOL_MARK'), input = rowOf('⌸'), bounds = edges(card, toolBg)
          if (card < 0 || input < 0 || bounds === '') return false
          const left = Number(bounds.split(':')[0])
          const cellAt = (y: number) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.getCell(left)
          const yellow = theme === 'dark' ? 0xffdf80 : 0xa67600
          return cellAt(card)?.getChars() === '│' && [input - 1, input, input + 1].every(y =>
            cellAt(y)?.getChars() === '┃' && cellAt(y)?.getFgColor() === yellow)
        }))
        const draft = '中文草稿'.repeat(12) + 'DRAFT_END'
        stdin.write(`\x1b[200~${draft}\x1b[201~`)
        check(`${label}: wrapped CJK draft tail and aligned edges remain visible`, await settled(() => {
          const input = rowOf('⌸'), card = rowOf('TOOL_MARK')
          return rowOf('DRAFT_END') >= 0 && input >= 0 && card >= 0 &&
            edges(input - 1, inputBg) === edges(card, toolBg)
        }))
        await instance.unmount()
        term.dispose()
      }
    }
  }
}
applyPageMargin('normal')
if (failures) throw new Error(`session surface regression: ${failures} failures`)
console.log('Session surfaces: all 40 layout cases passed')

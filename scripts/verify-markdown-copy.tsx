/** Focused Markdown block-copy regression: real SGR clicks and drags through
 * Ink, with OSC 52 payloads decoded from a headless terminal's output.
 * Covers source whitespace, table syntax and narrow fallback, streaming,
 * provider wiring, modifiers, bubbling, retained local selection and resize.
 * No backend, clipboard helper or real terminal is used. Run with:
 * node --import tsx/esm scripts/verify-markdown-copy.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_THEME = 'dark'
process.env.TERM_PROGRAM = 'xterm'
process.env.SSH_CONNECTION = 'headless-test'
delete process.env.TMUX
delete process.env.STY
delete process.env.DSH_TUI_DISABLE_MOUSE

await import('./lib/fake-home.mjs')
const [
  { default: assert }, React, { PassThrough, Writable }, { Terminal }, { marked },
  { render, Box, Text, ThemeProvider, AlternateScreen, useInput, useCopyOnSelect },
  { Markdown }, { StreamingMarkdown }, { MarkdownCopyContext, MarkdownCopyButton },
  { MessageList }, { default: instances }, { TerminalWriteContext },
  { renderToScreen }, { TerminalSizeContext }, { configureMarked, stripPromptXMLTags },
  { findText, viewportLines, settle, settled, sleep },
] = await Promise.all([
  import('node:assert/strict'), import('react'), import('node:stream'), import('@xterm/headless'), import('marked'),
  import('../src/ui.js'), import('../src/components/Markdown.js'), import('../src/components/StreamingMarkdown.js'),
  import('../src/components/MarkdownCopyButton.js'), import('../src/components/MessageList.js'),
  import('../src/ink/instances.js'), import('../src/ink/useTerminalNotification.js'),
  import('../src/ink/render-to-screen.js'), import('../src/ink/components/TerminalSizeContext.js'),
  import('../src/terminal-utils/markdown.js'), import('./lib/term-test.mjs'),
])
import type { ReactNode } from 'react'
import type { Tokens } from 'marked'
import type { ChatRow } from '../src/dsh-adapter/channel.js'

configureMarked()
const { setLang } = await import('../src/i18n.js')
let checks = 0
function check(name: string, ok: boolean, detail = ''): void {
  assert.ok(ok, detail === '' ? name : `${name}: ${detail}`)
  checks++
  console.log(`PASS ${name}`)
}

type Point = { col: number; row: number }
const labels = ['[Copy code]', '[Copy table]', '[Copied]', '[Copy failed]']

async function mount(content: ReactNode, columns = 80, fullscreen = true) {
  const term = new Terminal({ cols: columns, rows: 32, scrollback: 100, allowProposedApi: true })
  const writes: string[] = []
  class Output extends Writable {
    columns = columns
    rows = 32
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      writes.push(String(chunk))
      term.write(String(chunk), callback)
    }
  }
  class Input extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdout = new Output()
  const stdin = new Input()
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  const previous = instances.get(process.stdout)
  function InputOwner() {
    useInput(() => {})
    useCopyOnSelect()
    return null
  }
  const tree = (children: ReactNode) => {
    const body = <ThemeProvider><InputOwner />{children}</ThemeProvider>
    return fullscreen ? <AlternateScreen>{body}</AlternateScreen> : body
  }
  const app = await render(tree(content), {
    stdout: stdout as never, stdin: stdin as never, stderr: stderr as never,
    exitOnCtrlC: false, patchConsole: false, terminalImages: false,
  })
  const ink = instances.get(stdout)!
  instances.set(process.stdout, ink)
  app.rerender(tree(content))
  if (fullscreen) ink.setAltScreenActive(true, true)
  const flush = async () => {
    await new Promise<void>(resolve => stdout.write('', () => resolve()))
  }
  const send = async (bytes: string) => {
    stdin.write(bytes)
    await new Promise<void>(resolve => setImmediate(resolve))
    ink.renderNow()
    await flush()
  }
  const click = async ({ col, row }: Point, modifier = 0) => {
    await send(`\x1b[<${modifier};${col + 1};${row + 1}M\x1b[<${modifier};${col + 1};${row + 1}m`)
  }
  const payloads = () => [...writes.join('').matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)[\x07\x1b]/g)]
    .map(match => Buffer.from(match[1]!, 'base64').toString('utf8'))
  const locate = (needle: string): Point => {
    const point = findText(term, needle)
    assert.ok(point, `visible marker ${JSON.stringify(needle)}: ${viewportLines(term).join('\n')}`)
    return point
  }
  const button = (): Point => {
    const point = labels.map(label => findText(term, label)).find(Boolean)
    assert.ok(point, `visible copy button: ${viewportLines(term).join('\n')}`)
    return point
  }
  return {
    app, ink, term, writes, send, click, payloads, locate, button, flush,
    lines: () => viewportLines(term),
    rerender(children: ReactNode) { app.rerender(tree(children)) },
    async resize(width: number) {
      stdout.columns = width
      term.resize(width, stdout.rows)
      stdout.emit('resize')
      await new Promise<void>(resolve => setImmediate(resolve))
      ink.renderNow()
      await flush()
    },
    async close() {
      // A synthetic stream has no fd: do not let Ink's synchronous TTY-exit
      // fallback write cleanup bytes to the regression runner's real fd 1.
      stdout.isTTY = false
      app.unmount()
      await flush()
      term.dispose()
      if (previous) instances.set(process.stdout, previous)
      else instances.delete(process.stdout)
    },
  }
}

function markdown(source: string, onClick?: () => void, streaming = false) {
  return <MarkdownCopyContext.Provider value={true}>
    <Box flexDirection="column" onClick={onClick}>
      {streaming ? <StreamingMarkdown>{source}</StreamingMarkdown> : <Markdown>{source}</Markdown>}
      <Text>AFTER_BLOCK</Text>
    </Box>
  </MarkdownCopyContext.Provider>
}
function codeToken(source: string): Tokens.Code {
  const token = marked.lexer(source).find(token => token.type === 'code')
  assert.ok(token?.type === 'code')
  return token
}
function tableToken(source: string): Tokens.Table {
  const token = marked.lexer(source).find(token => token.type === 'table')
  assert.ok(token?.type === 'table')
  return token
}

const codeSource = '~~~ts title=sample.ts\nCOPY_BODY alpha  \n\treturn "中文👩‍💻"  \n\n' + 'long_'.repeat(35) + 'TAIL\n~~~'
const expectedCode = codeToken(codeSource).text
check('code fixture retains tabs, trailing blanks, empty rows and CJK',
  expectedCode.includes('\treturn "中文👩‍💻"  \n\n') && expectedCode.includes('alpha  \n'))
{
  let bubbled = 0
  const f = await mount(markdown(codeSource, () => { bubbled++ }))
  try {
    check('code action paints above the intact body', await settled(() =>
      findText(f.term, '[Copy code]') !== null && findText(f.term, 'COPY_BODY alpha') !== null))
    const footer = f.locate('AFTER_BLOCK').row
    const body = f.locate('COPY_BODY alpha')
    await f.click(body)
    await sleep(80) // 固定窗:探针 正文单击不得产生异步整块复制
    check('plain body click does not copy', f.payloads().length === 0)
    const beforeChip = bubbled
    await f.click(f.button())
    check('code click copies token.text without formatting loss', await settled(() =>
      f.payloads().length === 1 && f.payloads()[0] === expectedCode))
    check('copy chip stops ancestor click handlers', bubbled === beforeChip)
    check('copy feedback does not move the body or following block', await settled(() =>
      findText(f.term, '[Copied]') !== null && f.locate('AFTER_BLOCK').row === footer &&
      f.locate('COPY_BODY alpha').row === body.row))

    // A real local drag remains a local copy, not a whole-block action.
    const start = f.locate('COPY_BODY alpha')
    await f.send(`\x1b[<0;${start.col + 1};${start.row + 1}M`)
    await settle(() => f.ink.selection.isDragging)
    await f.send(`\x1b[<32;${start.col + 9};${start.row + 1}M`)
    await settle(() => f.ink.selection.focus?.col === start.col + 8)
    await f.send(`\x1b[<0;${start.col + 9};${start.row + 1}m`)
    check('body drag copies only the selected substring', await settled(() =>
      f.payloads().length === 2 && f.payloads()[1] === 'COPY_BODY'))
    check('local copy keeps the selection highlight', f.ink.hasTextSelection())
    await f.send(`\x1b[<0;${start.col + 9};${start.row + 1}m`)
    await sleep(80) // 固定窗:探针 已提交的局部选区重复 release 不得再次复制
    check('duplicate selection release does not copy again', f.payloads().length === 2)
    f.ink.clearTextSelection()

    for (const modifier of [4, 8, 16]) {
      await f.click(f.button(), modifier)
    }
    await sleep(80) // 固定窗:探针 Shift/Alt/Ctrl 点击不得产生异步整块复制
    check('modified copy-chip clicks preserve the clipboard', f.payloads().length === 2)

    await f.resize(10)
    check('narrow ANSI fallback hides the action', await settled(() =>
      labels.every(label => findText(f.term, label) === null)))
    await f.resize(80)
    check('resize restores a clickable action at its new location', await settled(() =>
      labels.some(label => findText(f.term, label) !== null)))
    await f.click(f.button())
    check('resized action still copies the entire source', await settled(() =>
      f.payloads().length === 3 && f.payloads()[2] === expectedCode))
  } finally { await f.close() }
}

// Raw table syntax must survive both the framed and vertical/key-value path.
const tableSource = '| Key | Value |\n| :--- | ---: |\n| **strong** | a\\|b `inline` |\n| empty | |\n'
for (const width of [80, 20]) {
  const source = width === 20
    ? '| Key | Value |\n| --- | --- |\n| path | ' + 'segment_'.repeat(18) + 'END_VALUE |\n'
    : tableSource
  const f = await mount(markdown(source), width)
  try {
    check(`table ${width}: action and content render`, await settled(() =>
      findText(f.term, '[Copy table]') !== null && findText(f.term, 'AFTER_BLOCK') !== null))
    const copyRow = f.button().row
    const bodyRow = width === 20 ? f.locate('Key:').row : f.locate('┌').row
    check(`table ${width}: its action row never covers table content`, bodyRow > copyRow)
    if (width === 20) {
      const restored = f.lines().slice(bodyRow, f.locate('AFTER_BLOCK').row)
        .map(line => line.trim()).join('')
      check('vertical table keeps its complete long value visible', restored.includes('END_VALUE'))
    }
    const footer = f.locate('AFTER_BLOCK').row
    await f.click(f.button())
    // Markdown's existing XML-strip ingress trims its outer source before
    // lexing. The button must preserve that actual token.raw, not restore
    // whitespace the parser never received.
    const expected = tableToken(stripPromptXMLTags(source)).raw
    check(`table ${width}: click copies raw Markdown byte-for-byte`, await settled(() =>
      f.payloads().length === 1 && f.payloads()[0] === expected),
    JSON.stringify({ copied: f.payloads(), expected }))
    check(`table ${width}: feedback keeps the action row height fixed`, await settled(() =>
      findText(f.term, '[Copied]') !== null && f.locate('AFTER_BLOCK').row === footer))
  } finally { await f.close() }
}

// The component's contract is exact token data, including a table's final
// newline and a code body's final blank line when supplied by its caller.
for (const token of [tableToken(tableSource), { ...codeToken('```txt\nDIRECT_CODE\n```'), text: '\tDIRECT_CODE  \n\n' }]) {
  const f = await mount(<MarkdownCopyContext.Provider value={true}>
    <Box flexDirection="column" height={2}><MarkdownCopyButton token={token} /></Box>
  </MarkdownCopyContext.Provider>)
  try {
    await settle(() => labels.some(label => findText(f.term, label) !== null))
    await f.click(f.button())
    check(`direct ${token.type} token keeps final whitespace`, await settled(() =>
      f.payloads().length === 1 && f.payloads()[0] === (token.type === 'code' ? token.text : token.raw)))
  } finally { await f.close() }
}

{
  let source = '```txt\nSTREAM_FIRST'
  const f = await mount(markdown(source, undefined, true))
  try {
    await settle(() => findText(f.term, '[Copy code]') !== null)
    await f.click(f.button())
    check('unclosed streaming code copies its current body', await settled(() =>
      f.payloads().length === 1 && f.payloads()[0] === codeToken(source).text))
    source += '\n\tSTREAM_SECOND  \n```'
    f.rerender(markdown(source, undefined, true))
    check('stream update keeps the action and latest code visible', await settled(() =>
      findText(f.term, '[Copy code]') !== null && findText(f.term, 'STREAM_SECOND') !== null))
    // A modified click breaks the native multi-click chain without copying.
    await f.click(f.button(), 4)
    await f.click(f.button())
    check('settled streaming action copies the updated token, not a stale closure', await settled(() =>
      f.payloads().length === 2 && f.payloads()[1] === codeToken(source).text))
  } finally { await f.close() }
}

function list(source: string, fullscreen: boolean) {
  const rows: ChatRow[] = [{ id: 1, kind: 'assistant', text: source }]
  return <MessageList rows={rows} expanded={false} expandedRows={new Set<number>()}
    selectedId={null} onToggleRow={() => {}} model="fixture" showAll={true}
    onToggleAll={() => {}} historyPaintEnabled={false} fullscreen={fullscreen} />
}
const providerFooterRows: number[] = []
for (const fullscreen of [true, false]) {
  // No explicit copy provider: this exercises MessageList's actual wiring.
  const source = '```txt\nPROVIDER_BODY\n```\n\n' + tableSource + '\nAFTER_PROVIDER'
  const f = await mount(list(source, fullscreen), 80, fullscreen)
  try {
    check(`${fullscreen ? 'fullscreen' : 'inline'} MessageList paints its assistant row`, await settled(() =>
      findText(f.term, 'PROVIDER_BODY') !== null && findText(f.term, 'AFTER_PROVIDER') !== null))
    providerFooterRows.push(f.locate('AFTER_PROVIDER').row)
    if (fullscreen) {
      check('fullscreen MessageList enables block-copy actions', await settled(() =>
        findText(f.term, '[Copy code]') !== null))
      await f.click(f.button())
      check('MessageList-provided action routes to the terminal writer', await settled(() =>
        f.payloads().length === 1 && f.payloads()[0] === 'PROVIDER_BODY'))
    } else {
      check('inline MessageList has no inert block-copy action', labels.every(label => findText(f.term, label) === null))
      check('inline MessageList never enables mouse tracking', !f.writes.join('').includes('\x1b[?1006h'))
    }
  } finally { await f.close() }
}

check('fullscreen table action adds exactly one MessageList layout row',
  providerFooterRows[0] === providerFooterRows[1]! + 1)

{
  setLang('zh')
  const f = await mount(markdown('```txt\nCHINESE_BODY\n```'))
  try {
    check('language switch shows the Chinese copy label', await settled(() =>
      findText(f.term, '[复制代码]') !== null && findText(f.term, 'AFTER_BLOCK') !== null))
    const footer = f.locate('AFTER_BLOCK').row
    await f.click(f.locate('[复制代码]'))
    check('Chinese copy feedback keeps its fixed-width layout and source payload', await settled(() =>
      findText(f.term, '[已复制]') !== null && f.locate('AFTER_BLOCK').row === footer &&
      f.payloads().length === 1 && f.payloads()[0] === 'CHINESE_BODY'))
  } finally {
    await f.close()
    setLang('en')
  }
}

{
  const text = 'DOUBLE_CLICK_BODY'
  const f = await mount(markdown('```txt\n' + text + '\n```'))
  try {
    await settle(() => findText(f.term, '[Copy code]') !== null)
    const point = f.button()
    point.col += 2 // Inside the word, not the '[' punctuation cell.
    await f.click(point)
    await settle(() => f.payloads().length === 1 && findText(f.term, '[Copied]') !== null)
    await f.click(point)
    check('a real double-click never replaces source with the button label', await settled(() =>
      f.payloads().length === 2 && f.payloads().every(payload => payload === text)),
    JSON.stringify(f.payloads()))
  } finally { await f.close() }
}

for (const [name, source, enabled, disabled] of [
  ['default provider', '```txt\nDEFAULT_PROVIDER\n```', false, false],
  ['disabled mouse', '```txt\nDISABLED_MOUSE\n```', true, true],
  ['empty code', '```txt\n```', true, false],
  ['long code caption', '```' + 'language'.repeat(15) + '\nLONG_CAPTION\n```', true, false],
] as const) {
  if (disabled) process.env.DSH_TUI_DISABLE_MOUSE = '1'
  const content = <Markdown>{source}</Markdown>
  const f = await mount(<Box flexDirection="column">
    {enabled ? <MarkdownCopyContext.Provider value={true}>{content}</MarkdownCopyContext.Provider> : content}
    <Text>HIDDEN_GUARD_READY</Text>
  </Box>)
  try {
    check(`${name} keeps the copy action hidden`, await settled(() =>
      findText(f.term, 'HIDDEN_GUARD_READY') !== null && labels.every(label => findText(f.term, label) === null)))
  } finally {
    await f.close()
    delete process.env.DSH_TUI_DISABLE_MOUSE
  }
}

// A host without a terminal writer must not expose an inert action, even
// when it opted into the transcript copy context.
{
  const token = codeToken('```txt\nNO_WRITER\n```')
  const screen = renderToScreen(
    <TerminalSizeContext.Provider value={{ columns: 80, rows: 32 }}>
      <TerminalWriteContext.Provider value={null}>
        <MarkdownCopyContext.Provider value={true}><MarkdownCopyButton token={token} /></MarkdownCopyContext.Provider>
      </TerminalWriteContext.Provider>
    </TerminalSizeContext.Provider>, 80,
  )
  check('a missing terminal writer keeps block-copy actions hidden', screen.height === 0)
}

console.log(`PASS ${checks} Markdown copy checks`)

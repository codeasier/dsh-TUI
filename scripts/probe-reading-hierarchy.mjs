#!/usr/bin/env node
/**
 * Bounded visual probe, not a regression. Uses compiled lib; run after build:
 * node scripts/probe-reading-hierarchy.mjs [columns] [output.svg]
 * The optional SVG/PNG pair is a cell-buffer illustration, not a PTY screenshot.
 */
await import('./lib/fake-home.mjs')
process.env.FORCE_COLOR = '3'
process.env.FORCE_HYPERLINK = '1'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'en'

const [React, { Box, ThemeProvider, render, AlternateScreen }, { PageMargin }, { TerminalSizeContext }, { Markdown }, { AssistantToolUseMessage }, { AssistantThinkingMessage }, xterm, { Writable, PassThrough }, { writeFileSync }, { settled }] = await Promise.all([
  import('react'), import('../lib/types/ui.js'), import('../lib/types/components/PageMargin.js'),
  import('../lib/types/ink/components/TerminalSizeContext.js'), import('../lib/types/components/Markdown.js'),
  import('../lib/types/components/messages/AssistantToolUseMessage.js'),
  import('../lib/types/components/messages/AssistantThinkingMessage.js'),
  import('@xterm/headless'), import('node:stream'), import('node:fs'), import('./lib/term-test.mjs'),
])
const columns = Number(process.argv[2] ?? 110)
if (!Number.isInteger(columns) || columns < 12 || columns > 200) throw new Error('columns must be between 12 and 200')
const markdown = `## Reading hierarchy
One paragraph with **important words**, an inline \`config.json\` value, and a [reference](https://example.com/docs).
- A compact list item with **a highlighted phrase** and \`inline code\`.
- A longer list item: 中文内容、组合字符 é、emoji 👩‍💻, followed by enough ordinary words to wrap and expose the continuation column.
### Next section
Paragraph before a quote.
> A quoted passage with **emphasis** and \`a value\`.
\`\`\`ts
const enabled = true
console.log("hello")
\`\`\`
Paragraph after code.

Another paragraph, separated in the source.

| Role | Appearance |
| --- | --- |
| Heading | Section anchor |
| Code | Technical object |

Final paragraph with ~~removed words~~ and a [link](https://example.com).
`
const tool = (name, title, card = 'generic') => React.createElement(AssistantToolUseMessage, {
  key: name, marginTopOnTurn: false, verbose: false,
  tool: { name, callId: name, status: 'ok', argsText: '{}', durationMs: 1200, callView: { card, title } },
})
const tree = React.createElement(ThemeProvider, null,
  React.createElement(TerminalSizeContext.Provider, { value: { columns, rows: 100 } },
    React.createElement(PageMargin, null,
      React.createElement(Box, { flexDirection: 'column' },
        React.createElement(AssistantThinkingMessage, { thinking: 'Inspecting the layout', durationMs: 4700, verbose: false, marginTopOnTurn: false }),
        tool('read', 'Read src/components/Markdown.tsx (1 - 290)'),
        tool('bash', 'node scripts/verify-markdown-blocks.mjs && node scripts/verify-code-block-caption.mjs && node --import tsx/esm scripts/verify-markdown-hanging.tsx', 'terminal'),
        React.createElement(Box, { marginTop: 1 }, React.createElement(Markdown, null, markdown)),
      ),
    ),
  ),
)
const { Terminal } = xterm.default ?? xterm
const term = new Terminal({ cols: columns, rows: 100, allowProposedApi: true })
const stdout = new Writable({ write(chunk, _encoding, done) { term.write(String(chunk), done) } })
Object.assign(stdout, { columns, rows: 100, isTTY: true })
const stdin = new PassThrough()
Object.assign(stdin, { isTTY: true, setRawMode() { return this }, ref() {}, unref() {} })
const stderr = new Writable({ write(_chunk, _encoding, done) { done() } })
const app = await render(React.createElement(AlternateScreen, null, tree), { stdout, stdin, stderr, patchConsole: false, exitOnCtrlC: false })
const lineAt = y => term.buffer.active.getLine(term.buffer.active.baseY + y)
if (!await settled(() => Array.from({ length: 100 }, (_, y) => lineAt(y)?.translateToString(true) ?? '').some(line => line.includes('removed words')))) throw new Error('probe did not paint its final paragraph')
if (!await settled(() => {
  const line = Array.from({ length: 100 }, (_, y) => lineAt(y)).find(line => line?.translateToString(true).includes('const enabled'))
  const x = line?.translateToString(true).indexOf('const') ?? -1
  return x >= 0 && line.getCell(x)?.getFgColor() === 0x78a0d6
})) throw new Error('probe did not paint syntax highlighting')
const height = Array.from({ length: 100 }, (_, y) => lineAt(y)?.translateToString(true) ?? '').findLastIndex(line => line.trim()) + 2
const lines = Array.from({ length: height }, (_, y) => lineAt(y))
for (let y = 0; y < height; y++) {
  console.log(`${String(y).padStart(2)}|${lines[y]?.translateToString(true) ?? ''}`)
}

if (process.argv[3]) {
  const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${columns * 10 + 24}" height="${height * 22 + 24}"><rect width="100%" height="100%" fill="#101010"/>`]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < columns; x++) {
      const cell = lines[y]?.getCell(x)
      const char = cell?.getChars()
      if (!char || char === ' ') continue
      const ansiColors = ['#101010', '#cc6666', '#82b89d', '#e5c07b', '#7da1de', '#b3a0d4', '#56b6c2', '#e8e6e0']
      const color = cell.isFgRGB() ? '#' + cell.getFgColor().toString(16).padStart(6, '0') : cell.isFgPalette() ? ansiColors[cell.getFgColor() % 8] : '#e8e6e0'
      const decoration = [cell.isUnderline() ? 'underline' : '', cell.isStrikethrough() ? 'line-through' : ''].filter(Boolean).join(' ')
      svg.push(`<text x="${12 + x * 10}" y="${29 + y * 22}" fill="${color}" font-family="DejaVu Sans Mono,monospace" font-size="16"${cell.isBold() ? ' font-weight="bold"' : ''}${cell.isItalic() ? ' font-style="italic"' : ''}${decoration ? ` text-decoration="${decoration}"` : ''}>${escape(char)}</text>`)
    }
  }
  svg.push('</svg>')
  const image = svg.join('')
  writeFileSync(process.argv[3], image)
  const { default: sharp } = await import('sharp')
  await sharp(Buffer.from(image)).png().toFile(process.argv[3].replace(/\.svg$/, '') + '.png')
}
await app.unmount()

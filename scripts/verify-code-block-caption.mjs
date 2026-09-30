#!/usr/bin/env node
/**
 * P2 code captions, against compiled lib. Run after build:
 * node scripts/verify-code-block-caption.mjs
 * Keeps code bodies, syntax colors, logical layout and soft-wrap copy intact.
 */
await import('./lib/fake-home.mjs')
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_THEME = 'dark'
process.env.FORCE_HYPERLINK = '0'
process.env.TERM = 'dumb'
delete process.env.TERM_PROGRAM
delete process.env.LC_TERMINAL
const [assertModule, React, { marked }, { default: stripAnsi }, markdown, { getActiveTheme }, { colorize }, { getCliHighlightPromise }, { Markdown }, { StreamingMarkdown }, { renderToScreen }, { cellAt }, { TerminalSizeContext }, selection] = await Promise.all([
  import('node:assert/strict'), import('react'), import('marked'), import('strip-ansi'),
  import('../lib/types/terminal-utils/markdown.js'), import('../lib/types/theme.js'),
  import('../lib/types/ink/colorize.js'), import('../lib/types/terminal-utils/cliHighlight.js'),
  import('../lib/types/components/Markdown.js'), import('../lib/types/components/StreamingMarkdown.js'),
  import('../lib/types/ink/render-to-screen.js'), import('../lib/types/ink/screen.js'),
  import('../lib/types/ink/components/TerminalSizeContext.js'), import('../lib/types/ink/selection.js'),
])
const assert = assertModule.default
const { configureMarked, formatToken, formatTokenWithLayout, applyMarkdown } = markdown
configureMarked()
let checks = 0
function check(name, fn) {
  fn()
  checks++
  console.log(`PASS ${name}`)
}
function token(source) {
  const tokens = marked.lexer(source)
  assert.equal(tokens.length, 1)
  assert.equal(tokens[0].type, 'code')
  return tokens[0]
}
function body(text) {
  const trimmed = text.replace(/\n+$/, '')
  return trimmed ? trimmed.split('\n').map(line => line ? '  ' + line : '').join('\n') + '\n' : ''
}
const cases = [
  ['tagged', '```ts\nconst value = 1\n```', 'ts'],
  ['unknown language', '```not-a-language\nx\n```', 'not-a-language'],
  ['original info', '```ts title=demo.ts\nconst value = 1\n```', 'ts title=demo.ts'],
  ['tilde fence', '~~~sh\nprintf ok\n~~~', 'sh'],
  ['long fence and literal ticks', '````txt\n```literal\n````', 'txt'],
  ['untagged', '```\nx\n```', '```'],
  ['indented', '    x\n    y', '```'],
  ['empty tagged', '```ts\n```', 'ts'],
  ['empty untagged', '```\n```', '```'],
  ['blank body lines', '```txt\na\n\nb\n\n```', 'txt'],
  ['CRLF source', '```txt\r\na\r\nb\r\n```', 'txt'],
  ['unclosed tagged', '```ts\nconst pending =', 'ts'],
  ['mermaid source', '```mermaid\ngantt\n  title unsupported\n```', 'mermaid'],
]
for (const [name, source, caption] of cases) {
  const code = token(source)
  check(`${name}: only caption changes`, () => {
    const actual = formatToken(code)
    const expectedCaption = colorize(caption, getActiveTheme().subtle, 'foreground')
    assert.equal(actual, expectedCaption + '\n' + body(code.text))
    if (source.trimStart() === source) assert.equal(applyMarkdown(source), actual.trimEnd())
    assert.equal(actual.includes('\x1b[8m'), false, 'caption is not concealed with SGR 8')
  })
  check(`${name}: logical layout unchanged`, () => {
    const result = formatTokenWithLayout(code)
    assert.equal(result.text, formatToken(code))
    assert.deepEqual(result.continuationIndent, result.text.split('\n').map(() => 0))
  })
}
check('nested lists and quotes retain captions and literal body ticks', () => {
  assert.equal(stripAnsi(applyMarkdown('- item\n\n  ````txt\n  ```literal\n  ````')), '- item\n\n  txt\n    ```literal')
  assert.equal(stripAnsi(applyMarkdown('> ```txt\n> abc\n> ```')), '\u258e txt\n\u258e   abc')
})
check('empty or whitespace info retains a boundary cue', () => {
  for (const lang of ['', '   ', undefined]) {
    const actual = formatToken({ type: 'code', raw: '', lang, text: '' })
    assert.equal(stripAnsi(actual), '```\n')
  }
})
const highlighter = await getCliHighlightPromise()
assert.ok(highlighter, 'real syntax highlighter must load')
const { buildSyntaxTheme } = await import('../lib/types/terminal-utils/syntaxTheme.js')
for (const [name, source] of [['supported', '```ts\nconst value = "string"\n// comment\n```'], ['unsupported info', '```ts title=demo.ts\nconst value = "string"\n```']]) {
  check(`${name}: syntax colors and language selection unchanged`, () => {
    const code = token(source)
    const language = code.lang && highlighter.supportsLanguage(code.lang) ? code.lang : 'plaintext'
    const colored = highlighter.highlight(code.text, { language, theme: buildSyntaxTheme(getActiveTheme()) })
    const actual = formatToken(code, 0, null, null, highlighter)
    assert.equal(actual.slice(actual.indexOf('\n') + 1), body(colored))
    assert.equal(stripAnsi(actual).split('\n')[0], code.lang)
  })
}
function rows(screen) {
  return Array.from({ length: screen.height }, (_, y) => {
    let line = ''
    for (let x = 0; x < screen.width; x++) {
      const cell = cellAt(screen, x, y)
      line += cell.char
    }
    return line.trimEnd()
  })
}
function copy(screen) {
  const state = selection.createSelectionState()
  selection.startSelection(state, 0, 0)
  selection.updateSelection(state, screen.width - 1, screen.height - 1)
  return selection.getSelectedText(state, screen)
}
function render(Component, source, width) {
  const tree = React.createElement(TerminalSizeContext.Provider, { value: { columns: width, rows: 24 } }, React.createElement(Component, null, source))
  return renderToScreen(tree, width)
}
for (const width of [8, 20, 55]) {
  for (const Component of [Markdown, StreamingMarkdown]) {
    for (const [name, source, tagged] of [
      ['info', '```ts title=demo.ts\nconst abcdefghijklmnop = 1\n```', true],
      ['CJK info', '```ts title=\u793a\u4f8b.ts\nconst message = "\u4e2d\u6587"\n```', true],
      ['empty tagged', '```ts\n```', true],
      ['untagged', '```\nabcdefghijk\n```', false],
    ]) {
      check(`${Component === Markdown ? 'settled' : 'streaming'} width=${width} ${name}: caption and soft-wrap copy`, () => {
        const actual = render(Component, source, width)
        assert.ok(actual.height > 0, 'fixture must render')
        assert.equal(copy(actual.screen), stripAnsi(applyMarkdown(source)))
        assert.equal(rows(actual.screen).some(line => line.includes('```')), !tagged)
      })
    }
  }
}
check('large code preserves the full body and tail', () => {
  const source = '```txt\n' + 'x'.repeat(60_000) + 'TAIL_7F31\n```'
  const actual = render(Markdown, source, 55)
  assert.ok(actual.height > 1000)
  assert.equal(copy(actual.screen), stripAnsi(applyMarkdown(source)))
  assert.equal((copy(actual.screen).match(/TAIL_7F31/g) ?? []).length, 1)
})
console.log(`PASS ${checks} code-caption checks`)

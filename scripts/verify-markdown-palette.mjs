#!/usr/bin/env node
/**
 * Markdown P1 palette regression against compiled lib; never builds or edits lib.
 * Run after compilation: node scripts/verify-markdown-palette.mjs
 * Isolates preferences with fake-home and enables truecolor before dynamic imports.
 * Thinking JSX contracts are checked structurally via TypeScript's AST, not grep.
 * Hanging soft-wrap geometry/copy is covered separately by verify-hanging-wrap.tsx.
 */
await import('./lib/fake-home.mjs')
process.env.FORCE_COLOR = '3'
process.env.FORCE_HYPERLINK = '0'
process.env.DSH_TUI_THEME = 'dark'
process.env.TERM = 'dumb'
delete process.env.TERM_PROGRAM
delete process.env.LC_TERMINAL
delete process.env.TMUX
const [theme, { applyMarkdown, formatToken }, { colorize }, { default: stripAnsi }, { default: ts }, { readFileSync }] = await Promise.all([
  import('../lib/types/theme.js'),
  import('../lib/types/terminal-utils/markdown.js'),
  import('../lib/types/ink/colorize.js'),
  import('strip-ansi'),
  import('typescript'),
  import('node:fs'),
])
let checks = 0
let failures = 0
function check(name, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || !detail ? '' : ` (${detail})`}`)
}
function equal(name, actual, expected) {
  check(name, actual === expected, JSON.stringify({ actual, expected }))
}
const fallbacks = {
  markdownHeading: 'accent',
  markdownStrong: 'toolNameMutate',
  markdownEmph: 'warning',
  markdownCode: 'permission',
  markdownLink: 'ide',
  markdownBlockQuote: 'warning',
  markdownListItem: 'permission',
  markdownListEnumeration: 'ide',
  markdownHorizontalRule: 'inactive',
}
const keys = Object.keys(fallbacks)
// Inspect the effective foreground of every visible character, including spans
// nested inside other semantic colors. ANSI resets must restore the outer span.
function foregrounds(value) {
  let foreground = null
  const cells = []
  const sgr = /\u001b\[([0-9;]*)m/g
  let end = 0
  function append(text) {
    for (const char of text) cells.push({ char, foreground })
  }
  for (const match of value.matchAll(sgr)) {
    append(value.slice(end, match.index))
    const codes = (match[1] || '0').split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]
      if (code === 0 || code === 39) foreground = null
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) foreground = String(code)
      else if (code === 38 && codes[i + 1] === 2) {
        foreground = codes.slice(i, i + 5).join(';')
        i += 4
      } else if (code === 38 && codes[i + 1] === 5) {
        foreground = codes.slice(i, i + 3).join(';')
        i += 2
      }
    }
    end = match.index + match[0].length
  }
  append(value.slice(end))
  return cells
}
function expectedForeground(color) {
  return foregrounds(colorize('X', color, 'foreground'))[0].foreground
}
function painted(name, output, text, color) {
  const cells = foregrounds(output)
  const plain = cells.map(cell => cell.char).join('')
  const start = plain.indexOf(text)
  const length = [...text].length
  const expected = expectedForeground(color)
  check(name, start >= 0 && expected !== null && cells.slice(start, start + length).every(cell => cell.foreground === expected), JSON.stringify({ plain, text, expected }))
}
const fixtures = [
  ['markdownHeading', '# HEADING', 'HEADING', 'HEADING'],
  ['markdownStrong', '**STRONG**', 'STRONG', 'STRONG'],
  ['markdownEmph', '*EMPHASIS*', 'EMPHASIS', 'EMPHASIS'],
  ['markdownCode', '`INLINE_CODE`', 'INLINE_CODE', 'INLINE_CODE'],
  ['markdownLink', '[LINK](https://example.invalid)', 'https://example.invalid', 'https://example.invalid'],
  ['markdownBlockQuote', '> QUOTED', 'QUOTED', '\u258e QUOTED'],
  ['markdownListItem', '- ITEM', '-', '- ITEM'],
  ['markdownListEnumeration', '9. NINE\n10. TEN', '10.', '9. NINE\n10. TEN'],
  ['markdownHorizontalRule', '---', '\u2500'.repeat(16), '\u2500'.repeat(16)],
]
function verifyPalette(name, palette) {
  theme.setActiveThemeName(name)
  for (const [key, source, text, plain] of fixtures) {
    check(`${name}: ${key} is concrete`, typeof palette[key] === 'string' && palette[key].length > 0)
    const output = applyMarkdown(source)
    equal(`${name}: ${key} preserves text`, stripAnsi(output), plain)
    painted(`${name}: ${key} paints its span`, output, text, palette[key])
  }
  const mixed = applyMarkdown('> QUOTE **STRONG `CODE` TAIL**\n\n9. NUMBER **BOLD `INNER` END**')
  equal(`${name}: nested quote/list text intact`, stripAnsi(mixed), '\u258e QUOTE STRONG CODE TAIL\n\n9. NUMBER BOLD INNER END')
  for (const [text, key] of [['QUOTE', 'markdownBlockQuote'], ['STRONG', 'markdownStrong'], ['CODE', 'markdownCode'], ['TAIL', 'markdownStrong'], ['9.', 'markdownListEnumeration'], ['BOLD', 'markdownStrong'], ['INNER', 'markdownCode'], ['END', 'markdownStrong']]) {
    painted(`${name}: nested ${text} keeps its own color`, mixed, text, palette[key])
  }
  check(`${name}: strong and nested code differ`, expectedForeground(palette.markdownStrong) !== expectedForeground(palette.markdownCode))
}
try {
  for (const name of ['dark', 'light', 'dark-ansi']) {
    const palette = theme.getTheme(name)
    verifyPalette(name, palette)
    check(`${name}: heading, strong, code and link have distinct foregrounds`, new Set(['markdownHeading', 'markdownStrong', 'markdownCode', 'markdownLink'].map(key => expectedForeground(palette[key]))).size === 4)
    if (name === 'dark-ansi') check('dark-ansi: all Markdown keys use ANSI16', keys.every(key => /^ansi:(black|red|green|yellow|blue|magenta|cyan|white)(Bright)?$/.test(palette[key])))
  }
  theme.setActiveThemeName('dark')
  equal('heading token emits exactly one LF', stripAnsi(formatToken({ type: 'heading', raw: '# TITLE\n', depth: 1, text: 'TITLE', tokens: [{ type: 'text', raw: 'TITLE', text: 'TITLE' }] })), 'TITLE\n')
  for (const [source, expected] of [
    ['# TITLE\n\nBODY', 'TITLE\n\nBODY'],
    ['BEFORE\n\n## TITLE\n\nBODY', 'BEFORE\n\nTITLE\n\nBODY'],
    ['# FIRST\n\n## SECOND\n\nBODY', 'FIRST\n\nSECOND\n\nBODY'],
  ]) equal(`heading block spacing exact: ${JSON.stringify(source)}`, stripAnsi(applyMarkdown(source)), expected)

  const old = { ...theme.getTheme('dark') }
  for (const key of keys) delete old[key]
  for (const [i, fallback] of [...new Set(Object.values(fallbacks))].entries()) old[fallback] = `rgb(${20 + i},${90 + i},${140 + i})`
  const before = { ...old }
  const normalized = theme.normalizeThemePalette(old)
  for (const [key, fallback] of Object.entries(fallbacks)) equal(`legacy own fallback: ${key}`, normalized[key], old[fallback])
  equal('legacy normalization does not mutate input', JSON.stringify(old), JSON.stringify(before))
  check('legacy cache reuses unchanged palette', theme.normalizeThemePalette(old) === normalized)
  old.warning = 'rgb(201,151,31)'
  const changed = theme.normalizeThemePalette(old)
  check('legacy mutation invalidates cache', changed !== normalized)
  equal('legacy warning mutation updates emphasis', changed.markdownEmph, old.warning)
  equal('legacy warning mutation updates quote', changed.markdownBlockQuote, old.warning)
  old.markdownStrong = 'rgb(241,171,81)'
  equal('explicit new key beats fallback after mutation', theme.normalizeThemePalette(old).markdownStrong, old.markdownStrong)
  old.text = 'rgb(211,212,213)'
  equal('unrelated legacy mutation also refreshes palette', theme.normalizeThemePalette(old).text, old.text)
  const absent = theme.normalizeThemePalette({})
  for (const [key, fallback] of Object.entries(fallbacks)) equal(`missing old fallback uses dark: ${key}`, absent[key], theme.getTheme('dark')[fallback])
  const complete = { ...theme.getTheme('light'), markdownCode: 'rgb(9,88,177)' }
  check('complete custom palette preserves identity', theme.normalizeThemePalette(complete) === complete)
  for (const invalid of [null, undefined, [], 'dark']) equal('invalid palette is rejected', theme.normalizeThemePalette(invalid), undefined)

  theme.registerCustomThemeResolver(name => name === 'palette-old-custom' ? old : name === 'palette-complete' ? complete : undefined)
  const dispose = theme.registerRuntimeThemeResolver(name => name === 'palette-old-plugin' ? old : undefined)
  try {
    for (const name of ['palette-old-custom', 'palette-old-plugin']) {
      const resolved = theme.getTheme(name)
      for (const [key, fallback] of Object.entries(fallbacks)) equal(`${name}: resolver fallback ${key}`, resolved[key], old[key] ?? old[fallback])
      verifyPalette(name, resolved)
    }
    check('complete resolver preserves identity', theme.getTheme('palette-complete') === complete)
    verifyPalette('palette-complete', complete)
    const previous = theme.getTheme('palette-old-plugin')
    old.permission = 'rgb(44,155,222)'
    check('runtime resolver mutation invalidates cache', theme.getTheme('palette-old-plugin') !== previous)
    equal('runtime resolver mutation repaints inline code', theme.getTheme('palette-old-plugin').markdownCode, old.permission)
  } finally { dispose() }

  const file = ts.createSourceFile('AssistantThinkingMessage.tsx', readFileSync(new URL('../src/components/messages/AssistantThinkingMessage.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const elements = []
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) elements.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  const named = (node, name) => ts.isIdentifier(node.tagName) && node.tagName.text === name
  const attribute = (node, name) => node.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.text === name)
  const warnings = elements.filter(node => named(node, 'Text') && attribute(node, 'color')).filter(node => {
    const initializer = attribute(node, 'color').initializer
    let found = false
    function scan(child) {
      if (ts.isStringLiteral(child) && child.text === 'warning') found = true
      ts.forEachChild(child, scan)
    }
    if (initializer) scan(initializer)
    return found
  })
  check('thinking: header and preview have warning-colored Text nodes', warnings.length >= 3)
  check('thinking: warning text is never dimmed', warnings.length >= 3 && warnings.every(node => !attribute(node, 'dimColor')))
  check('thinking: minimal UI leaves warning color unspecified', warnings.length >= 3 && warnings.every(node => {
    const initializer = attribute(node, 'color').initializer
    const expression = initializer && ts.isJsxExpression(initializer) ? initializer.expression : undefined
    return expression && ts.isConditionalExpression(expression)
      && ts.isIdentifier(expression.condition) && expression.condition.text === 'minimalUi'
      && ts.isIdentifier(expression.whenTrue) && expression.whenTrue.text === 'undefined'
  }))
  const markdownNodes = elements.filter(node => named(node, 'StreamingMarkdown'))
  check('thinking: expanded Markdown is not globally dimmed', markdownNodes.length > 0 && markdownNodes.every(node => !attribute(node, 'dimColor')))
} finally {
  theme.setActiveThemeName('dark')
  theme.registerCustomThemeResolver(() => undefined)
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exitCode = 1
else console.log('Markdown P1 palette: OK')

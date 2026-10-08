#!/usr/bin/env node
/**
 * Markdown P0 regression against compiled lib (never builds or modifies lib).
 * Run after build: node scripts/verify-markdown-blocks.mjs
 * FORCE_COLOR precedes dynamic imports; OSC is disabled for visible URL checks.
 * Covers list markers/continuation indentation, recursive inline content,
 * tasks, images, strike versus approximations, and horizontal-rule boundaries.
 */
await import('./lib/fake-home.mjs')
process.env.FORCE_COLOR = '3'
process.env.FORCE_HYPERLINK = '0'
process.env.DSH_TUI_THEME = 'dark'
process.env.TERM = 'dumb'
delete process.env.TERM_PROGRAM
delete process.env.LC_TERMINAL
const [{ applyMarkdown, formatToken, formatTokenWithLayout, joinFormattedMarkdown, trimFormattedMarkdown }, { default: stripAnsi }, { supportsHyperlinks }, { marked }] = await Promise.all([
  import('../lib/types/terminal-utils/markdown.js'),
  import('strip-ansi'),
  import('../lib/types/ink/supports-hyperlinks.js'),
  import('marked'),
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
const plain = source => stripAnsi(applyMarkdown(source))
function linesEqual(name, source, expected) {
  equal(name, JSON.stringify(plain(source).split('\n').filter(line => line.trim())), JSON.stringify(expected))
}
check('OSC disabled for URL fallbacks', !supportsHyperlinks())
linesEqual('tight unordered markers', '- one\n- two', ['- one', '- two'])
linesEqual('loose unordered markers', '- one\n\n- two', ['- one', '- two'])
linesEqual('tight ordered start/increment', '9. nine\n10. ten', ['9. nine', '10. ten'])
linesEqual('loose ordered start/increment', '9. nine\n\n10. ten', ['9. nine', '10. ten'])
equal('empty list item keeps marker', plain('- \n- next'), '- \n- next')
linesEqual('nested unordered markers', '- outer\n  - inner\n    - leaf', ['- outer', '  - inner', '    - leaf'])
// Each nested list aligns beneath its parent's content, not its marker.
linesEqual('nested ordered decimal/alpha/roman/decimal markers', '3. outer\n   2. inner\n      4. deep\n         7. deepest\n   3. next', ['3. outer', '   b. inner', '      iv. deep', '          7. deepest', '   c. next'])
for (const gap of ['\n', '\n\n']) {
  equal(`${gap.length === 1 ? 'tight' : 'loose'} tasks have no extra checkbox newline`, plain(`- [ ] pending${gap}- [x] done`), '- [ ] pending\n- [\u2713] done')
}
const url = 'https://example.com/guide'
const inline = applyMarkdown(`- **outer *inner* [guide](${url})**\n\n- second **bold**`)
equal('recursive bold/link keeps list markers and URL', stripAnsi(inline), `- outer inner ${url}\n- second bold`)
check('recursive inline retains bold and italic ANSI', inline.includes('\u001b[1m') && inline.includes('\u001b[22m') && inline.includes('\u001b[3m') && inline.includes('\u001b[23m'), JSON.stringify(inline))
for (const [label, source, first, minimum] of [
  ['unordered', '- first\n\n  continuation **bold**\n  next line\n\n  ```txt\n  code one\n  code two\n  ```\n\n  after code\n- sibling', '- first', 2],
  ['wide ordered', '100. first\n\n     continuation **bold**\n     next line\n\n     ```txt\n     code one\n     code two\n     ```\n\n     after code\n101. sibling', '100. first', 5],
  ['nested ordered', '1. outer\n   2. first\n\n      continuation **bold**\n      next line\n\n      ```txt\n      code one\n      code two\n      ```\n\n      after code\n   3. sibling', '   b. first', 6],
]) {
  const rendered = plain(source)
  const lines = rendered.split('\n')
  check(`${label} first marker occurs once`, lines.filter(line => line === first).length === 1, JSON.stringify(rendered))
  check(`${label} paragraphs/caption/code keep marker-width indentation`, ['continuation bold', 'next line', 'txt', 'code one', 'code two', 'after code'].every(content => {
    const line = lines.find(candidate => candidate.trim() === content)
    return line !== undefined && /^ */.exec(line)[0].length >= minimum
  }), JSON.stringify(rendered))
}
const imageUrl = 'https://example.com/diagram.png'
const image = applyMarkdown(`before ![architecture diagram](${imageUrl}) after`)
check('image preserves alt and URL with no OSC', stripAnsi(image).includes('architecture diagram') && stripAnsi(image).includes(imageUrl) && !image.includes('\u001b]8;'), JSON.stringify(image))
const strike = applyMarkdown('before ~~removed **bold**~~ after')
equal('strike preserves recursive text', stripAnsi(strike), 'before removed bold after')
check('strike and nested bold emit ANSI styles', strike.includes('\u001b[9m') && strike.includes('\u001b[29m') && strike.includes('\u001b[1m'), JSON.stringify(strike))
const approximate = applyMarkdown('cost ~100 and ~200~ units')
equal('single tilde approximations stay literal', stripAnsi(approximate), 'cost ~100 and ~200~ units')
check('single tilde emits no strike', !approximate.includes('\u001b[9m'), JSON.stringify(approximate))
const rule = '\u2500'.repeat(16)
// applyMarkdown trims terminal LF; formatToken checks the block boundary itself.
equal('hr token has 16 cells and LF', stripAnsi(formatToken({ type: 'hr', raw: '---\n' })), `${rule}\n`)
equal('hr cannot merge with following paragraph', plain('before\n\n---\n\nafter'), `before\n\n${rule}\n\nafter`)
// Images keep their URL as visible text; only the outer target is clickable.
// Wrapper terminal detection is dynamic, unlike the library's cached probe.
process.env.TERM_PROGRAM = 'kitty'
const linkedImage = applyMarkdown('[![alt](https://example.com/i.png)](https://example.com/page)')
equal('linked image OSC label is intact', stripAnsi(linkedImage), 'alt (https://example.com/i.png)')
check('linked image emits only the outer OSC target', (linkedImage.match(/\u001b\]8;;https:/g) ?? []).length === 1 && linkedImage.includes('\u001b]8;;https://example.com/page\u0007'), JSON.stringify(linkedImage))
for (const [name, source, expected] of [
  ['mixed paragraphs and tasks', 'plain\n\n- [x] done\n- next\n\nlast', [0, 0, 6, 2, 0, 0]],
  ['nested ordered and code', '1. a\n   2. nested\n\n      ```txt\n      - not a list\n      ```', [3, 6, 0, 6, 8]],
  ['quoted nested list', '> - quote\n>   - nested', [4, 6]],
  ['quote inside list', '- > - quoted item', [6]],
  ['later quote inside list', '- outer\n\n  > - quoted item', [2, 0, 6]],
  ['ordinary quote body', '> quoted words', [2]],
  ['large quoted list', Array.from({ length: 6000 }, () => '> - item').join('\n'), Array(6000).fill(4)],
  ['empty item', '- \n- next', [2, 2]],
]) {
  const part = trimFormattedMarkdown(joinFormattedMarkdown(marked.lexer(source).map(token => formatTokenWithLayout(token))), false, true)
  equal(`${name} layout retains formatter text`, part.text, applyMarkdown(source))
  equal(`${name} content columns`, JSON.stringify(part.continuationIndent), JSON.stringify(expected))
  equal(`${name} one metadata entry per logical line`, part.continuationIndent.length, part.text.split('\n').length)
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exitCode = 1
else console.log('Markdown P0 blocks: OK')

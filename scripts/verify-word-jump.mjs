#!/usr/bin/env node
/**
 * Regression: Ctrl/Option/Alt word movement and Ctrl+W in PromptInput.
 * Covers legacy, CSI-u and modifyOtherKeys encodings, Chinese without spaces,
 * whitespace, punctuation, emoji, middle-of-draft deletion and empty input.
 *
 * Windows Terminal (and most xterm-family terminals) deliver Ctrl+Left as
 * ESC[1;5D — parsed to { name: 'left', ctrl: true } (parse-keypress.ts) and
 * mapped to leftArrow:true with ctrl preserved (input-event.ts). The prompt
 * dispatch must therefore test isMod(key) && key.leftArrow BEFORE the bare
 * key.leftArrow arm, or the word-jump arms stay dead code and Ctrl+Arrow
 * degrades to single-char movement.
 *
 * End-to-end through the REAL tokenizer/parser/render pipeline (compiled
 * lib, mock channel): type "hello world", move the caret with Ctrl/bare
 * arrows, insert a distinct marker after each move, then submit — the final
 * string encodes every caret position (asserted at submit time):
 *   type  "hello world"                caret 11
 *   Ctrl+Left  → caret 6               insert X → "hello Xworld"   caret 7
 *   Ctrl+Left  → caret 6               insert Y → "hello YXworld"  caret 7
 *   bare Left  → caret 6  (single char — NOT a word jump to 0)
 *                                      insert Z → "hello ZYXworld" caret 7
 *   Ctrl+Right → caret 14 (end)        insert Q → "hello ZYXworldQ"
 *   Enter → channel.submit("hello ZYXworldQ")
 *
 * With the #156 bug (bare-arrow arm first) every Ctrl+Arrow moves a single
 * char and the markers land in different places, so the submitted value
 * differs. A word-jump-on-bare-arrow regression likewise moves marker Z.
 *
 * Plus a static invariant (verify-cordis-approval style): in the source the
 * word-boundary moves must textually precede the bare arrow arms.
 *
 * Run with plain node against the compiled lib:
 *   node scripts/verify-word-jump.mjs
 * Exits 1 on any failed assertion (CI gate).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Writable, PassThrough } from 'node:stream'
// Redirect HOME/USERPROFILE into a throwaway sandbox before the app modules
// load: this fixture submits text, and `rememberHistory` persists it into
// `~/.dsh-tui/history.jsonl` — writing the developer's real input history from
// a test would both leak fixture strings into `↑`/Ctrl+R and (at the 200-entry
// cap) evict their real entries.
import './lib/fake-home.mjs'
import React from 'react'
import { settled, sleep } from './lib/term-test.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const { render } = await import('../lib/types/ui.js')
const { PromptInput } = await import('../lib/types/components/PromptInput.js')
const controller = { current: null }
let backgroundRequests = 0

function makeStreams() {
  const stdout = new Writable({ write(_c, _e, cb) { cb() } })
  stdout.columns = 100
  stdout.rows = 30
  stdout.isTTY = true
  const stderr = new Writable({ write(_c, _e, cb) { cb() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  return { stdout, stderr, stdin }
}

const submitted = []
const channel = {
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  commandList: [],
  commandCompletions: () => [],
  notifications: [],
  pending: [],
  working: false,
  notify() {},
  submit(text) { submitted.push(text) },
  steer() {},
  interruptAndDeliver() {},
  removePending() {},
  stageImage() {},
  listFiles: async () => [],
}

const { stdout, stderr, stdin } = makeStreams()
const instance = await render(
  React.createElement(PromptInput, {
    channel,
    helpOpen: false,
    onToggleHelp() {},
    onRunCommand: () => false,
    selectionActive: false,
    controllerRef: controller,
    onBackgroundRequest() { backgroundRequests += 1 },
  }),
  { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
)
// 固定窗:pacing 等首帧——React 树首次渲染与输入监听挂接无单一可观测条件。
await sleep(600)

const feed = async seq => {
  stdin.write(seq)
  // 固定窗:pacing 按键步间——每步移动/插入后的光标位置对外不可观测
  // （stdout 被丢弃），只有最终 submit 可断言。
  await sleep(250)
}

await feed('hello world')
await feed('\x1b[1;5D') // Ctrl+Left  → caret 6 (word start; bug: 10)
await feed('X')
await feed('\x1b[1;5D') // Ctrl+Left  → caret 6
await feed('Y')
await feed('\x1b[D')    // bare Left  → caret 6 (single char; jump bug: 0)
await feed('Z')
await feed('\x1b[1;5C') // Ctrl+Right → caret 14 (end of "…world")
await feed('Q')
stdin.write('\r')

check(
  'caret moves + inserts compose to the expected submitted text',
  await settled(() => submitted.length === 1 && submitted[0] === 'hello ZYXworldQ'),
  JSON.stringify(submitted),
)

// Observe the synchronous draft controller instead of adding fixed waits for
// each new case. One stdin batch exercises cursor/edit composition as well.
async function editCase(name, sequence, expected) {
  controller.current.clear()
  stdin.write(sequence)
  check(name, await settled(() => controller.current?.text() === expected),
    JSON.stringify(controller.current?.text()))
}

const wordKeys = [
  ['Ctrl+arrows', '\x1b[1;5D', '\x1b[1;5C'],
  ['Option/Alt+arrows', '\x1b[1;3D', '\x1b[1;3C'],
  ['Option/Alt+B/F (legacy)', '\x1bb', '\x1bf'],
  ['Option/Alt+B/F (CSI-u)', '\x1b[98;3u', '\x1b[102;3u'],
  ['Option/Alt+B/F (modifyOtherKeys)', '\x1b[27;3;98~', '\x1b[27;3;102~'],
]
for (const [label, left, right] of wordKeys) {
  await editCase(`${label}: left moves by word`, `hello world${left}X`, 'hello Xworld')
  await editCase(`${label}: right moves by word`, `hello world\x1b[H${right}X`, 'hello Xworld')
  await editCase(`${label}: Chinese left does not jump across the whole draft`,
    `你好世界${left}X`, '你好X世界')
  await editCase(`${label}: Chinese right moves to the next word`,
    `你好世界\x1b[H${right}X`, '你好X世界')
  await editCase(`${label}: empty draft does not background the session`, `${left}X`, 'X')
}
check('modified word-left never backgrounds an empty draft', backgroundRequests === 0)

for (const [label, key] of [
  ['Ctrl+W (legacy)', '\x17'],
  ['Ctrl+W (CSI-u)', '\x1b[119;5u'],
  ['Ctrl+W (modifyOtherKeys)', '\x1b[27;5;119~'],
]) {
  await editCase(`${label}: Chinese deletes only the preceding word`, `你好世界${key}`, '你好')
  await editCase(`${label}: deletes a word with trailing whitespace`, `hello  world  ${key}`, 'hello  ')
  await editCase(`${label}: keeps text after the caret`,
    `hello world tail\x1b[1;5D${key}`, 'hello tail')
  await editCase(`${label}: preserves the previous line`,
    `\x1b[200~first line\n你好世界\x1b[201~${key}`, 'first line\n你好')
  await editCase(`${label}: punctuation is a separate boundary`, `foo-bar${key}`, 'foo-')
  await editCase(`${label}: emoji stays a complete grapheme`, `hello 👩‍💻${key}`, 'hello ')
  await editCase(`${label}: empty draft stays usable`, `${key}X`, 'X')
  await editCase(`${label}: deleting a single word may empty the draft`, `word${key}`, '')
  await editCase(`${label}: combining marks are not split`, `hello e\u0301${key}`, 'hello ')
}

instance.unmount()

// ── static invariant: modified arrow arms precede bare arrow arms ─────────
const source = readFileSync(join(root, 'src/components/PromptInput.tsx'), 'utf8')
const wordLeft = source.indexOf('wordBoundaryLeft(value, cursor)')
const bareLeft = source.indexOf('if (key.leftArrow)')
const wordRight = source.indexOf('wordBoundaryRight(value, cursor)')
const bareRight = source.indexOf('if (key.rightArrow)')
check('source: word-left arm exists and precedes bare left arm', wordLeft !== -1 && bareLeft !== -1 && wordLeft < bareLeft)
check('source: word-right arm exists and precedes bare right arm', wordRight !== -1 && bareRight !== -1 && wordRight < bareRight)

if (failed > 0) {
  console.error(`verify-word-jump: ${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('verify-word-jump OK')

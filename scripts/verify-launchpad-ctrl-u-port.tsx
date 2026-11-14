/**
 * #1529 port regression through the real stdin parser and Launchpad.
 * Legacy, CSI-u and modifyOtherKeys must agree in inline/fullscreen mode,
 * including coalesced typing, Unicode, multiline boundaries, image tokens,
 * parameter focus and paused input. No backend, credentials or model calls.
 * Run: node --import tsx/esm scripts/verify-launchpad-ctrl-u-port.tsx
 */
await import('./lib/fake-home.mjs')
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'en'

import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import type { ChannelUi } from '../src/adapter/ports/channel-ui.js'
import { settled, sleep } from './lib/term-test.mjs'

const [{ render, ThemeProvider, AlternateScreen }, { Launchpad }, { resolveLaunchpadActions }] = await Promise.all([
  import('../src/ui.js'),
  import('../src/screens/Launchpad.js'),
  import('../src/components/launchpadActions.js'),
])
const { Terminal } = xterm
const actions = resolveLaunchpadActions({ jobsRunning: false, updateAvailable: false, starDue: false })
const protocols = [
  ['legacy', '\x15'],
  ['CSI-u', '\x1b[117;5u'],
  ['modifyOtherKeys', '\x1b[27;5;117~'],
] as const
interface Draft { query: string; caret: number; focus: number; paused: boolean; revision: number }
interface Event { type: string; query?: string; caret?: number; value?: string }
let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks++
  console.log(`PASS ${label}`)
}

async function open(fullscreen: boolean) {
  const term = new Terminal({ cols: 78, rows: 37, scrollback: 0, allowProposedApi: true })
  let writes = 0
  class Output extends Writable {
    isTTY = true
    columns = 78
    rows = 37
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      term.write(String(chunk), () => { writes++; callback() })
    }
  }
  class Input extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    override ref(): this { return this }
    override unref(): this { return this }
  }
  const input = new Input()
  const events: Event[] = []
  const bindings = new Map([['[Image #1]', 'fixture-stage-1']])
  const channel = { agentId: 'fixture', hasStagedImage: () => true } as unknown as ChannelUi
  let current: Draft = { query: '', caret: 0, focus: -1, paused: false, revision: 0 }
  let renderedRevision = -1
  let replace: ((draft: Draft) => void) | undefined
  function Harness(): React.ReactNode {
    const [draft, setDraft] = React.useState(current)
    current = draft
    replace = setDraft
    React.useLayoutEffect(() => { renderedRevision = draft.revision })
    return <Launchpad
      query={draft.query} cursorOffset={draft.caret} focusIndex={draft.focus}
      inputPaused={draft.paused} isTerminalFocused whale={false} whaleIdle={false}
      whaleGirl={false} starred={false} firstRun={false} egg={null} fontId="bold"
      actions={actions} model="fixture-model" effort="max" preset="Standard" permission="default"
      imageComposer={{ channel, bindings }}
      clipboardReader={async () => null}
      onQueryChange={(query, caret) => {
        events.push({ type: 'query', query, caret })
        setDraft(previous => ({ ...previous, query, caret }))
      }}
      onFocusChange={focus => { setDraft(previous => ({ ...previous, focus })) }}
      onParamPick={value => { events.push({ type: 'param', value }) }}
      onAction={() => { events.push({ type: 'action' }) }}
      onSubmit={query => { events.push({ type: 'submit', query }) }}
      onEscape={value => { events.push({ type: 'escape', value }) }}
    />
  }
  const tree = <Harness />
  const app = await render(<ThemeProvider theme="dark">
    {fullscreen ? <AlternateScreen>{tree}</AlternateScreen> : tree}
  </ThemeProvider>, {
    stdin: input as never, stdout: new Output() as never,
    stderr: new Writable({ write(_chunk, _encoding, callback) { callback() } }) as never,
    exitOnCtrlC: false, patchConsole: false,
  })
  assert.ok(await settled(() => renderedRevision === 0 && writes > 0), 'launchpad mounted')
  return {
    events,
    input,
    get draft() { return current },
    async reset(query: string, caret = query.length, focus = -1, paused = false) {
      const revision = current.revision + 1
      replace!({ query, caret, focus, paused, revision })
      assert.ok(await settled(() => renderedRevision === revision), 'controlled draft committed')
      events.length = 0
    },
    async close() { await app.unmount(); term.dispose() },
  }
}

for (const fullscreen of [false, true]) {
  const s = await open(fullscreen)
  try {
    for (const [protocol, sequence] of protocols) {
      const prefix = `${fullscreen ? 'fullscreen' : 'inline'} ${protocol}`
      for (const test of [
        { name: 'end', query: 'alpha beta', caret: 10, expected: 'X', cursor: 1 },
        { name: 'middle', query: 'alpha beta', caret: 6, expected: 'Xbeta', cursor: 1 },
        { name: 'start', query: 'alpha beta', caret: 0, expected: 'Xalpha beta', cursor: 1 },
        { name: 'empty', query: '', caret: 0, expected: 'X', cursor: 1 },
        { name: 'Unicode prefix', query: '前😀后', caret: 3, expected: 'X后', cursor: 1 },
        { name: 'combining suffix', query: '删e\u0301👩‍💻', caret: 1, expected: 'Xe\u0301👩‍💻', cursor: 1 },
        { name: 'current line only', query: 'KEEP\nalpha beta', caret: 11, expected: 'KEEP\nXbeta', cursor: 6 },
        { name: 'multiline start', query: 'KEEP\nalpha beta', caret: 5, expected: 'KEEP\nXalpha beta', cursor: 6 },
        { name: 'image on preceding line', query: '[Image #1]\nalpha beta', caret: 17, expected: '[Image #1]\nXbeta', cursor: 12 },
        // An initial caret inside the bound token snaps to its end. Deleting
        // the prefix must remove the whole token, never leave a broken label.
        { name: 'atomic bound image', query: 'KEEP\n[Image #1] tail', caret: 13, expected: 'KEEP\nX tail', cursor: 6 },
      ]) {
        await s.reset(test.query, test.caret)
        s.input.write(sequence + 'X')
        check(`${prefix} ${test.name}: same-batch text follows the edited caret`,
          await settled(() => s.draft.query === test.expected && s.draft.caret === test.cursor))
        check(`${prefix} ${test.name}: no submit or exit`,
          s.events.every(event => event.type === 'query'))
        if (test.name === 'end') {
          check(`${prefix}: deletion is observable before same-batch insertion`,
            s.events.some(event => event.type === 'query' && event.query === '' && event.caret === 0))
        }
      }
      await s.reset('alpha beta')
      s.input.write('\t')
      check(`${prefix}: Tab focuses the model parameter`, await settled(() => s.draft.focus === -2))
      s.events.length = 0
      s.input.write(sequence + '\r')
      check(`${prefix}: parameter focus retains draft and activates its own Enter`,
        await settled(() => s.events.some(event => event.type === 'param' && event.value === 'model'))
          && s.draft.query === 'alpha beta' && s.events.every(event => event.type === 'param'))

      await s.reset('alpha beta', 10, -1, true)
      s.input.write(sequence + 'X')
      // 固定窗:探针 Paused input must produce no callback; its absence needs an observation window.
      await sleep(100)
      check(`${prefix}: paused input keeps text, caret and callbacks unchanged`,
        s.draft.query === 'alpha beta' && s.draft.caret === 10 && s.events.length === 0)
    }
  } finally { await s.close() }
}
console.log(`\nverify-launchpad-ctrl-u-port OK (${checks} checks)`)

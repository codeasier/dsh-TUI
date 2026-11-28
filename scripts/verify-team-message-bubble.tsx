/**
 * Agent Teams peer-message bubble (src/components/messages/TeamMessageBubble.tsx,
 * issue #1241): a `✉ <sender> · team message` line, then the body with a
 * hanging indent that holds under wrapping — at a normal and a narrow
 * terminal width, with a wide-character sender and body, and inside a column
 * narrower than the terminal (a child scene's padded page beside a rail).
 * In the main list a team row is never a turn: the timeline rail and the
 * pinned header (Chat reads `pinnedId`) only take the human's prompts.
 *
 * Run: node --import tsx/esm scripts/verify-team-message-bubble.tsx
 */
import type { ChatRow } from '../src/dsh-adapter/channel.js'
import type { DOMElement } from '../src/ink/dom.js'
import type { ScrollBoxHandle } from '../src/ui.js'
import type { TimelineSnapshot } from '../src/ink/timeline-rail.js'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
const [{ mkdtempSync, rmSync }, { tmpdir }, { join }] = await Promise.all([
  import('node:fs'),
  import('node:os'),
  import('node:path'),
])
const dataDir = mkdtempSync(join(tmpdir(), 'verify-team-bubble-data-'))
process.env.HOME = dataDir
process.env.USERPROFILE = dataDir

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, termTest, bubble, width] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('./lib/term-test.mjs'),
  import('../src/components/messages/TeamMessageBubble.js'),
  import('../src/ink/stringWidth.js'),
])
const { MessageList } = await import('../src/components/MessageList.js')
const { settled, viewportLines } = termTest
const { render } = ui

let failed = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}

/** A child scene's page: padded on both sides beside a fixed-width rail. */
const Hosted = ({ children }: { children: React.ReactNode }) => (
  <ui.Box flexDirection="row" paddingX={3}>
    <ui.Box flexGrow={1} flexShrink={1} paddingX={1}>{children}</ui.Box>
    <ui.Box width={10} flexShrink={0}><ui.Text>{'|rail'}</ui.Text></ui.Box>
  </ui.Box>
)

async function frame(cols: number, sender: string, text: string, hosted = false, content?: React.ReactNode, inspect?: (term: InstanceType<typeof XTerm>) => Promise<void>): Promise<string[]> {
  const rows = 12
  const term = new XTerm({ cols, rows, scrollback: 50, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  class Sink extends Writable {
    isTTY = true
    _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const node = <bubble.TeamMessageBubble sender={sender} text={text} marginTopOnTurn={false} />
  const instance = await render(
    content ?? (hosted ? <Hosted>{node}</Hosted> : node),
    { stdout: new FakeStdout(), stdin: new FakeStdin(), stderr: new Sink(), exitOnCtrlC: false, patchConsole: false },
  )
  await settled(() => viewportLines(term, rows).some((line: string) => line.includes('✉')))
  await inspect?.(term)
  const lines = viewportLines(term, rows).map((line: string) => line.trimEnd()).filter((line: string) => line !== '')
  instance.unmount()
  return lines
}

try {
  const wide = await frame(80, 'reviewer', 'diff ok\nsecond line of the report')
  check('sender line carries mark, name and tag', wide[0] === '✉ reviewer · team message', JSON.stringify(wide[0]))
  check('body lines hang under the sender', wide[1] === '  diff ok' && wide[2] === '  second line of the report', JSON.stringify(wide.slice(1)))

  const narrow = await frame(24, '审阅者', '这是一条需要在窄终端里换行的团队消息内容')
  check('narrow: the sender line stays one row', narrow[0]?.startsWith('✉ 审阅者') === true, JSON.stringify(narrow[0]))
  const body = narrow.slice(1)
  check('narrow: the wrapped body keeps its indent', body.length > 1 && body.every(line => line.startsWith('  ') && !line.startsWith('   ')), JSON.stringify(body))
  check('narrow: no row overflows the terminal', narrow.every(line => width.stringWidth(line) <= 24), JSON.stringify(narrow))
  check('narrow: every body character is shown', body.map(line => line.trim()).join('') === '这是一条需要在窄终端里换行的团队消息内容', JSON.stringify(body))

  // A child scene hosts the bubble in a column narrower than the terminal:
  // the body wraps to that column, losing no character to truncation.
  const longBody = 'the quick brown fox jumps over the lazy dog and keeps running far past the column edge'
  const hosted = await frame(60, 'lead', longBody)
  const inPage = await frame(60, 'lead', longBody, true)
  check('hosted: the body is not clipped by the page padding or the rail',
    inPage.slice(1).map(line => line.replace(/\|rail$/, '').trim()).join(' ') === longBody, JSON.stringify(inPage))
  check('hosted: no body row reaches into the rail column', inPage.slice(1).every(line => !line.replace(/\|rail$/, '').includes('…')), JSON.stringify(inPage))
  check('hosted: same text as the full-width bubble', hosted.slice(1).map(line => line.trim()).join(' ') === longBody, JSON.stringify(hosted))

  // The main list: a peer message renders its bubble but opens no turn.
  type Timeline = { turns: readonly { id: number }[]; pinnedId: number | null }
  let timeline: Timeline | null = null
  const chatRows = [
    { id: 0, kind: 'user', text: 'human prompt' },
    { id: 1, kind: 'assistant', text: 'spawning teammates' },
    { id: 2, kind: 'user', label: 'team-message', sender: 'reviewer', text: 'reviewer report' },
    { id: 3, kind: 'assistant', text: 'noted' },
  ] as never[]
  const list = await frame(60, 'reviewer', '', false,
    <MessageList rows={chatRows} expanded={false} expandedRows={new Set()} selectedId={null} onToggleRow={() => {}}
      model="test" showAll onToggleAll={() => {}} historyPaintEnabled={false} scrollHandle={null}
      registerRowRef={() => {}} onTimeline={(next: Timeline) => { timeline = next }} />)
  check('list: the peer row renders as its bubble', list.some(line => line.startsWith('✉ reviewer')), JSON.stringify(list))
  const turns = (timeline as Timeline | null)?.turns.map(turn => turn.id)
  check('list: only the human prompt is a turn (rail, pinned header)', JSON.stringify(turns) === '[0]', JSON.stringify(turns))


  // Port seam: padded human prompts own their TEXT row on the rail. Peer
  // messages own neither a turn nor the pinned human header, even when a real
  // ScrollBox parks on them and reanchors after an earlier body shrinks.
  for (const columns of [60, 24]) {
    const scrollRows: ChatRow[] = [
      { id: 10, kind: 'user', text: 'HUMAN-ONE' },
      { id: 11, kind: 'assistant', text: Array.from({ length: 10 }, (_, i) => `earlier body ${i}`).join('\n') },
      { id: 12, kind: 'user', label: 'team-message', sender: 'reviewer', text: 'PEER-ANCHOR\npeer second line' },
      { id: 13, kind: 'assistant', text: Array.from({ length: 6 }, (_, i) => `later body ${i}`).join('\n') },
      { id: 14, kind: 'user', text: 'HUMAN-TWO' },
      { id: 15, kind: 'assistant', text: Array.from({ length: 12 }, (_, i) => `tail body ${i}`).join('\n') },
      { id: 16, kind: 'user', label: 'team-message', sender: 'tail', text: 'tail report' },
    ]
    let scroll: ScrollBoxHandle | null = null
    let current: TimelineSnapshot | null = null
    let refresh: (() => void) | null = null
    const refs = new Map<number, DOMElement>()
    const register = (id: number, node: DOMElement | null): void => {
      if (node) refs.set(id, node)
      else refs.delete(id)
    }
    const snapshot = (): TimelineSnapshot | null => current
    function ScrollingList(): React.ReactNode {
      const [handle, setHandle] = React.useState<ScrollBoxHandle | null>(null)
      const [, update] = React.useState(0)
      scroll = handle
      refresh = () => update(value => value + 1)
      return (
        <ui.AlternateScreen>
          <ui.Box height={12} flexDirection="column">
            <ui.ScrollBox ref={setHandle} flexGrow={1} flexShrink={1} flexDirection="column" stickyScroll>
              <MessageList rows={scrollRows} expanded={false} expandedRows={new Set()} selectedId={null}
                onToggleRow={() => {}} model="test" showAll onToggleAll={() => {}}
                historyPaintEnabled={false} scrollHandle={handle} registerRowRef={register}
                onTimeline={next => { current = next }} />
            </ui.ScrollBox>
          </ui.Box>
        </ui.AlternateScreen>
      )
    }
    await frame(columns, '', '', false, <ScrollingList />, async term => {
      const handle = scroll as ScrollBoxHandle | null
      if (!handle) throw new Error('Missing ScrollBox handle')
      handle.scrollTo(0)
      await settled(() => handle.getScrollTop() === 0 && viewportLines(term).some(line => line.includes('HUMAN-ONE')))
      await settled(() => snapshot()?.turns[0]?.top === 1)
      const first = snapshot()?.turns.find(turn => turn.id === 10)
      check(`scroll ${columns}: human rail targets the padded prompt's text row`, first?.top === 1, JSON.stringify(first))
      check(`scroll ${columns}: team rows never enter timeline`, JSON.stringify(snapshot()?.turns.map(turn => turn.id)) === '[10,14]')
      handle.scrollTo(first!.top)
      await settled(() => handle.getScrollTop() === first!.top && viewportLines(term)[0]?.includes('HUMAN-ONE') === true)
      check(`scroll ${columns}: visible human text is not pinned early`, snapshot()?.pinnedId === null)
      handle.scrollTo(first!.top + 1)
      await settled(() => snapshot()?.pinnedId === 10)
      check(`scroll ${columns}: human header pins only after text leaves`, snapshot()?.pinnedId === 10)
      const peerTop = refs.get(12)?.yogaNode?.getComputedTop()
      if (peerTop === undefined) throw new Error('Peer row is not mounted')
      handle.scrollTo(peerTop + 1)
      await settled(() => viewportLines(term)[0]?.includes('✉ reviewer') === true && handle.getPendingDelta() === 0)
      check(`scroll ${columns}: a peer at viewport top keeps the human pinned`, snapshot()?.activeId === 10 && snapshot()?.pinnedId === 10)
      const before = handle.getScrollTop()
      scrollRows[1]!.text = 'earlier body 0\nearlier body 1\nearlier body 2\nearlier body 3'
      const rerender = refresh as (() => void) | null
      if (rerender === null) throw new Error('Missing list refresh')
      rerender()
      await settled(() => handle.getScrollTop() === before - 6 && viewportLines(term)[0]?.includes('✉ reviewer') === true)
      check(`scroll ${columns}: upstream shrink anchoring keeps peer text at its row`, handle.getScrollTop() === before - 6 && viewportLines(term)[0]?.includes('✉ reviewer') === true)
      check(`scroll ${columns}: shrink does not promote peer to pinned header`, snapshot()?.activeId === 10 && snapshot()?.pinnedId === 10 && !handle.isSticky())
    })
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
if (failed > 0) {
  console.log(`${failed} FAILED`)
  process.exit(1)
}
console.log('ALL PASS')
process.exit(0)

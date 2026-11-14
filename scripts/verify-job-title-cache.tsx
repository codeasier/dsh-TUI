/**
 * Focused upgrade regression: grouped job payloads refresh without status changes,
 * rendered description||label titles invalidate offscreen heights (including
 * equal-JS-length CJK replacements), narrow rails keep THREE visual tail rows,
 * oversized titles are bounded, and elapsed-time ticks preserve cached heights.
 * Run: node --import tsx/esm scripts/verify-job-title-cache.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

const [{ mkdtempSync }, { tmpdir }, { join }] = await Promise.all([
  import('node:fs'), import('node:os'), import('node:path'),
])
const home = mkdtempSync(join(tmpdir(), 'dshtui-job-title-cache-'))
process.env.HOME = home
process.env.USERPROFILE = home

const [React, { Writable, PassThrough }, { Terminal }, ui, { MessageList }, { JobCard }, { settled }, { default: wrapText }] = await Promise.all([
  import('react'),
  import('node:stream'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/MessageList.js'),
  import('../src/components/Chat/JobCard.js'),
  import('./lib/term-test.mjs'),
  import('../src/ink/wrap-text.js'),
])
import type { ChatRow, JobRow } from '../src/dsh-adapter/channel.js'
import type { DOMElement, DOMNode } from '../src/ink/dom.js'
import type { ScrollBoxHandle } from '../src/ui.js'

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra === '' ? '' : ` (${extra})`}`)
  if (!ok) failed++
}

class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
class Output extends Writable {
  isTTY = true
  columns: number
  rows = 36
  constructor(private term: InstanceType<typeof Terminal>, columns: number) {
    super()
    this.columns = columns
  }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.term.write(String(chunk), callback)
  }
}

async function withTerminal(columns: number, make: () => React.ReactNode, run: (
  lines: () => string[], rerender: (node: React.ReactNode) => void,
) => Promise<void>, now?: () => number): Promise<void> {
  const term = new Terminal({ cols: columns, rows: 36, scrollback: 0, allowProposedApi: true })
  // Ink's explicit root render is synchronous. Freeze time only around that
  // operation, so settled() still has real deadlines and cannot wait forever.
  // Clock-controlled fixtures also disable the automatic animation provider.
  const atTime = <T,>(fn: () => T): T => {
    const realNow = Date.now
    if (now !== undefined) Date.now = now
    try { return fn() } finally { Date.now = realNow }
  }
  const options = {
    stdout: new Output(term, columns) as unknown as NodeJS.WriteStream,
    stdin: new Input() as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  }
  const app = now === undefined
    ? await ui.render(make(), options)
    : atTime(() => ui.renderSync(make(), options))
  const lines = (): string[] => Array.from({ length: 36 }, (_, y) =>
    term.buffer.active.getLine(y)?.translateToString(true) ?? '')
  try {
    await run(lines, node => atTime(() => app.rerender(node)))
  } finally {
    await app.unmount()
    term.dispose()
  }
}

const startedAt = Date.now() - 1000
const job = (id: string, description: string, extra: Partial<JobRow> = {}): JobRow => ({
  id, kind: 'bash', label: 'registry-only-label', description, status: 'running',
  startedAt, outputLines: [], ...extra,
})
function list(rows: readonly ChatRow[], extra: Partial<React.ComponentProps<typeof MessageList>> = {}): React.ReactNode {
  return React.createElement(MessageList, {
    rows, expanded: false, expandedRows: new Set<number>(), selectedId: null,
    onToggleRow() {}, model: 'model', showAll: true, onToggleAll() {},
    historyPaintEnabled: false, jobGroupFold: 'never', ...extra,
  })
}

// The projection replaces row.job while keeping the rows array and row object.
// Group decoration must not freeze the old payload until the next status change.
{
  const rows: ChatRow[] = [
    { id: 1, kind: 'job', text: 'unchanged', job: job('job-a', 'Before title') },
    { id: 2, kind: 'job', text: 'unchanged', job: job('job-b', 'Second title') },
  ]
  await withTerminal(90, () => list(rows), async (lines, rerender) => {
    check('group initially displays description rather than registry label', await settled(() =>
      lines().some(line => line.includes('job: Before title')) && !lines().join('\n').includes('registry-only-label')))
    rows[0]!.job = job('job-a', 'Updated title', {
      progress: '2/5', outputLines: [{ text: 'latest-output', channel: 'stderr' }],
    })
    rerender(list(rows))
    check('same-status grouped replacement refreshes title/progress/output', await settled(() => {
      const text = lines().join('\n')
      return text.includes('job: Updated title') && text.includes('2/5') && text.includes('latest-output')
        && !text.includes('Before title')
    }), lines().join('|'))
    const body = lines().filter(line => /^[╭│╰] /.test(line))
    check('refreshed waterfall stays inside group bracket', body.length === 3 && body[0]!.startsWith('╭ ')
      && body[1]!.includes('latest-output') && body[2]!.startsWith('╰ '), body.join('|'))
  })
}

// Measure, unmount, then replace ONLY the description with equal JS length but
// twice the terminal width. A stale label.length signature never remounts it.
{
  const ascii = 'a'.repeat(22)
  const wide = '界'.repeat(22)
  const rows: ChatRow[] = [
    { id: 1, kind: 'job', text: 'unchanged', job: job('job-a', ascii) },
    { id: 2, kind: 'job', text: 'unchanged', job: job('job-b', 'second') },
    ...Array.from({ length: 45 }, (_, index): ChatRow => ({
      id: index + 3, kind: 'assistant', text: `tail note ${index}`, streaming: false,
    })),
  ]
  const refs = new Map<number, DOMElement>()
  let mounts = 0
  const registerRowRef = (id: number, element: DOMElement | null): void => {
    if (element === null) refs.delete(id)
    else {
      refs.set(id, element)
      if (id === 1) mounts++
    }
  }
  const scrollHandle: ScrollBoxHandle = {
    scrollTo() {}, scrollBy() {}, scrollToElement() {}, scrollToBottom() {},
    getScrollTop: () => 490, getPendingDelta: () => 0, getScrollHeight: () => 500,
    getFreshScrollHeight: () => 500, getViewportHeight: () => 10, getViewportTop: () => 0,
    isSticky: () => true, subscribe: () => () => {}, setClampBounds() {},
  }
  const view = (forceMountRowId?: number): React.ReactNode => React.createElement(ui.ScrollBox,
    { height: 10, stickyScroll: true, flexDirection: 'column' },
    list(rows, { scrollHandle, registerRowRef, forceMountRowId }))
  await withTerminal(56, () => view(1), async (_lines, rerender) => {
    check('initial job title is measured', await settled(() => (refs.get(1)?.yogaNode?.getComputedHeight() ?? 0) >= 2))
    const oldHeight = refs.get(1)?.yogaNode?.getComputedHeight() ?? 0
    rerender(view())
    check('measured job moves offscreen and unmounts', await settled(() => !refs.has(1)))
    const before = mounts
    rows[0]!.job = job('job-a', wide)
    rerender(view())
    check('same-JS-length description change remounts cached offscreen job', await settled(() => mounts > before),
      `mounts ${before}→${mounts}`)
    rerender(view(1))
    check('CJK displayed title grows measured height despite unchanged label/text lengths', await settled(() =>
      (refs.get(1)?.yogaNode?.getComputedHeight() ?? 0) > oldHeight), `old=${oldHeight}`)
    check('height signature scenario keeps identical description JS length', ascii.length === wide.length)
  })
}

// Both detail cell width and localized header widths affect measured height.
// Replace one input only after the card is measured and unmounted: the new
// detail must gain a tail row, and the longer English status must wrap the title.
{
  const { getLang, setLang } = await import('../src/i18n.js')
  const previousLang = getLang()
  try {
    for (const input of ['detail', 'locale'] as const) {
      const ascii = 'aaaa'
      const wide = '界界界界'
      setLang(input === 'detail' ? 'en' : 'zh')
      const originalJob = input === 'detail'
        ? job('job-a', 'a', { detail: ascii, startedAt: Date.now() - 1000 })
        : job('job-a', 'aaaaaaaa', { status: 'completed', finishedAt: startedAt + 1000 })
      const rows: ChatRow[] = [
        { id: 1, kind: 'job', text: 'unchanged', job: originalJob },
        ...Array.from({ length: 45 }, (_, index): ChatRow => ({
          id: index + 2, kind: 'assistant', text: `cached tail note ${index}`, streaming: false,
        })),
      ]
      const refs = new Map<number, DOMElement>()
      let mounts = 0
      const registerRowRef = (id: number, element: DOMElement | null): void => {
        if (element === null) refs.delete(id)
        else {
          refs.set(id, element)
          if (id === 1) mounts++
        }
      }
      const scrollHandle: ScrollBoxHandle = {
        scrollTo() {}, scrollBy() {}, scrollToElement() {}, scrollToBottom() {},
        getScrollTop: () => 490, getPendingDelta: () => 0, getScrollHeight: () => 500,
        getFreshScrollHeight: () => 500, getViewportHeight: () => 10, getViewportTop: () => 0,
        isSticky: () => true, subscribe: () => () => {}, setClampBounds() {},
      }
      const view = (forceMountRowId?: number): React.ReactNode => React.createElement(ui.ScrollBox,
        { height: 10, stickyScroll: true, flexDirection: 'column' },
        list(rows, { scrollHandle, registerRowRef, forceMountRowId }))
      // The fixed elapsed column reserves five more cells than the old "1s".
      // Keep this fixture at the same detail/locale folding boundary.
      await withTerminal(45, () => view(1), async (_lines, rerender) => {
        check(`${input}: initial job header occupies one measured row at 45 columns`, await settled(() =>
          refs.get(1)?.yogaNode?.getComputedHeight() === 1))
        const oldHeight = refs.get(1)?.yogaNode?.getComputedHeight() ?? 0
        rerender(view())
        check(`${input}: measured job moves offscreen and unmounts`, await settled(() => !refs.has(1)))
        const before = mounts
        if (input === 'detail') rows[0]!.job = { ...originalJob, detail: wide }
        else setLang('en')
        rerender(view())
        check(`${input}: changed layout input remounts cached offscreen job`, await settled(() => mounts > before),
          `mounts ${before}→${mounts}`)
        rerender(view(1))
        check(`${input}: changed layout input adds exactly one measured row`, await settled(() =>
          refs.get(1)?.yogaNode?.getComputedHeight() === oldHeight + 1), `old=${oldHeight}`)
        check(`${input}: unrelated job payload inputs remain unchanged`, input === 'detail'
          ? ascii.length === wide.length && rows[0]!.job!.description === originalJob.description
          : rows[0]!.job === originalJob)
      })
    }
  } finally {
    setLang(previousLang)
  }
}

// Optional chips on narrow cards must not over-constrain the fixed metadata
// grid. Output is wrapped FIRST, then the last THREE visual lines are retained.
{
  const output = 'discarded-prefix ' + 'segment '.repeat(22) + 'OUTPUT-TAIL'
  const expected = wrapText(output, 33, 'wrap').split('\n').slice(-3).map(line => line.trimEnd())
  const narrowJob = job('job-a', 'Narrow title tail', {
    progress: '2/5', outputLines: [{ text: output, channel: 'stderr', gapBefore: true }],
  })
  await withTerminal(40, () => React.createElement(JobCard, {
    job: narrowJob, marginTopOnTurn: false, rail: { open: true, close: true },
  }), async (lines, rerender) => {
    check('narrow card keeps metadata and progress visible', await settled(() => {
      const text = lines().join('\n')
      return text.includes('job-a bash') && text.includes('running') && text.includes('2/5') && text.includes('OUTPUT-TAIL')
    }), lines().join('|'))
    const body = lines().filter(line => line.trim() !== '')
    const waterfall = body.filter(line => line.includes('  │ '))
    check('waterfall keeps exactly the last THREE visual rows', waterfall.length === 3
      && waterfall.every((line, index) => line.endsWith(expected[index]!)), waterfall.join('|'))
    check('narrow rail covers every rendered row through its tail', body[0]!.startsWith('╭ ')
      && body.slice(1, -1).every(line => line.startsWith('│ ')) && body.at(-1)!.startsWith('╰ '), body.join('|'))
    rerender(React.createElement(JobCard, {
      job: { ...narrowJob, status: 'completed', detail: 'exit code: 0', finishedAt: startedAt + 1000 },
      marginTopOnTurn: false, rail: { open: true, close: true },
    }))
    check('narrow settled card retains exit detail but folds output/progress', await settled(() => {
      const text = lines().join('\n')
      return text.includes('completed') && text.includes('exit code: 0')
        && !text.includes('OUTPUT-TAIL') && !text.includes('2/5')
    }), lines().join('|'))
  })
}

// Render the actual card at a one-cell title budget as well as normal widths.
// Count its Text nodes rather than relying on a cropped terminal viewport.
{
  const [{ renderToScreen }, { TerminalSizeContext }, { stringWidth }] = await Promise.all([
    import('../src/ink/render-to-screen.js'), import('../src/ink/components/TerminalSizeContext.js'),
    import('../src/ink/stringWidth.js'),
  ])
  const leaves = (node: DOMNode): string[] => node.nodeName === '#text'
    ? [node.nodeValue] : node.childNodes.flatMap(leaves)
  const textNodes = (node: DOMNode): number => node.nodeName === '#text' ? 0
    : Number(node.nodeName === 'ink-text') + node.childNodes.reduce((sum, child) => sum + textNodes(child), 0)
  for (const source of ['description', 'label'] as const) {
    for (const token of ['a', '界', 'e\u0301', '👩‍💻', '\n']) {
      const title = token.repeat(10_000) + 'SOURCE-END'
      const original = job('job-a', source === 'description' ? title : '', {
        label: source === 'label' ? title : 'registry', status: 'completed', finishedAt: startedAt + 1000,
      })
      for (const columns of [32, 56, 100]) {
        let rendered: string[] = []
        let count = 0
        function Capture(): React.ReactNode {
          const ref = React.useRef<DOMElement | null>(null)
          React.useLayoutEffect(() => {
            if (ref.current !== null) {
              rendered = leaves(ref.current)
              count = textNodes(ref.current)
            }
          }, [])
          return <ui.Box ref={ref}><JobCard job={original} marginTopOnTurn={false} /></ui.Box>
        }
        const { height } = renderToScreen(
          <ui.ThemeProvider theme="dark">
            <TerminalSizeContext.Provider value={{ columns, rows: 36 }}><Capture /></TerminalSizeContext.Provider>
          </ui.ThemeProvider>, columns,
        )
        const tag = `bounded ${source}/${JSON.stringify(token)}/${columns}`
        check(`${tag}: a title cannot create an unbounded Text subtree`, count > 0 && count <= 490 && height <= 960,
          `texts=${count} height=${height}`)
        // The header title is the only content beginning with this prefix.
        // Metadata follows in separate leaves; sum its title leaves only.
        const titleStart = rendered.findIndex(text => text.startsWith('job:') || text === 'j')
        const titleEnd = rendered.indexOf('job-a', titleStart)
        const preview = rendered.slice(titleStart, titleEnd).join('')
        check(`${tag}: display preview respects the cell budget`, titleStart >= 0 && titleEnd > titleStart
          && stringWidth(preview) <= 480, JSON.stringify(preview.slice(-30)))
        check(`${tag}: source data is not clipped`, original[source] === title)
        if (token !== '\n') check(`${tag}: clipping is visible and source tail is hidden`,
          preview.endsWith('…') && !preview.includes('SOURCE-END'))
        else check(`${tag}: line breaks cannot bypass the budget`, height <= 30 && preview.includes('SOURCE-END'))
        if (token === 'e\u0301' || token === '👩‍💻') check(`${tag}: clipping preserves whole graphemes`,
          preview.slice('job: '.length, -1).normalize().split(token.normalize()).join('') === '')
      }
    }
  }

  const { JobsPanel } = await import('../src/components/JobsPanel.js')
  const fullTitle = 'a'.repeat(500) + 'DETAIL-SOURCE-END'
  const panelJob = job('job-a', fullTitle, { command: 'true', status: 'completed', finishedAt: startedAt + 1000 })
  await withTerminal(100, () => <JobsPanel jobs={[panelJob]} onClose={() => {}} onKill={() => {}} />, async lines => {
    check('focused jobs detail retains text beyond the transcript cap', await settled(() =>
      lines().some(line => line.includes('DETAIL-SOURCE-END'))))
  })
}

// Measure a live card, let MessageList replace it with a spacer, advance ONLY
// the clock across a duration-width boundary, then remount the same payload.
// The fixed duration column makes that cached height valid without a tick in
// every offscreen row's signature. The window handle is controlled; Yoga and
// the ScrollBox's content height are real, not calculated by this fixture.
{
  const { ClockContext } = await import('../src/ink/components/ClockContext.js')
  const textOf = (node: DOMNode): string => node.nodeName === '#text'
    ? node.nodeValue : node.childNodes.map(textOf).join(' ')
  for (const [before, after, titleLength, oldDuration, newDuration] of [
    [9000, 10_000, 24, '9s', '10s'],
    [59_000, 60_000, 23, '59s', '1m0s'],
    [35_999_000, 36_000_000, 21, '9h59m', '10h00m'],
    [3_599_999_000, 3_600_000_000, 19, '999h59m', '1000h00m'],
  ] as const) {
    let now: number = before
    const original = job('job-a', 'a'.repeat(titleLength), { startedAt: 0 })
    const rows: ChatRow[] = [
      { id: 1, kind: 'job', text: 'unchanged', job: original },
      ...Array.from({ length: 45 }, (_, index): ChatRow => ({
        id: index + 2, kind: 'assistant', text: `clock tail ${index}`, streaming: false,
      })),
    ]
    const refs = new Map<number, DOMElement>()
    let mounts = 0
    let actualScroll: ScrollBoxHandle | null = null
    const registerRowRef = (id: number, element: DOMElement | null): void => {
      if (element === null) refs.delete(id)
      else { refs.set(id, element); if (id === 1) mounts++ }
    }
    const windowHandle: ScrollBoxHandle = {
      scrollTo() {}, scrollBy() {}, scrollToElement() {}, scrollToBottom() {},
      getScrollTop: () => 490, getPendingDelta: () => 0, getScrollHeight: () => 500,
      getFreshScrollHeight: () => 500, getViewportHeight: () => 10, getViewportTop: () => 0,
      isSticky: () => true, subscribe: () => () => {}, setClampBounds() {},
    }
    const setScroll = (handle: ScrollBoxHandle | null): void => { actualScroll = handle }
    const view = (forceMountRowId?: number): React.ReactNode => <ClockContext.Provider value={null}>
      <ui.ScrollBox ref={setScroll} height={10} stickyScroll flexDirection="column">
        {list(rows, { scrollHandle: windowHandle, registerRowRef, forceMountRowId })}
      </ui.ScrollBox>
    </ClockContext.Provider>
    await withTerminal(56, () => view(1), async (_lines, rerender) => {
      const height = (): number => refs.get(1)?.yogaNode?.getComputedHeight() ?? 0
      check(`${oldDuration}→${newDuration}: original card is measured at the controlled time`, await settled(() =>
        height() > 0 && textOf(refs.get(1)!).includes(oldDuration)))
      const measured = height()
      rerender(view())
      check(`${oldDuration}→${newDuration}: measured row becomes an offscreen spacer`, await settled(() => !refs.has(1)))
      const beforeMounts = mounts
      const spacerHeight = actualScroll?.getFreshScrollHeight()
      now = after
      rerender(view())
      check(`${oldDuration}→${newDuration}: ticking does not change the job or remount the spacer`,
        rows[0]!.job === original && !refs.has(1) && mounts === beforeMounts)
      rerender(view(1))
      check(`${oldDuration}→${newDuration}: remounted card has the same measured height`, await settled(() =>
        mounts > beforeMounts && height() === measured), `old=${measured} new=${height()}`)
      // Raw Text props hold the full duration; the fixed-width Text renderer
      // clips overflow. Check source time separately from painted geometry.
      check(`${oldDuration}→${newDuration}: elapsed source actually advances`,
        refs.has(1) && textOf(refs.get(1)!).split(' ').includes(newDuration)
          && !textOf(refs.get(1)!).split(' ').includes(oldDuration))
      check(`${oldDuration}→${newDuration}: replacing the spacer preserves content height`, await settled(() =>
        spacerHeight !== undefined && actualScroll?.getFreshScrollHeight() === spacerHeight))
    }, () => now)
  }
}

if (failed > 0) process.exit(1)
console.log('\nALL PASS')

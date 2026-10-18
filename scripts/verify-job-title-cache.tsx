/**
 * Focused upgrade regression: grouped job payloads refresh without status changes,
 * rendered description||label titles invalidate offscreen heights (including
 * equal-JS-length CJK replacements), and narrow rails keep THREE visual tail rows.
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
import type { DOMElement } from '../src/ink/dom.js'
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
) => Promise<void>): Promise<void> {
  const term = new Terminal({ cols: columns, rows: 36, scrollback: 0, allowProposedApi: true })
  const app = await ui.render(make(), {
    stdout: new Output(term, columns) as unknown as NodeJS.WriteStream,
    stdin: new Input() as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const lines = (): string[] => Array.from({ length: 36 }, (_, y) =>
    term.buffer.active.getLine(y)?.translateToString(true) ?? '')
  try {
    await run(lines, node => app.rerender(node))
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

if (failed > 0) process.exit(1)
console.log('\nALL PASS')

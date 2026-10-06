/**
 * Channel-level verification of the post-compaction behaviour (real Channel
 * via createChannel + fake ctx/agent, plain node against the compiled lib):
 *
 * - the compaction checkpoint renders a localized `compact-done` Divider plus
 *   a `compact` summary row (defaults FOLDED in the transcript)
 * - the segmented bar's composition resets immediately (contextSegments), while
 *   OCCUPANCY is left to the official `contextPressure` projection: this
 *   composition mounts no token meter, so the fallback sample must stay
 *   untouched by the checkpoint (the old chars/4 rewrite of lastUsage /
 *   tokens.input is gone on purpose — see dsh-adapter/context-occupancy.ts)
 * - MessageList renders the folded summary as one line and the full text
 *   once expanded (Ctrl+O / message-selection Enter)
 *
 * Run with plain node against the compiled lib: `node scripts/verify-compact.mjs`
 */
import './lib/default-lang-zh.mjs'
import { createChannel } from '../lib/types/dsh-adapter/channel.js'
import { t } from '../lib/types/i18n.js'
import React from 'react'
import { render } from '../lib/types/ui.js'
import { MessageList } from '../lib/types/components/MessageList.js'
import { compactSummaryDisplayText } from '../lib/types/utils/compact-summary.js'
import { stringWidth } from '../lib/types/ink/stringWidth.js'
import { Writable, PassThrough } from 'node:stream'
import { settled, sleep } from './lib/term-test.mjs'
import { CHECKPOINT_PREAMBLE, SUMMARY_OPEN_TAG, SUMMARY_CLOSE_TAG, frameCompactSummary } from './lib/compact-summary-fixture.mjs'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const toPlain = s =>
  s
    .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
    .replace(/\x1b\[[0-9;?>:]*[a-zA-Z]/g, '')
    .replace(/\x1b\]9;[^\x07]*\x07/g, '')

// Independent ASCII-only oracle for the channel's segment estimate: the shared
// `estimateTokens` (src/dsh-adapter/channel/usage.ts) charges pure ASCII at
// exactly this rate, so the ASCII projection fixtures use exact expectations.
// The CJK-aware semantics (and the rates themselves) are pinned
// separately by scripts/verify-cjk-token-estimate.ts.
const est = text => Math.ceil(text.length / 4)

// ---- channel-level: seed a pre-compact context, then compact it
const handlers = new Map()
const ctx = {
  on(event, handler) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  get() {
    return undefined
  },
  logger: { warn() {} },
}
const agent = {
  id: 'a1',
  status: 'idle',
  session: { id: 's1', seq: 0, events: [] },
  // bindAgent 挂 installModelSelection 需要 agent.ctx 提供"可订阅、返回
  // 解除函数"的最小面（0.3.6 Shift+Tab 推理等级）。
  ctx: { on: () => () => {} },
  followup() {},
  steer() {},
}
const channel = createChannel(ctx, agent, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
})
const emit = (event) => {
  const handler = handlers.get('session/event')
  if (handler) handler(agent.session, event)
}

const SYSTEM = 'SYSTEM-PROMPT-ABCDEFGH'
const USER_TEXT = 'user question here'
const ASSISTANT_TEXT = 'assistant answer text'
const SUMMARY = 'Summary of the entire conversation history up to this point.'
const LONG_SUMMARY = '这是一个很长的压缩摘要，用来验证折叠后预览会被截断，不会把全文都显示在一行里。'.repeat(3)
const FRAMED_BODIES = [
  [' \nAlpha checkpoint: keep display raw.', '\nNext: finish tests. \t'],
  [' \nBeta checkpoint: preserve context.', '\nNext: review patch. \t'],
]
const PREFIX = `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}`
const framed = body => `${PREFIX}${body}${SUMMARY_CLOSE_TAG}`

// ---- helper-level: only the exact, complete, unambiguous upstream frame decodes
const preservedBody = ' \t\n## Current Work\n- Preserve 中文 🚀 body bytes.\n\n '
const helperCases = [
  { name: 'plain summary', raw: SUMMARY },
  { name: 'empty raw', raw: '' },
  { name: 'whitespace raw', raw: ' \n\t ' },
  { name: 'tags without preamble', raw: `${SUMMARY_OPEN_TAG}body${SUMMARY_CLOSE_TAG}` },
  { name: 'unknown preamble', raw: `Unknown checkpoint\n\n${SUMMARY_OPEN_TAG}body${SUMMARY_CLOSE_TAG}` },
  { name: 'altered known preamble', raw: framed('body').replace('automatically', 'manually') },
  { name: 'wrong preamble separator', raw: `${CHECKPOINT_PREAMBLE}\n${SUMMARY_OPEN_TAG}body${SUMMARY_CLOSE_TAG}` },
  { name: 'leading bytes before frame', raw: ` ${framed('body')}` },
  { name: 'preamble only', raw: CHECKPOINT_PREAMBLE },
  { name: 'missing opener', raw: `${CHECKPOINT_PREAMBLE}\n\nbody${SUMMARY_CLOSE_TAG}` },
  { name: 'missing closer', raw: `${PREFIX}body` },
  { name: 'partial closer', raw: `${PREFIX}body</compacted-summary` },
  { name: 'wrong tag ordering', raw: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_CLOSE_TAG}body${SUMMARY_OPEN_TAG}` },
  { name: 'excess suffix', raw: `${framed('body')}extra` },
  { name: 'trailing newline after closer', raw: `${framed('body')}\n` },
  { name: 'nested frame', raw: framed(`${SUMMARY_OPEN_TAG}body${SUMMARY_CLOSE_TAG}`) },
  { name: 'interior opener only', raw: framed(`body${SUMMARY_OPEN_TAG}tail`) },
  { name: 'interior closer only', raw: framed(`body${SUMMARY_CLOSE_TAG}tail`) },
  { name: 'duplicate opener', raw: `${PREFIX}${SUMMARY_OPEN_TAG}body${SUMMARY_CLOSE_TAG}` },
  { name: 'duplicate closer', raw: `${framed('body')}${SUMMARY_CLOSE_TAG}` },
  { name: 'duplicate complete frames', raw: `${framed('body')}${framed('other')}` },
  { name: 'empty framed body', raw: framed('') },
  { name: 'whitespace framed body', raw: framed(' \t\r\n　') },
  { name: 'valid body bytes are not trimmed', raw: framed(preservedBody), expected: preservedBody },
]
for (const { name, raw, expected = raw } of helperCases) {
  check(`compactSummaryDisplayText: ${name}`, compactSummaryDisplayText(raw) === expected)
}

emit({ type: 'request/context', seq: 1, data: { contextWindow: 100000 } })
emit({ type: 'request/header', seq: 2, data: { header: { system: SYSTEM } } })
emit({ type: 'user/message', seq: 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: USER_TEXT }] } })
emit({
  type: 'assistant/message',
  seq: 4,
  data: {
    message: { content: [{ type: 'text', text: ASSISTANT_TEXT }] },
    usage: { inputTokens: 5000, outputTokens: 100, cacheReadTokens: 3000, cacheWriteTokens: 0 },
  },
})

check('pre-compact tokens.input accumulated', channel.tokens.input === 5000, String(channel.tokens.input))
check('pre-compact lastUsage set', channel.lastUsage?.input === 5000, JSON.stringify(channel.lastUsage))
const sysEst = est(SYSTEM)
const promptEst = est(USER_TEXT)
const assistantEst = est(ASSISTANT_TEXT)
check(
  'pre-compact segments populated',
  channel.contextSegments.system === sysEst &&
    channel.contextSegments.prompt === promptEst &&
    channel.contextSegments.assistant === assistantEst,
  JSON.stringify(channel.contextSegments),
)

// The compaction checkpoint (dsh-compact's COMPACT_CHECKPOINT_SOURCE).
emit({
  type: 'user/message',
  seq: 5,
  data: {
    source: { kind: 'plugin', plugin: 'compact' },
    content: [{ type: 'text', text: SUMMARY }],
  },
})

const rows = channel.rows
const compactRow = rows[rows.length - 1]
const noticeRow = rows[rows.length - 2]
check('checkpoint renders notice row', noticeRow?.kind === 'notice' && noticeRow?.text === t('compact-done'), JSON.stringify(noticeRow))
check('checkpoint renders compact row with full summary', compactRow?.kind === 'compact' && compactRow?.text === SUMMARY, JSON.stringify(compactRow))

const summaryEst = est(SUMMARY)
check(
  'segments reset to system + summary',
  channel.contextSegments.system === sysEst &&
    channel.contextSegments.prompt === summaryEst &&
    channel.contextSegments.assistant === 0 &&
    channel.contextSegments.thinking === 0 &&
    channel.contextSegments.tools === 0,
  JSON.stringify(channel.contextSegments),
)
check(
  'checkpoint leaves the fallback occupancy sample untouched',
  channel.lastUsage?.input === 5000 &&
    channel.lastUsage?.output === 100 &&
    channel.lastUsage?.cacheRead === 3000 &&
    channel.lastUsage?.cacheWrite === 0,
  JSON.stringify(channel.lastUsage),
)
check(
  'checkpoint does not rewrite the cumulative tokens counter',
  channel.tokens.input === 5000,
  String(channel.tokens.input),
)
check(
  'no-meter occupancy is the billed sample, never the chars/4 segment guess',
  channel.contextOccupancy?.source === 'sample' &&
    channel.contextOccupancy?.usedTokens === 8000 &&
    channel.contextOccupancy?.contextWindow === 100000,
  JSON.stringify(channel.contextOccupancy),
)

// A second compaction with an EMPTY summary: no summary row, prompt cleared.
emit({
  type: 'user/message',
  seq: 6,
  data: { source: { kind: 'plugin', plugin: 'compact' }, content: [] },
})
const rows2 = channel.rows
check('empty summary adds no compact row', rows2[rows2.length - 1]?.kind === 'notice', JSON.stringify(rows2[rows2.length - 1]))
check(
  'empty summary clears the prompt segment',
  channel.contextSegments.prompt === 0 && channel.lastUsage?.input === 5000,
  JSON.stringify(channel.lastUsage),
)

// The segment estimate is CJK-aware (#1170): a Chinese prompt must land in the
// measured 1–1.5 chars/token band instead of the old ASCII chars/4 — the defect
// was Chinese sessions being under-counted ~3x, and the projection wiring above
// is what has to carry the new rate to the bar.
const CJK_PROMPT = '这是一段中文提问，用来验证分段估算按中文口径计费，而不是英文的四字符一枚。'
emit({ type: 'user/message', seq: 7, data: { source: { kind: 'user' }, content: [{ type: 'text', text: CJK_PROMPT }] } })
check(
  'segments charge Chinese text above the old chars/4 rate',
  channel.contextSegments.prompt >= Math.ceil(CJK_PROMPT.length / 1.5) &&
    channel.contextSegments.prompt <= Math.ceil(CJK_PROMPT.length) &&
    channel.contextSegments.prompt > Math.ceil(CJK_PROMPT.length / 4),
  `prompt=${channel.contextSegments.prompt} chars=${CJK_PROMPT.length}`,
)

// Real upstream framing is multi-block: opener+preamble, two body blocks, closer.
// Keep both producer source generations and their raw context/accounting intact.
const framedRows = []
const framedEvents = []
const framedEventBytes = []
for (const [index, source] of [
  { kind: 'plugin', plugin: 'compact' },
  { kind: 'compact-checkpoint' },
].entries()) {
  const bodyBlocks = FRAMED_BODIES[index]
  const content = frameCompactSummary(...bodyBlocks)
  const raw = content.map(block => block.text).join('')
  const event = { type: 'user/message', seq: 8 + index, data: { source, content } }
  const eventBytes = JSON.stringify(event)
  emit(event)
  const row = channel.rows.at(-1)
  const notice = channel.rows.at(-2)
  const label = index === 0 ? 'legacy plugin compact' : 'V4 compact-checkpoint'
  check(`${label}: opener, two body blocks, closer`, content.length === 4 && content[0].text === PREFIX && content[3].text === SUMMARY_CLOSE_TAG)
  check(`${label}: notice and compact row keep complete raw framing`, notice?.kind === 'notice' && row?.kind === 'compact' && row.text === raw)
  check(`${label}: helper keeps both body blocks byte-for-byte`, compactSummaryDisplayText(raw) === bodyBlocks.join(''))
  check(`${label}: raw event content unchanged`, JSON.stringify(event) === eventBytes)
  check(
    `${label}: segments charge framing as well as body`,
    channel.contextSegments.system === sysEst &&
      channel.contextSegments.prompt === est(raw) &&
      channel.contextSegments.prompt > est(bodyBlocks.join('')) &&
      channel.contextSegments.assistant === 0 &&
      channel.contextSegments.thinking === 0 &&
      channel.contextSegments.tools === 0,
    JSON.stringify(channel.contextSegments),
  )
  check(
    `${label}: occupancy and cumulative billing unchanged`,
    channel.tokens.input === 5000 &&
      channel.lastUsage?.input === 5000 &&
      channel.lastUsage?.output === 100 &&
      channel.lastUsage?.cacheRead === 3000 &&
      channel.lastUsage?.cacheWrite === 0 &&
      channel.contextOccupancy?.source === 'sample' &&
      channel.contextOccupancy?.usedTokens === 8000 &&
      channel.contextOccupancy?.contextWindow === 100000,
  )
  framedRows.push(row)
  framedEvents.push(event)
  framedEventBytes.push(eventBytes)
}

// ---- render-level: folded by default, full text when expanded
function makeStreams() {
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdout.frames.push(String(chunk))
      cb()
    },
  })
  stdout.columns = 100
  stdout.rows = 30
  stdout.isTTY = true
  stdout.frames = []
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

const listProps = (expanded, summaryRows = [{ id: 2, kind: 'compact', text: LONG_SUMMARY }], expandedRows = new Set()) => ({
  rows: [
    { id: 1, kind: 'notice', text: t('compact-done') },
    ...summaryRows,
  ],
  expanded,
  expandedRows,
  selectedId: null,
  onToggleRow() {},
  model: 'deepseek-chat',
  showAll: true,
  onToggleAll() {},
  onLoadOlder() {},
})

{
  const { stdout, stderr, stdin } = makeStreams()
  const instance = await render(
    React.createElement(MessageList, listProps(false)),
    { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  const frame = () => toPlain(stdout.frames.at(-1) ?? '')
  // 空帧守卫：渲染崩溃时两条 hides 断言会空洞通过（本文件曾因 MessageList
  // 新增必需 prop 而空帧,只有 shows 报警）。先证明画面存在。
  await settled(() => frame().includes(t('compact-done')) && frame().includes('摘要已折叠'))
  // 固定窗:探针 负向断言观察窗：完整摘要若在正向落定之后迟到出现，落定瞬间检查会漏掉。
  await sleep(200)
  const shot = frame()
  check('compact scenario renders at all', shot.includes(t('compact-done')), '')
  check('folded summary shows the fold line', shot.includes('摘要已折叠'), '')
  check('folded summary hides the full text', !shot.includes(LONG_SUMMARY), '')
  instance.unmount()
}

{
  const { stdout, stderr, stdin } = makeStreams()
  const instance = await render(
    React.createElement(MessageList, listProps(true)),
    { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  // Terminal wrap inserts newlines mid-string, so flatten before matching.
  const frame = () => toPlain(stdout.frames.at(-1) ?? '').replace(/\n/g, '')
  await settled(() => frame().includes('压缩摘要'))
  // 固定窗:探针 负向断言观察窗：折叠行若迟到泄漏，落定瞬间检查会漏掉。
  await sleep(200)
  const shot = frame()
  check('expanded summary shows the full text', shot.includes('压缩摘要'), '')
  check('expanded summary hides the fold line', !shot.includes('摘要已折叠'), '')
  instance.unmount()
}

// Positive body anchors avoid vacuous negative checks; flatten only terminal
// wrapping for matching, retaining the line-oriented shot for preview widths.
async function compactShot(name, summaryRows, expanded, expandedRows, anchors) {
  const { stdout, stderr, stdin } = makeStreams()
  const rawRows = JSON.stringify(summaryRows)
  const instance = await render(
    React.createElement(MessageList, listProps(expanded, summaryRows, expandedRows)),
    { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  const frame = () => toPlain(stdout.frames.at(-1) ?? '')
  try {
    check(`${name}: body anchors render`, await settled(() => {
      const flat = frame().replace(/\n/g, '')
      return flat.includes(t('compact-done')) && anchors.every(anchor => flat.includes(anchor))
    }))
    const shot = frame()
    check(`${name}: rendering does not mutate raw rows`, JSON.stringify(summaryRows) === rawRows)
    return shot
  } finally {
    await instance.unmount()
  }
}

const noFraming = shot => !shot.includes('automatically generated checkpoint') &&
  !shot.includes(SUMMARY_OPEN_TAG) && !shot.includes(SUMMARY_CLOSE_TAG)
const previewOf = line => line.split(' · ')[1]?.split(' （')[0] ?? ''

for (const { name, expanded, expandedRows } of [
  { name: 'framed folded', expanded: false, expandedRows: new Set() },
  { name: 'framed global expand', expanded: true, expandedRows: new Set() },
  { name: 'framed per-row expand', expanded: false, expandedRows: new Set([framedRows[0].id]) },
]) {
  const shot = await compactShot(name, framedRows, expanded, expandedRows, ['Alpha checkpoint:', 'Beta checkpoint:'])
  const flat = shot.replace(/\n/g, '')
  const foldLines = shot.split('\n').filter(line => line.includes(t('compact-summary-folded')))
  check(`${name}: only body is displayed, never preamble or tags`, noFraming(flat))
  if (name === 'framed folded') {
    check('framed folded: different bodies produce distinct previews',
      foldLines.length === 2 &&
      previewOf(foldLines[0]) === 'Alpha checkpoint: keep display raw. Next: finish tests.' &&
      previewOf(foldLines[1]) === 'Beta checkpoint: preserve context. Next: review patch.' &&
      previewOf(foldLines[0]) !== previewOf(foldLines[1]))
  } else {
    check(`${name}: both blocks of the first summary are revealed`,
      flat.includes('Alpha checkpoint: keep display raw.') && flat.includes('Next: finish tests.'))
    check(`${name}: expected expansion scope`, expanded
      ? foldLines.length === 0 && flat.includes('Next: review patch.')
      : foldLines.length === 1 && previewOf(foldLines[0]).startsWith('Beta checkpoint:'))
  }
}
check('framed display preserves both source event contents', framedEvents.every((event, index) => JSON.stringify(event) === framedEventBytes[index]))
check('framed display preserves projected raw row text', framedRows.every((row, index) =>
  row.text === frameCompactSummary(...FRAMED_BODIES[index]).map(block => block.text).join('')))

const oneLineBody = `Long checkpoint body: ${'x'.repeat(1200)} LONG_BODY_END`
const longLineRows = [{ id: 2, kind: 'compact', text: framed(oneLineBody) }]
check('long one-line body exceeds generic folding threshold', oneLineBody.length > 1000 && !oneLineBody.includes('\n'))
check('long one-line helper decodes body bytes before folding', compactSummaryDisplayText(longLineRows[0].text) === oneLineBody)
for (const expanded of [false, true]) {
  const name = `long one-line ${expanded ? 'expanded' : 'folded'}`
  const shot = await compactShot(name, longLineRows, expanded, new Set(), expanded
    ? ['Long checkpoint body:', 'LONG_BODY_END']
    : ['Long checkpoint body:', t('compact-summary-folded')])
  const flat = shot.replace(/\n/g, '')
  check(`${name}: no framing after long-line handling`, noFraming(flat))
  check(`${name}: body tail follows expansion`, expanded ? flat.includes('LONG_BODY_END') : !flat.includes('LONG_BODY_END'))
}

const wideBody = `起点🚀\n${'中😀'.repeat(30)}\n末尾`
const wideRows = [{ id: 2, kind: 'compact', text: framed(wideBody) }]
const wideShot = await compactShot('multiline CJK/emoji folded', wideRows, false, new Set(), ['起点🚀', t('compact-summary-folded')])
const wideFoldLine = wideShot.split('\n').find(line => line.includes(t('compact-summary-folded'))) ?? ''
const widePreview = previewOf(wideFoldLine)
check('multiline CJK/emoji preview flattens body with intact glyphs', widePreview === `起点🚀 ${'中😀'.repeat(13)}…`, widePreview)
check('multiline CJK/emoji preview stays within 60 terminal cells', widePreview !== '' && stringWidth(widePreview) <= 60, String(stringWidth(widePreview)))
check('multiline CJK/emoji folded preview omits framing', noFraming(wideShot))

const malformedRows = [
  { id: 2, kind: 'compact', text: `Unknown checkpoint\n\n${SUMMARY_OPEN_TAG}Fallback body remains visible.${SUMMARY_CLOSE_TAG}` },
  { id: 3, kind: 'compact', text: `${PREFIX}Fallback incomplete body.` },
]
const malformedShot = await compactShot('malformed fallback expanded', malformedRows, true, new Set(), [
  'Unknown checkpoint', 'Fallback body remains visible.', 'Fallback incomplete body.',
])
const malformedFlat = malformedShot.replace(/\n/g, '')
check('unknown preamble fallback retains wrapper tags', malformedFlat.includes(`${SUMMARY_OPEN_TAG}Fallback body remains visible.${SUMMARY_CLOSE_TAG}`))
check('incomplete known frame fallback retains preamble and opener', malformedFlat.includes('automatically generated checkpoint') && malformedFlat.includes(`${SUMMARY_OPEN_TAG}Fallback incomplete body.`))

process.exit(failed)

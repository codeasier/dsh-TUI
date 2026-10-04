/**
 * Synthetic-only OpenCode v1 semantic regression. No private sessions, network,
 * attachment reads, source cleanup or tool execution. Run from the repo root:
 *   node --import tsx/esm scripts/verify-migrate-opencode-parse.mjs
 *
 * Source contract pinned to OpenCode 1.18.34 / aec0b9a6d8898f68f923aaf08b7306d931fd9d76:
 * https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/session/message-v2.ts
 * https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/session/revert.ts
 * https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/session/compaction.ts
 * https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/session/session.ts
 *
 * Tests parse → official Session API → deriveMessages, not just JSON shape.
 * Full persistence/append/reopen is covered by the OpenCode integration suite.
 */
import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { parseOpenCodeExport } from '../src/dsh-adapter/migrate/adapters/opencode.parse.js'
import { sessionize } from '../src/dsh-adapter/migrate/sessionize.js'
import { TOOL_RESULT_MAX_BYTES } from '../src/dsh-adapter/migrate/parse/tools.js'
import { createInitialChannelView } from '../src/dsh-adapter/channel/state.js'
import { createChannelProjection } from '../src/dsh-adapter/channel/projection.js'

const SID = 'ses_synthetic'
const NOW = 1_790_000_000_000
let serial = 0
let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`PASS: ${name}`)
}
const part = (type, fields = {}) => ({ type, ...fields })
const txt = (text, fields = {}) => part('text', { text, ...fields })
const reasoning = text => part('reasoning', { text, time: { start: NOW, end: NOW + 1 } })
function message(role, id, parts, fields = {}) {
  return {
    info: { id, sessionID: SID, role, time: { created: NOW + serial++ }, ...fields },
    parts: parts.map((p, i) => ({ id: `prt_${id}_${i}`, sessionID: SID, messageID: id, ...p })),
  }
}
const user = (id, parts, fields) => message('user', id, typeof parts === 'string' ? [txt(parts)] : parts, { agent: 'build', model: { providerID: 'fixture', modelID: 'source-model' }, ...fields })
const assistant = (id, parentID, parts, fields) => message('assistant', id, typeof parts === 'string' ? [txt(parts)] : parts, { parentID, modelID: 'source-model', providerID: 'fixture', finish: 'stop', ...fields })
const compaction = (id, tail_start_id) => user(id, [part('compaction', { auto: true, ...(tail_start_id ? { tail_start_id } : {}) })])
const summary = (id, parentID, content, fields) => assistant(id, parentID, content, { summary: true, ...fields })
const tool = (callID, status = 'completed', state = {}, extra = {}) => part('tool', {
  callID, tool: 'read', state: { status, input: { path: '/never/read/this' }, output: `${callID} output`, error: `${callID} error`, time: { start: NOW, end: NOW + 1 }, ...state }, ...extra,
})
const fixture = (messages, fields = {}) => ({ info: { id: SID, directory: '/synthetic/project', title: 'Synthetic session', version: '1.18.34', time: { created: NOW, updated: NOW + 10000 }, ...fields }, messages })
const basic = () => fixture([user('u1', 'hello 世界 🎏'), assistant('a1', 'u1', [reasoning('thinking'), txt('answer')])])
function parsed(value) {
  const session = parseOpenCodeExport(value)
  assert.ok(session, 'fixture must produce a session')
  return session
}
function projected(value) {
  const session = parsed(value)
  const id = SessionId('11111111-1111-4111-8111-111111111111')
  const log = sessionize(id, 'opencode', session)
  const model = Session.create(id, log.events, log.header)
  return { session, log, model, messages: model.deriveMessages() }
}
const contents = messages => messages.map(m => m.content.map(b => b.text ?? '').join(''))
function wire(messages) {
  for (let i = 0; i < messages.length; i++) {
    const calls = messages[i].role === 'assistant' ? messages[i].content.filter(b => b.type === 'tool-call') : []
    for (const [j, call] of calls.entries()) {
      assert.equal(messages[i + j + 1]?.role, 'tool')
      assert.equal(messages[i + j + 1]?.toolCallId, call.id)
    }
    if (messages[i].role === 'tool') {
      assert.ok(messages.slice(0, i).some(m => m.role === 'assistant' && m.content.some(b => b.type === 'tool-call' && b.id === messages[i].toolCallId)))
    }
  }
}
function rejects(value, match) {
  assert.throws(() => parseOpenCodeExport(value), match)
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

check('unrelated values and empty exports return undefined', () => {
  for (const value of [null, [], 42, 'export', {}, fixture([])]) assert.equal(parseOpenCodeExport(value), undefined)
})
check('official envelope, explicit title, CJK, reasoning and model survive deriveMessages', () => {
  const { session, messages } = projected(basic())
  assert.equal(session.sourceId, SID)
  assert.equal(session.cwd, '/synthetic/project')
  assert.equal(session.startedAt, NOW)
  assert.equal(session.titleExplicit, true)
  assert.equal(session.title, 'Synthetic session')
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant'])
  assert.equal(messages[0].content[0].text, 'hello 世界 🎏')
  assert.deepEqual(messages[1].content.map(b => b.type), ['reasoning', 'text'])
  assert.equal(session.turns[0].steps[0].model, 'source-model')
})
check('input remains unchanged and deeply frozen input is supported', () => {
  const value = basic()
  const before = JSON.stringify(value)
  parsed(freeze(value))
  assert.equal(JSON.stringify(value), before)
})
check('session parentID excludes children; assistant parentID does not', () => {
  assert.equal(parseOpenCodeExport({ ...basic(), info: { ...basic().info, parentID: 'ses_parent' } }), undefined)
  assert.equal(parsed(basic()).turns.length, 1)
})
check('independent copied forks import without parent expansion', () => {
  const value = basic()
  value.info.title = 'Original (fork #1)'
  const fork = parsed(value)
  assert.equal(fork.title, 'Original (fork #1)')
  assert.equal(fork.turns[0].prompt, 'hello 世界 🎏')
})
check('assistant linkage must target an earlier user, not session or assistant IDs', () => {
  for (const parentID of [SID, 'missing', 'a1']) {
    const value = basic()
    value.messages[1].info.parentID = parentID
    rejects(value, /parentID must reference an earlier user/)
  }
  rejects(fixture([user('u1', 'one'), user('u2', 'two'), assistant('a1', 'u1', 'wrong turn')]), /crosses user turns/)
})
check('step-start and step-finish preserve multiple model-call boundaries', () => {
  const { session, messages, log } = projected(fixture([
    user('u1', 'inspect'),
    assistant('a1', 'u1', [part('step-start'), reasoning('first'), tool('c1'), tool('c2'), part('step-finish'), part('step-start'), txt('done'), part('step-finish')]),
    assistant('a2', 'u1', 'one more call'),
  ]))
  assert.equal(session.turns.length, 1)
  assert.equal(session.turns[0].steps.length, 3)
  assert.equal(log.events.filter(e => e.type === 'step/start').length, 3)
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool', 'tool', 'assistant', 'assistant'])
  wire(messages)
})
check('tool calls keep callID, arguments, completed/error status and exact pairing', () => {
  const { session, messages } = projected(fixture([user('u1', 'tools'), assistant('a1', 'u1', [tool('call-ok'), tool('call-bad', 'error')])]))
  const step = session.turns[0].steps[0]
  assert.deepEqual(step.blocks.map(b => b.id), ['call-ok', 'call-bad'])
  assert.equal(step.blocks[0].arguments, '{"path":"/never/read/this"}')
  assert.deepEqual(step.results, [{ callId: 'call-ok', text: 'call-ok output', isError: false }, { callId: 'call-bad', text: 'call-bad error', isError: true }])
  wire(messages)
})
check('pending/running tools close as interrupted errors, never resumed execution', () => {
  const { session, log, messages } = projected(fixture([user('u1', 'tools'), assistant('a1', 'u1', [tool('pending', 'pending'), tool('running', 'running')])]))
  assert.equal(session.turns[0].aborted, true)
  assert.ok(session.turns[0].steps[0].results.every(r => r.isError && r.text === '[Tool execution was interrupted]'))
  assert.equal(log.events.find(e => e.type === 'turn/end').data.reason.kind, 'aborted')
  wire(messages)
})
function transcript(log, model) {
  const noop = () => undefined
  const state = { ...createInitialChannelView({ model: 'source-model', provider: 'fixture', cwd: '/synthetic/project' }, {
    agentId: String(model.id), mode: { id: 'normal', name: 'Normal' }, cwdDescription: '/synthetic/project',
  }), emit: noop }
  const projector = createChannelProjection(state, {
    agent: () => ({ session: model }), rowIds: { value: 0 }, resetContextWarning: noop,
    jobs: { onOutputSeen: noop, onStarted: noop }, inputConvergence: { cancelInFlight: false },
    checkContextWarning: noop, notify: noop, attachments: noop, selectionAttached: noop,
  })
  projector.replayEvents(log.events)
  return { state, projector }
}
for (const name of ['read', 'task', 'ask_user_question']) {
  for (const status of ['completed', 'error', 'running']) {
    check(`Channel replay retains imported ${name} ${status} card, call-ID and seq`, () => {
      const { log, model } = projected(fixture([user('u1', 'tools'), assistant('a1', 'u1', [tool('imported-call', status, {}, { tool: name })])]))
      const { state, projector } = transcript(log, model)
      const call = log.events.find(e => e.type === 'tool/call')
      const row = state.rows.find(r => r.kind === 'tool')
      assert.equal(row?.tool?.name, name)
      assert.equal(row?.tool?.callId, 'imported-call')
      assert.equal(row?.seq, call.seq)
      assert.equal(row?.tool?.status, status === 'completed' ? 'ok' : 'error')
      assert.equal(status === 'completed' ? row.tool.resultFull : row.tool.errorText,
        status === 'completed' ? 'imported-call output' : status === 'error' ? 'imported-call error' : '[Tool execution was interrupted]')
      assert.equal(state.activeToolCount, 0)
      // A binding reset must discard provenance along with all projection state.
      const assistantEvent = log.events.find(e => e.type === 'assistant/message')
      projector.reset()
      state.rows.length = 0
      projector.renderEvent(assistantEvent)
      projector.reset()
      projector.renderEvent(call)
      assert.equal(state.rows.filter(r => r.kind === 'tool').length, name === 'read' ? 1 : 0)
      // Native calls retain their subagent/questionnaire suppression after an import.
      const nativeEvents = log.events.map(e => e.type === 'assistant/message'
        ? { ...e, data: { ...e.data, message: { ...e.data.message, source: { ...e.data.message.source, provider: 'fixture' } } } }
        : e)
      const native = transcript({ events: nativeEvents }, model).state
      assert.equal(native.rows.filter(r => r.kind === 'tool').length, name === 'read' ? 1 : 0)
      const withoutProvenance = nativeEvents.map(e => e.type === 'assistant/message'
        ? { ...e, data: { ...e.data, message: { ...e.data.message, source: undefined } } }
        : e)
      assert.equal(transcript({ events: withoutProvenance }, model).state.rows.filter(r => r.kind === 'tool').length,
        name === 'read' ? 1 : 0, 'legacy/stub message without source must not throw or imply import')
    })
  }
}
check('interrupted tool errors retain explicitly recorded partial output', () => {
  const { session } = projected(fixture([user('u1', 'tools'), assistant('a1', 'u1', [tool('c1', 'error', { metadata: { interrupted: true, output: 'partial output' } })])]))
  assert.deepEqual(session.turns[0].steps[0].results[0], { callId: 'c1', text: 'partial output', isError: false })
})
check('compacted tools cannot resurrect stored output or attachment content', () => {
  const { session, log, messages } = projected(fixture([user('u1', 'tools'), assistant('a1', 'u1', [tool('c1', 'completed', { time: { compacted: NOW }, output: 'DO-NOT-RESURRECT', attachments: [{ mime: 'image/png', filename: 'SECRET-NAME', url: 'data:image/png;base64,SECRET' }] })])]))
  assert.equal(session.turns[0].steps[0].results[0].text, '[Old tool result content cleared]')
  assert.ok(!JSON.stringify(log).includes('DO-NOT-RESURRECT'))
  assert.ok(!JSON.stringify(messages).includes('SECRET'))
})
check('unpruned tool output is byte-clamped without splitting Unicode', () => {
  const session = parsed(fixture([user('u1', 'big'), assistant('a1', 'u1', [tool('c1', 'completed', { output: '界'.repeat(TOOL_RESULT_MAX_BYTES) })])]))
  const result = session.turns[0].steps[0].results[0].text
  assert.ok(result.endsWith('bytes]'))
  assert.ok(!result.includes('\uFFFD'))
  assert.ok(Buffer.byteLength(result) < TOOL_RESULT_MAX_BYTES + 100)
})
check('reused IDs across assistant messages preserve separate outputs and wire pairs', () => {
  const { session, messages } = projected(fixture([
    user('u1', 'two calls'),
    assistant('a1', 'u1', [tool('call_0', 'completed', { output: 'first output' })]),
    assistant('a2', 'u1', [tool('call_0', 'completed', { output: 'second output' })]),
  ]))
  const steps = session.turns[0].steps
  assert.deepEqual(steps.map(step => step.blocks[0].id), ['call_0', 'call_0#2'])
  assert.deepEqual(steps.map(step => step.results[0]), [
    { callId: 'call_0', text: 'first output', isError: false },
    { callId: 'call_0#2', text: 'second output', isError: false },
  ])
  assert.deepEqual(messages.filter(m => m.role === 'tool').map(m => m.toolCallId), ['call_0', 'call_0#2'])
  assert.deepEqual(contents(messages).filter(Boolean), ['two calls', 'first output', 'second output'])
  assert.equal(session.stats.droppedToolResults, 0)
  wire(messages)
})
check('IDs reused across step boundaries and naturally suffixed IDs remain collision-safe', () => {
  for (const ids of [['call_0', 'call_0', 'call_0#2'], ['call_0', 'call_0#2', 'call_0']]) {
    const { session, messages } = projected(fixture([
      user('u1', 'collisions'),
      assistant('a1', 'u1', [tool(ids[0], 'completed', { output: 'first' }), part('step-finish'), part('step-start'), tool(ids[1], 'completed', { output: 'second' }), tool(ids[2], 'completed', { output: 'third' })]),
    ]))
    const steps = session.turns[0].steps
    const calls = steps.flatMap(step => step.blocks.filter(block => block.type === 'tool-call').map(block => block.id))
    assert.equal(steps.length, 2)
    assert.equal(new Set(calls).size, 3)
    assert.deepEqual(steps.flatMap(step => step.results.map(result => result.callId)), calls)
    assert.deepEqual(messages.filter(m => m.role === 'tool').map(m => m.toolCallId), calls)
    assert.deepEqual(contents(messages).filter(Boolean), ['collisions', 'first', 'second', 'third'])
    assert.equal(session.stats.droppedToolResults, 0)
    wire(messages)
  }
})
check('duplicate IDs within one step, unsupported status and malformed inputs fail closed', () => {
  rejects(fixture([user('u1', 'bad'), assistant('a1', 'u1', [tool('c1'), tool('c1')])]), /duplicate tool callID/)
  rejects(fixture([user('u1', 'bad'), assistant('a1', 'u1', [tool('c1', 'future')])]), /unsupported status/)
  rejects(fixture([user('u1', 'bad'), assistant('a1', 'u1', [tool('c1', 'completed', { input: 'not an object' })])]), /state.input must be an object/)
})

const compacted = tail => fixture([
  user('u-old', 'DROP OLD USER'), assistant('a-old', 'u-old', 'DROP OLD ANSWER'),
  user('u-tail', 'retained question'), assistant('a-tail', 'u-tail', [tool('tail-call'), part('step-finish'), part('step-start'), txt('retained answer')]),
  compaction('u-compact', tail), summary('a-summary', 'u-compact', 'checkpoint summary'),
  user('u-later', 'later question'), assistant('a-later', 'u-later', 'later answer'),
])
check('successful compaction without tail projects only summary and later', () => {
  const { session, messages, log } = projected(compacted())
  assert.equal(session.turns[0].compaction.summary, 'checkpoint summary')
  assert.deepEqual(contents(messages), ['checkpoint summary', 'later question', 'later answer'])
  assert.ok(!JSON.stringify(log).includes('DROP OLD'))
  assert.ok(!JSON.stringify(log).includes('retained question'))
})
check('successful compaction reorders retained user tail after summary exactly once', () => {
  const { messages, log } = projected(compacted('u-tail'))
  assert.deepEqual(contents(messages), ['checkpoint summary', 'retained question', '', 'tail-call output', 'retained answer', 'later question', 'later answer'])
  assert.equal(contents(messages).filter(s => s === 'checkpoint summary').length, 1)
  assert.ok(!JSON.stringify(log).includes('DROP OLD'))
  wire(messages)
})
check('tail_start_id can split a turn at an assistant without reviving its user', () => {
  const { session, messages, log } = projected(compacted('a-tail'))
  assert.equal(session.turns[0].prompt, '')
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool', 'assistant', 'user', 'assistant'])
  assert.equal(contents(messages)[0], 'checkpoint summary')
  assert.ok(!JSON.stringify(log).includes('retained question'))
  assert.ok(!JSON.stringify(log).includes('DROP OLD'))
  wire(messages)
})
check('last successful compaction wins over earlier summaries', () => {
  const value = compacted('u-tail')
  value.messages.push(compaction('u-compact2'), summary('a-summary2', 'u-compact2', 'latest summary'))
  const { messages, log } = projected(value)
  assert.deepEqual(contents(messages), ['latest summary'])
  assert.ok(!JSON.stringify(log).includes('checkpoint summary'))
})
check('failed and unfinished compactions do not erase the preceding context', () => {
  for (const fields of [{ finish: 'error', error: { name: 'ContextOverflowError', data: { message: 'overflow' } } }, { finish: undefined }]) {
    const { messages } = projected(fixture([user('u1', 'keep me'), assistant('a1', 'u1', 'keep answer'), compaction('uc'), summary('ac', 'uc', 'attempt', fields)]))
    assert.equal(contents(messages)[0], 'keep me')
    assert.equal(contents(messages)[1], 'keep answer')
    assert.ok(contents(messages).includes('What did we do so far?'))
  }
})
check('failed compaction after success does not resurrect the older head', () => {
  const value = compacted('u-tail')
  value.messages.push(compaction('uc-failed'), summary('ac-failed', 'uc-failed', 'FAILED SUMMARY', { finish: 'error', error: { name: 'APIError' } }))
  const { messages, log } = projected(value)
  assert.equal(contents(messages)[0], 'checkpoint summary')
  assert.equal(contents(messages).at(-1), 'What did we do so far?')
  assert.ok(!JSON.stringify(log).includes('DROP OLD'))
  assert.ok(!JSON.stringify(log).includes('FAILED SUMMARY'))
})
check('summary-only exports use existing compaction headless fallback', () => {
  const { messages } = projected(fixture([compaction('uc'), summary('ac', 'uc', 'only summary')]))
  assert.deepEqual(contents(messages), ['only summary'])
})
check('compaction requires non-empty success summary and valid parent', () => {
  rejects(fixture([compaction('uc'), summary('ac', 'uc', '')]), /summary is empty/)
  rejects(fixture([user('u1', 'ordinary'), summary('ac', 'u1', 'not safe')]), /no compaction user parent/)
  rejects(fixture([compaction('uc'), summary('ac', 'uc', 'one'), summary('ac2', 'uc', 'two')]), /multiple successful summaries/)
  rejects(fixture([compaction('uc'), summary('ac', 'uc', [tool('bad-summary')])]), /unsupported non-text content/)
})
check('mixed successful compaction requests cannot silently discard user content', () => {
  rejects(fixture([user('uc', [part('compaction', { auto: true }), txt('cannot drop this')]), summary('ac', 'uc', 'summary')]), /additional semantic content/)
})
check('invalid tail boundaries throw rather than reverting to full history', () => {
  for (const target of ['missing', 'u-compact', 'a-summary', 'u-later']) rejects(compacted(target), /tail_start_id .* earlier message/)
})
check('interleaved compaction boundaries are rejected explicitly', () => {
  rejects(fixture([user('u1', 'head'), compaction('uc'), user('u2', 'concurrent'), summary('ac', 'uc', 'unsafe')]), /interleaved/)
})

check('messageID revert excludes target and all following messages', () => {
  const value = compacted('u-tail')
  value.info.revert = { messageID: 'u-tail', snapshot: 'DO-NOT-RESTORE', diff: 'DO-NOT-APPLY' }
  const { messages, log } = projected(value)
  assert.deepEqual(contents(messages), ['DROP OLD USER', 'DROP OLD ANSWER'])
  assert.ok(!JSON.stringify(log).includes('retained'))
  assert.ok(!JSON.stringify(log).includes('checkpoint'))
  assert.ok(!JSON.stringify(log).includes('DO-NOT'))
})
check('partID revert preserves only parts strictly before the boundary', () => {
  const value = fixture([user('u1', 'keep question'), assistant('a1', 'u1', [txt('keep prefix'), part('step-finish'), part('step-start'), tool('reverted-tool'), txt('DROP AFTER')]), user('u2', 'DROP LATER')])
  value.info.revert = { messageID: 'a1', partID: value.messages[1].parts[3].id }
  const { messages, log } = projected(value)
  assert.deepEqual(contents(messages), ['keep question', 'keep prefix'])
  assert.ok(!JSON.stringify(log).includes('reverted-tool'))
  assert.ok(!JSON.stringify(log).includes('DROP'))
})
check('partID revert retains earlier tool pairs and closes pending tools', () => {
  const value = fixture([user('u1', 'keep question'), assistant('a1', 'u1', [tool('keep-call', 'running'), txt('DROP')])])
  value.info.revert = { messageID: 'a1', partID: value.messages[1].parts[1].id }
  const { messages } = projected(value)
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool'])
  wire(messages)
})
check('revert before successful summary never applies that now-reverted checkpoint', () => {
  const value = compacted('u-tail')
  value.info.revert = { messageID: 'a-summary' }
  const { messages } = projected(value)
  assert.equal(contents(messages)[0], 'DROP OLD USER')
  assert.ok(!contents(messages).includes('checkpoint summary'))
})
check('revert after successful compaction retains summary and tail but no later content', () => {
  const value = compacted('u-tail')
  value.info.revert = { messageID: 'u-later' }
  const { messages, log } = projected(value)
  assert.equal(contents(messages)[0], 'checkpoint summary')
  assert.ok(contents(messages).includes('retained question'))
  assert.ok(!JSON.stringify(log).includes('later question'))
  assert.ok(!JSON.stringify(log).includes('DROP OLD'))
})
check('missing revert anchors and partial summary revert fail closed', () => {
  rejects({ ...basic(), info: { ...basic().info, revert: { messageID: 'missing' } } }, /revert.messageID .* not found/)
  rejects({ ...basic(), info: { ...basic().info, revert: { messageID: 'u1', partID: 'missing' } } }, /revert.partID .* not found/)
  const value = compacted('u-tail')
  value.info.revert = { messageID: 'a-summary', partID: value.messages[5].parts[0].id }
  rejects(value, /revert inside a compaction summary/)
})
check('reverting the first message leaves no session', () => {
  const value = basic()
  value.info.revert = { messageID: 'u1' }
  assert.equal(parseOpenCodeExport(value), undefined)
})
check('files/attachments become notes; text/plain and directory source parts are ignored', () => {
  const { messages, log } = projected(fixture([
    user('u1', [part('file', { mime: 'text/plain', url: 'file:///never/read/plain' }), txt('resolved text'), part('file', { mime: 'application/x-directory', url: 'file:///never/read/dir' }), part('file', { mime: 'image/png', filename: 'picture.png', url: 'https://never.fetch/SECRET' })]),
    assistant('a1', 'u1', [tool('c1', 'completed', { attachments: [{ mime: 'application/pdf', filename: 'report.pdf', url: 'data:SECRET-BASE64' }] })]),
  ]))
  assert.equal(contents(messages)[0], 'resolved text\n[Attached image/png: picture.png]')
  assert.equal(contents(messages).at(-1), 'c1 output\n[Attached application/pdf: report.pdf]')
  assert.ok(!JSON.stringify(log).includes('SECRET'))
  assert.ok(!JSON.stringify(log).includes('file:///'))
})
check('synthetic user text survives, ignored user text does not', () => {
  const session = parsed(fixture([user('u1', [txt('synthetic continuation', { synthetic: true }), txt('DROP IGNORED', { ignored: true })])]))
  assert.equal(session.turns[0].prompt, 'synthetic continuation')
})
check('snapshot/patch/retry/agent metadata omitted and subtask is only historical marker', () => {
  const { messages, log } = projected(fixture([
    user('u1', [part('subtask', { prompt: 'NEVER EXECUTE', agent: 'child' }), part('agent', { name: 'NEVER LOAD' })]),
    assistant('a1', 'u1', [part('snapshot', { snapshot: 'NEVER RESTORE' }), part('patch', { files: ['/never/write'], hash: 'NEVER PATCH' }), part('retry', { error: { name: 'APIError' } }), txt('recorded answer')]),
  ]))
  assert.deepEqual(contents(messages), ['The following tool was executed by the user', 'recorded answer'])
  assert.ok(!JSON.stringify(log).includes('NEVER'))
})
check('unknown effective parts fail, but reverted unknown suffix never revives', () => {
  rejects(fixture([user('u1', [part('future-part')])]), /unsupported type future-part/)
  const value = fixture([user('u1', 'keep'), assistant('a1', 'u1', [txt('prefix'), part('future-part')])])
  value.info.revert = { messageID: 'a1', partID: value.messages[1].parts[1].id }
  assert.deepEqual(contents(projected(value).messages), ['keep', 'prefix'])
})
check('provider errors are omitted; aborted readable output remains marked aborted', () => {
  const { messages, session } = projected(fixture([user('u1', 'question'), assistant('a1', 'u1', 'DROP ERROR', { error: { name: 'APIError' } }), assistant('a2', 'u1', [reasoning('partial thinking'), txt('partial answer')], { error: { name: 'MessageAbortedError' } })]))
  assert.deepEqual(contents(messages), ['question', 'partial thinkingpartial answer'])
  assert.equal(session.turns[0].aborted, true)
})
check('malformed envelope, ownership, identities and chronology are rejected', () => {
  rejects({ info: null, messages: [] }, /session.info must be an object/)
  rejects({ ...basic(), messages: null }, /messages must be an array/)
  for (const field of ['created', 'updated']) {
    const value = basic()
    value.info.time[field] = Number.NaN
    rejects(value, /finite timestamp/)
  }
  const duplicate = basic()
  duplicate.messages.push(duplicate.messages[1])
  rejects(duplicate, /duplicate message id/)
  const ownership = basic()
  ownership.messages[1].parts[0].messageID = 'other'
  rejects(ownership, /mismatched messageID/)
  const duplicatePart = basic()
  duplicatePart.messages[1].parts[1].id = duplicatePart.messages[1].parts[0].id
  rejects(duplicatePart, /duplicate part id/)
  const reversed = basic()
  reversed.messages[1].info.time.created = NOW - 1
  rejects(reversed, /chronological export order/)
})
console.log(`OpenCode pure parser regression passed (${checks} checks)`)

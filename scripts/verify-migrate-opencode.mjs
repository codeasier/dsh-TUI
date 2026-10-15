/** OpenCode end-to-end migration using synthetic SQLite only (no credentials/model calls).
 * Run: node --import tsx/esm scripts/verify-migrate-opencode.mjs
 * Proves CLI/browser identity, official persistence → open → fromRestore →
 * deriveMessages → append → reopen, effective compaction/revert context, WAL
 * freshness, source immutability and duplicate imports preserving DSH continuation.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenCodeDatabase, insertOpenCodeExport } from './lib/opencode-fixture.mjs'
import { settled } from './lib/term-test.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'verify-migrate-opencode-'))
const databasePath = join(scratch, 'opencode.db')
const keys = ['HOME', 'USERPROFILE', 'XDG_DATA_HOME', 'OPENCODE_DB', 'GROK_HOME', 'DSH_TUI_SESSION_ROOT']
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
Object.assign(process.env, {
  HOME: scratch, USERPROFILE: scratch, XDG_DATA_HOME: scratch,
  OPENCODE_DB: databasePath, GROK_HOME: join(scratch, 'grok'),
  DSH_TUI_SESSION_ROOT: join(scratch, 'sessions'),
})
const db = createOpenCodeDatabase(databasePath)
let fiber
let checks = 0
function check(name, test) {
  test()
  checks++
  console.log(`PASS: ${name}`)
}

// IDs are globally unique as in OpenCode; timestamps and part IDs preserve order.
function fixture(id, compacted = false) {
  const now = Date.now()
  const messages = []
  const message = (role, name, parts, extra = {}) => {
    const messageID = `${id}_${name}`
    messages.push({
      info: { id: messageID, sessionID: id, role, time: { created: now + messages.length },
        ...(role === 'assistant' ? { modelID: 'fixture-model', parentID: `${id}_${extra.parent ?? 'user'}`, finish: 'stop' } : {}),
        ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'parent')) },
      parts: parts.map((part, index) => ({ ...part, id: `${messageID}_part_${index}`, sessionID: id, messageID })),
    })
    return messageID
  }
  const text = value => ({ type: 'text', text: value })
  const tool = (callID, status, output, extra = {}) => ({ type: 'tool', callID: `${id}_${callID}`, tool: 'read',
    state: { status, input: { path: 'synthetic.txt' }, output, time: { start: now, end: now + 1, ...extra } } })
  if (compacted) {
    message('user', 'old-user', [text('COMPACTED_AWAY_PROMPT')])
    message('assistant', 'old-answer', [text('COMPACTED_AWAY_ANSWER')], { parent: 'old-user' })
  }
  const tailID = message('user', 'user', [text('保留的问题 🎏')])
  message('assistant', 'tools', [
    { type: 'step-start' }, { type: 'reasoning', text: '可读推理' },
    tool('pruned-call', 'completed', 'PRUNED_SECRET_OUTPUT', { compacted: now }),
    { type: 'step-finish' },
  ])
  message('assistant', 'answer', [text('保留的答复')])
  if (compacted) {
    message('user', 'compact', [{ type: 'compaction', auto: true, tail_start_id: tailID }])
    message('assistant', 'summary', [text('SUCCESSFUL_CHECKPOINT')], { parent: 'compact', summary: true })
  }
  message('user', 'later', [text('后续问题')])
  message('assistant', 'running', [tool('running-call', 'running', undefined)], { parent: 'later' })
  const reverted = message('user', 'undone', [text('REVERTED_PROMPT')])
  message('assistant', 'undone-answer', [text('REVERTED_ANSWER')], { parent: 'undone' })
  return { info: { id, directory: scratch, title: id, time: { created: now, updated: now }, revert: { messageID: reverted } }, messages }
}

try {
  insertOpenCodeExport(db, fixture('ses_regular'))
  insertOpenCodeExport(db, fixture('ses_compacted', true))
  const before = { db: readFileSync(databasePath), wal: readFileSync(`${databasePath}-wal`) }
  const [{ opencodeAdapter }, { createForeignBrowser }, { migrationSessionId, importSessions, MIGRATION_ADAPTERS },
    { collectMigratePickerRows, resolveMigrateCommand }, { cliMigrate }, { Context }, { default: Persistence },
    { Session, SessionId, SessionLogOffset }, { createUserMessage, createAssistantMessage }] = await Promise.all([
    import('../src/dsh-adapter/migrate/adapters/opencode.js'),
    import('../src/dsh-adapter/migrate/browse.js'),
    import('../src/dsh-adapter/migrate/index.js'),
    import('../src/dsh-adapter/migrate/picker.js'),
    import('../src/dsh-adapter/migrate/cli.js'),
    import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-session-persistence-jsonl'),
    import('@deepseek-ai/dsh-session'), import('@deepseek-ai/dsh-llm'),
  ])
  check('registry-driven /migrate accepts OpenCode before opening the picker', () => {
    assert.deepEqual(resolveMigrateCommand('opencode --dry-run', MIGRATION_ADAPTERS.map(a => a.id)),
      { kind: 'import', agentId: 'opencode', dryRun: true })
  })
  check('picker counts sessions and uses row activity, not database files', () => {
    const row = collectMigratePickerRows(Date.now()).find(row => row.agentId === 'opencode')
    assert.equal(row.count, 2)
    assert.equal(row.minutesAgo, 0)
  })
  const found = opencodeAdapter.discover()
  check('both local SQLite sessions discover without diagnostics', () => {
    assert.equal(found.sessions.length, 2)
    assert.deepEqual(found.diagnostics ?? [], [])
  })
  const ctx = new Context()
  fiber = ctx.plugin(Persistence, { root: process.env.DSH_TUI_SESSION_ROOT })
  assert.ok(await settled(() => ctx.get('sessionPersistence') !== undefined))
  const persistence = ctx.get('sessionPersistence')
  const browser = createForeignBrowser(() => persistence, undefined, [opencodeAdapter])
  check('database source appears without a file walk', () => assert.equal(opencodeAdapter.walk, undefined))
  assert.deepEqual(await browser.listSources(), [{ agentId: 'opencode', label: 'OpenCode' }])
  const rows = await browser.listSessions('opencode')
  check('source-tab rows preserve project directory and opaque keys', () => {
    assert.equal(rows.length, 2)
    assert.ok(rows.every(row => row.cwd === scratch && row.key.startsWith('opencode-db:')))
  })
  const imported = []
  for (const row of rows) {
    const outcome = await browser.importSession('opencode', row.key)
    assert.equal(outcome.kind, 'ready')
    assert.equal(outcome.created, true)
    const session = found.sessions.find(session => session.title === row.title)
    assert.equal(outcome.sessionId, migrationSessionId(opencodeAdapter, session))
    imported.push({ row, id: SessionId(outcome.sessionId) })
  }
  check('CLI and source tabs derive the same deterministic IDs', () => assert.equal(imported.length, 2))
  const batch = await importSessions(opencodeAdapter, process.env.DSH_TUI_SESSION_ROOT, found.sessions)
  check('batch import skips source-tab imports', () => assert.deepEqual(
    { imported: batch.imported, existing: batch.existing, failed: batch.failed }, { imported: 0, existing: 2, failed: 0 }))

  for (const { row, id } of imported) {
    const handle = await persistence.open(id, 'read')
    const stored = await handle.read()
    const restored = Session.fromRestore(id, stored.events, handle.header, SessionLogOffset(0), stored.eventState)
    const messages = restored.deriveMessages()
    const text = JSON.stringify(messages)
    check(`${row.title}: official restore preserves effective text/reasoning, not reverted/pruned content`, () => {
      assert.ok(text.includes('保留的问题 🎏') && text.includes('可读推理') && text.includes('保留的答复'))
      assert.ok(text.includes('[Old tool result content cleared]') && text.includes('[Tool execution was interrupted]'))
      assert.ok(!/PRUNED_SECRET_OUTPUT|REVERTED_|COMPACTED_AWAY/u.test(text))
      if (row.title === 'ses_compacted') {
        assert.ok(text.indexOf('SUCCESSFUL_CHECKPOINT') < text.indexOf('保留的问题'))
      }
      assert.equal(stored.events.filter(event => event.type === 'system/message').length, 1)
    })
    check(`${row.title}: wire tool calls have exactly matching following results`, () => {
      for (let index = 0; index < messages.length; index++) {
        const calls = messages[index].content.filter(block => block.type === 'tool-call')
        calls.forEach((call, offset) => {
          assert.equal(messages[index + offset + 1].role, 'tool')
          assert.equal(messages[index + offset + 1].toolCallId, call.id)
        })
      }
    })
    await handle.close()
    const turn = stored.events.filter(event => event.type === 'turn/start').length + 1
    // Detached restore adds session/end-seed before our first append. Like the
    // existing verify-migrate roundtrip, capture that constructor-owned marker
    // in this test-only snapshot; persisting only append returns leaves a gap.
    const restoredPrefix = restored.snapshotEvents(SessionLogOffset(stored.events.length))
    const added = [
      ...restoredPrefix,
      restored.append('turn/start', { turn }),
      restored.append('step/start', { turn, step: 1 }),
      restored.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'DSH_CONTINUATION' }], source: { kind: 'user' } }), { surfaceOp: 'append' }),
      restored.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({
        content: [{ type: 'text', text: 'DSH_CONTINUED_ANSWER' }], source: { provider: 'fixture', model: 'fixture' },
      }) }, { surfaceOp: 'append' }),
      restored.append('step/end', { turn, step: 1 }),
      restored.append('turn/end', { turn, reason: { kind: 'completed' } }),
    ]
    const write = await persistence.open(id, 'write')
    try { await write.append(added); await write.flush() } finally { await write.close() }
    const duplicate = await browser.importSession('opencode', row.key)
    assert.equal(duplicate.created, false)
    const reopened = await persistence.open(id, 'read')
    try {
      const grown = await reopened.read()
      const model = Session.fromRestore(id, grown.events, reopened.header, SessionLogOffset(0), grown.eventState)
      check(`${row.title}: appended turn survives reopen and duplicate import`, () => {
        const content = JSON.stringify(model.deriveMessages())
        assert.ok(content.includes('DSH_CONTINUATION') && content.includes('DSH_CONTINUED_ANSWER'))
        assert.equal(grown.events.length, stored.events.length + added.length)
      })
    } finally { await reopened.close() }
  }
  check('discovery/import leaves source database and committed WAL byte-identical', () => {
    assert.deepEqual(readFileSync(databasePath), before.db)
    assert.deepEqual(readFileSync(`${databasePath}-wal`), before.wal)
  })

  // A source change with unchanged session timestamp must not hit mtime/size cache.
  db.prepare('UPDATE session SET title = ? WHERE id = ?').run('Renamed through WAL', 'ses_regular')
  const refreshed = await browser.listSessions('opencode')
  check('WAL metadata refresh bypasses unchanged fingerprint', () => assert.ok(refreshed.some(row => row.title === 'Renamed through WAL')))
  db.prepare('INSERT INTO session_input VALUES (?, ?, ?, ?, ?, ?, ?)').run('native_input', 'ses_regular', 'native prompt', 'queued', 1, null, Date.now())
  const stdout = process.stdout.write
  const stderr = process.stderr.write
  let report = ''
  let diagnostic = ''
  let exit
  try {
    process.stdout.write = chunk => { report += String(chunk); return true }
    process.stderr.write = chunk => { diagnostic += String(chunk); return true }
    exit = await cliMigrate(['opencode', '--dry-run'])
  } finally { process.stdout.write = stdout; process.stderr.write = stderr }
  check('CLI reports native storage as unsupported while previewing supported sessions', () => {
    assert.equal(exit, 1)
    assert.match(diagnostic, /native.*not supported/u)
    assert.match(report, /1 conversation\(s\) would be imported/u)
  })
  console.log(`OpenCode integration: ${checks} checks passed`)
} finally {
  await Promise.resolve(fiber?.dispose())
  db.close()
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  // Delete only the exact temporary fixture directory created above.
  assert.equal(realpathSync(scratch), join(realpathSync(tmpdir()), scratch.slice(tmpdir().length + 1)))
  assert.ok(scratch.includes('verify-migrate-opencode-'))
  rmSync(scratch, { recursive: true, force: true })
}

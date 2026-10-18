#!/usr/bin/env node
/** Bounded, synthetic-only SQLite regression. Never opens real user stores.
 * Run: node --import tsx/esm scripts/verify-migrate-opencode-db.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createOpenCodeDatabase, createOpenCodeExport, insertOpenCodeExport } from './lib/opencode-fixture.mjs'

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-opencode-db-')))
const savedEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'XDG_DATA_HOME', 'OPENCODE_DB', 'OPENCODE_DISABLE_CHANNEL_DB', 'OPENCODE_TEST_HOME'].map(key => [key, process.env[key]]))
const handles = new Set()
let checks = 0
function testRoot(name) {
  const base = join(temp, name)
  process.env.HOME = join(base, 'home')
  process.env.USERPROFILE = process.env.HOME
  process.env.XDG_DATA_HOME = join(base, 'xdg')
  delete process.env.OPENCODE_DB
  delete process.env.OPENCODE_DISABLE_CHANNEL_DB
  const root = join(process.env.XDG_DATA_HOME, 'opencode')
  mkdirSync(root, { recursive: true })
  return root
}
function database(path) {
  const db = createOpenCodeDatabase(path)
  handles.add(db)
  return db
}
function ref(path, id) { return `opencode-db:${Buffer.from(JSON.stringify([path, id])).toString('base64url')}` }
function checked() { checks++ }

try {
  let root = testRoot('empty')
  const { opencodeAdapter: adapter } = await import('../src/dsh-adapter/migrate/adapters/opencode.ts')
  assert.deepEqual(adapter.roots(), [root])
  assert.equal(adapter.count(), 0)
  assert.equal(adapter.hasSessions(), false)
  assert.equal(adapter.newestActivity(), null)
  assert.deepEqual(await adapter.scan(), [])
  let db = database(join(root, 'opencode.db'))
  assert.equal(adapter.hasSessions(), false, 'an empty SQLite file is not a session')
  checked()

  const exported = createOpenCodeExport('ses_root')
  insertOpenCodeExport(db, exported)
  insertOpenCodeExport(db, createOpenCodeExport('ses_child', { parentID: 'ses_root', updated: exported.info.time.updated + 500 }))
  assert.equal(adapter.count(), 1, 'child sessions excluded by the same policy as the parser')
  assert.equal(adapter.hasSessions(), true)
  assert.equal(adapter.newestActivity(), exported.info.time.updated)
  const entries = await adapter.scan({ cached() { throw new Error('SQLite must never reuse file fingerprints') } })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].summary.sessionKey, 'ses_root')
  assert.notEqual(entries[0].ref, join(root, 'opencode.db'))
  const imported = await adapter.load(entries[0].ref)
  assert.equal(imported.sourceId, 'ses_root')
  assert.equal(imported.turns[0].prompt, 'Synthetic question')
  assert.equal(imported.turns[0].steps[0].blocks[0].text, 'Synthetic answer')
  assert.deepEqual(adapter.discover().sessions, [imported])
  checked()

  // Hold a WAL writer open: both the base-file fingerprint and size remain
  // unchanged while session metadata and transcript change in WAL alone.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const dbPath = join(root, 'opencode.db')
  const baseBefore = statSync(dbPath)
  db.prepare('UPDATE session SET title = ?, time_updated = ? WHERE id = ?').run('WAL title', exported.info.time.updated + 1000, 'ses_root')
  db.prepare('UPDATE part SET data = ? WHERE id = ?').run(JSON.stringify({ type: 'text', text: 'WAL answer' }), 'ses_root_part_2')
  assert.equal(statSync(dbPath).mtimeMs, baseBefore.mtimeMs)
  assert.equal(statSync(dbPath).size, baseBefore.size)
  const bytesBefore = [readFileSync(dbPath), readFileSync(`${dbPath}-wal`)]
  const updated = await adapter.scan({ cached: () => { throw new Error('stale cached summary used') } })
  assert.equal(updated[0].summary.title, 'WAL title')
  assert.equal(adapter.newestActivity(), exported.info.time.updated + 1000)
  assert.equal((await adapter.load(updated[0].ref)).turns[0].steps[0].blocks[0].text, 'WAL answer')
  assert.deepEqual(readFileSync(dbPath), bytesBefore[0], 'reader must not modify/checkpoint source database')
  assert.deepEqual(readFileSync(`${dbPath}-wal`), bytesBefore[1], 'reader must not modify source WAL')
  checked()

  // A transaction spans callback yields: committed writes after the first
  // result must not mix into the current scan, but appear on the next scan.
  insertOpenCodeExport(db, createOpenCodeExport('ses_z'))
  const coherent = await adapter.scan({ onEntry(item) {
    if (item.sessionKey === 'ses_root') db.prepare('UPDATE session SET title = ? WHERE id = ?').run('After snapshot', 'ses_z')
  } })
  assert.equal(coherent.find(entry => entry.summary.sessionKey === 'ses_z').summary.title, 'Synthetic OpenCode session')
  assert.equal((await adapter.scan()).find(entry => entry.summary.sessionKey === 'ses_z').summary.title, 'After snapshot')
  checked()

  // Ordering follows message timestamp+id and part id, not insertion order.
  root = testRoot('ordering')
  db = database(join(root, 'opencode.db'))
  const orderExport = createOpenCodeExport('ses_order')
  const answer = orderExport.messages[1]
  answer.parts = [
    { ...answer.parts[0], id: 'part_z', text: 'Second' },
    { ...answer.parts[0], id: 'part_a', text: 'First' },
  ]
  orderExport.messages.reverse()
  insertOpenCodeExport(db, orderExport)
  const ordered = await adapter.load((await adapter.scan())[0].ref)
  assert.deepEqual(ordered.turns[0].steps[0].blocks.map(block => block.text), ['First', 'Second'])
  // Relational ids override any untrusted duplicate ids inside the JSON blob.
  db.prepare('UPDATE message SET data = json_set(data, \'$.id\', \'forged\', \'$.sessionID\', \'elsewhere\')').run()
  assert.equal((await adapter.load((await adapter.scan())[0].ref)).sourceId, 'ses_order')
  checked()

  root = testRoot('channels')
  for (const name of ['opencode.db', 'opencode-local.db', 'opencode-feature-x.db']) {
    insertOpenCodeExport(database(join(root, name)), createOpenCodeExport(name))
  }
  writeFileSync(join(root, 'unrelated.db'), 'not a source')
  writeFileSync(join(root, 'opencode.db-wal-other'), 'not a source')
  assert.equal(adapter.count(), 3)
  assert.equal((await adapter.scan()).length, 3)
  // DB disabling is OpenCode's writer policy; migration still finds older
  // channel files so changing channels cannot hide existing conversations.
  process.env.OPENCODE_DISABLE_CHANNEL_DB = 'true'
  assert.equal(adapter.count(), 3)
  process.env.OPENCODE_DB = 'opencode-local.db'
  assert.deepEqual(adapter.roots(), [join(root, 'opencode-local.db')])
  assert.equal(adapter.count(), 1)
  process.env.OPENCODE_DB = join(root, 'opencode-feature-x.db')
  assert.equal(adapter.count(), 1)
  for (const suffix of ['/./opencode-feature-x.db', '/../opencode/opencode-feature-x.db']) {
    process.env.OPENCODE_DB = root + suffix
    assert.deepEqual(adapter.roots(), [join(root, 'opencode-feature-x.db')])
    assert.equal((await adapter.load((await adapter.scan())[0].ref)).sourceId, 'opencode-feature-x.db')
  }
  process.env.OPENCODE_DB = join(root, 'missing.db')
  assert.equal(adapter.hasSessions(), false)
  assert.equal(adapter.count(), 0)
  assert.deepEqual(adapter.discover().diagnostics, [])
  assert.equal(statSync(root).isDirectory(), true)
  process.env.OPENCODE_DB = ':memory:'
  assert.equal(adapter.count(), 0)
  assert.equal(adapter.hasSessions(), true)
  await assert.rejects(adapter.scan(), /:memory:/u)
  checked()

  root = testRoot('locator')
  db = database(join(root, 'opencode.db'))
  insertOpenCodeExport(db, createOpenCodeExport('ses_locator'))
  const outside = join(temp, 'outside.db')
  insertOpenCodeExport(database(outside), createOpenCodeExport('ses_outside'))
  for (const invalid of ['plain-path', 'opencode-db:%%%%', 'opencode-db:W10', ref(outside, 'ses_outside'), ref(join(root, '..', 'outside.db'), 'ses_outside'), ref(join(root, 'opencode.db'), '')]) {
    await assert.rejects(adapter.load(invalid), /locator|path|roots/u)
  }
  let symlinkCreated = false
  try {
    symlinkSync(outside, join(root, 'opencode-escape.db'))
    symlinkCreated = true
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error
  }
  assert.equal(adapter.count(), 1)
  if (symlinkCreated) await assert.rejects(adapter.load(ref(join(root, 'opencode-escape.db'), 'ses_outside')), /outside/u)
  assert.deepEqual(await adapter.load(ref(join(root, 'opencode.db'), 'missing')), { skip: 'missing' })
  assert.deepEqual(await adapter.load(ref(join(root, 'opencode-missing.db'), 'missing')), { skip: 'missing' })
  // Explicit configuration may intentionally name a database outside XDG.
  process.env.OPENCODE_DB = outside
  assert.equal(adapter.count(), 1)
  assert.equal((await adapter.load((await adapter.scan())[0].ref)).sourceId, 'ses_outside')
  checked()

  root = testRoot('mixed-native')
  db = database(join(root, 'opencode.db'))
  insertOpenCodeExport(db, createOpenCodeExport('ses_v1'))
  for (const id of ['ses_native_message', 'ses_native_input', 'ses_dual']) {
    insertOpenCodeExport(db, { ...createOpenCodeExport(id), messages: id === 'ses_dual' ? createOpenCodeExport(id).messages : [] })
  }
  db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run('native_1', 'ses_native_message', 'assistant', 1, 1, 1, '{}')
  db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run('native_2', 'ses_dual', 'assistant', 1, 1, 1, '{}')
  db.prepare('INSERT INTO session_input VALUES (?, ?, ?, ?, ?, ?, ?)').run('native_input', 'ses_native_input', '{}', 'immediate', 1, null, 1)
  assert.equal(adapter.count(), 4, 'cheap candidate counts include unsupported native sessions')
  const mixed = await adapter.scan()
  assert.equal(mixed.length, 4, 'mixed database remains browsable')
  for (const entry of mixed.filter(entry => entry.summary.sessionKey !== 'ses_v1')) await assert.rejects(adapter.load(entry.ref), /native session_message\/session_input.*not supported/u)
  assert.equal((await adapter.load(mixed.find(entry => entry.summary.sessionKey === 'ses_v1').ref)).sourceId, 'ses_v1')
  assert.equal(adapter.discover().sessions.length, 1)
  assert.match(adapter.discover().diagnostics.join('\n'), /3 session\(s\):.*native/u)
  // Legacy JSON directories commonly survive SQLite conversion; do not turn
  // that harmless leftover into a failing CLI discovery result.
  mkdirSync(join(root, 'storage', 'session'), { recursive: true })
  assert.doesNotMatch(adapter.discover().diagnostics.join('\n'), /legacy JSON/u)
  checked()

  root = testRoot('native-only')
  db = database(join(root, 'opencode.db'))
  insertOpenCodeExport(db, { ...createOpenCodeExport('ses_native_only'), messages: [] })
  db.exec('DROP TABLE part; DROP TABLE message')
  assert.equal(adapter.count(), 1)
  assert.equal((await adapter.scan()).length, 1)
  await assert.rejects(adapter.load((await adapter.scan())[0].ref), /native/u)
  assert.match(adapter.discover().diagnostics.join('\n'), /native/u)
  checked()

  for (const kind of ['unknown', 'malformed', 'corrupt']) {
    root = testRoot(kind)
    if (kind === 'corrupt') writeFileSync(join(root, 'opencode.db'), 'not SQLite')
    else {
      const bad = new DatabaseSync(join(root, 'opencode.db'))
      bad.exec(kind === 'unknown' ? 'CREATE TABLE unrelated (id TEXT)' : 'CREATE TABLE session (id TEXT)')
      bad.close()
    }
    assert.equal(adapter.count(), 0)
    assert.equal(adapter.newestActivity(), null)
    assert.equal(adapter.hasSessions(), true, 'unsupported stores must remain selectable for diagnostics')
    await assert.rejects(adapter.scan(), /schema|database/u)
    assert.ok(adapter.discover().diagnostics.length)
  }
  checked()

  root = testRoot('legacy')
  mkdirSync(join(root, 'storage', 'session', 'project'), { recursive: true })
  writeFileSync(join(root, 'storage', 'session', 'project', 'synthetic.json'), '{}')
  assert.equal(adapter.hasSessions(), true)
  assert.equal(adapter.count(), 0)
  await assert.rejects(adapter.scan(), /legacy JSON storage is not supported/u)
  assert.match(adapter.discover().diagnostics[0], /legacy JSON/u)
  checked()

  root = testRoot('limits')
  db = database(join(root, 'opencode.db'))
  insertOpenCodeExport(db, createOpenCodeExport('ses_large'))
  db.prepare('UPDATE part SET data = zeroblob(?) WHERE id = ?').run(64 * 1024 * 1024 + 1, 'ses_large_part_2')
  const largeRef = (await adapter.scan())[0].ref
  assert.deepEqual(await adapter.load(largeRef), { skip: 'too-large' })
  assert.match(adapter.discover().diagnostics.join('\n'), /64 MiB/u)
  db.prepare('UPDATE part SET data = ? WHERE id = ?').run('{bad', 'ses_large_part_2')
  await assert.rejects(adapter.load(largeRef), /invalid JSON/u)
  assert.match(adapter.discover().diagnostics.join('\n'), /invalid JSON/u)
  assert.equal((await adapter.scan()).length, 1, 'summary does not parse even malformed transcript JSON')
  checked()

  root = testRoot('metadata-bounds')
  db = database(join(root, 'opencode.db'))
  insertOpenCodeExport(db, createOpenCodeExport('ses_metadata', { title: '  Title\n with\tspaces  ' }))
  const metadataRef = (await adapter.scan())[0].ref
  assert.equal((await adapter.scan())[0].summary.title, 'Title with spaces')
  assert.equal((await adapter.load(metadataRef)).title, 'Title with spaces')
  db.prepare('UPDATE session SET directory = ?').run('/' + 'x'.repeat(4096))
  await assert.rejects(adapter.load(metadataRef), /directory limit/u)
  await assert.rejects(adapter.scan(), /directory limit/u)
  db.prepare('UPDATE session SET directory = ?, revert = ?').run('/synthetic', 'x'.repeat(65537))
  await assert.rejects(adapter.load(metadataRef), /revert metadata/u)
  db.prepare('UPDATE session SET revert = ?').run('')
  await assert.rejects(adapter.load(metadataRef), /invalid JSON/u)
  db.exec('ALTER TABLE session DROP COLUMN revert')
  await assert.rejects(adapter.scan(), /missing revert/u)
  checked()

  root = testRoot('abort-scale')
  db = database(join(root, 'opencode.db'))
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10001)
    INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
    SELECT printf('ses_%05d', i), 'project', 'slug', '/synthetic', 'Title', '1', i, i FROM n`)
  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  await assert.rejects(adapter.scan({ signal: alreadyAborted.signal }), { name: 'AbortError' })
  const duringScan = new AbortController()
  let observed = 0
  setImmediate(() => duringScan.abort())
  await assert.rejects(adapter.scan({ signal: duringScan.signal, onEntry() { observed++ } }), { name: 'AbortError' })
  assert.ok(observed > 0 && observed <= 32, 'scan yields and observes event-loop cancellation in bounded batches')
  // A cancelled iterator must release its read transaction/connection.
  assert.equal(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy, 0)
  assert.equal(adapter.count(), 10001)
  await assert.rejects(adapter.scan(), /10000-session limit/u)
  assert.match(adapter.discover().diagnostics.join('\n'), /10000-session limit/u)
  checked()

  // XDG_DATA_HOME is absolute-only (xdg-basedir behavior); OPENCODE_TEST_HOME
  // affects upstream's home helper, not the global XDG database directory.
  root = testRoot('xdg')
  process.env.OPENCODE_TEST_HOME = join(temp, 'not-xdg-home')
  assert.deepEqual(adapter.roots(), [root])
  process.env.XDG_DATA_HOME = 'relative-xdg-is-invalid'
  assert.deepEqual(adapter.roots(), [join(process.env.HOME, '.local', 'share', 'opencode')])
  checked()

  console.log(`OpenCode database regression: ${checks} groups passed`)
} finally {
  for (const db of handles) db.close()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  // The only recursively deleted path is the exact temp root created above.
  assert.equal(resolve(temp), temp)
  assert.equal(dirname(temp), realpathSync(tmpdir()))
  assert.ok(temp.includes('dsh-opencode-db-'))
  rmSync(temp, { recursive: true, force: true })
}

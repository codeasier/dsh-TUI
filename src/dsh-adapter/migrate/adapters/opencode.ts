/**
 * Read-only OpenCode SQLite migration. Schema/path contract verified against
 * anomalyco/opencode aec0b9a6d8898f68f923aaf08b7306d931fd9d76:
 * packages/core/src/{session/sql.ts,database/database.ts,global.ts}.
 * Only the v1 message/part payloads are imported; native session_message and
 * session_input rows must never be mistaken for an empty v1 transcript.
 */
import { existsSync, opendirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ForeignSessionSummary, LoadSkip, MigrationAdapter, MigrationDiscovery, MigrationSession, ScanEntry, ScanOptions } from '../types.js'
import { normalizeTitle } from '../parse/title.js'
import { parseOpenCodeExport } from './opencode.parse.js'

const require = createRequire(import.meta.url)
const MAX_SESSIONS = 10_000
const MAX_DATABASES = 32
const MAX_MESSAGES = 20_000
const MAX_PARTS = 100_000
const MAX_SESSION_BYTES = 64 * 1024 * 1024
const MAX_DISCOVERY_BYTES = 128 * 1024 * 1024
const NATIVE_ERROR = 'OpenCode native session_message/session_input storage is not supported; only v1 session/message/part SQLite transcripts are supported.'
const LEGACY_ERROR = 'OpenCode legacy JSON storage is not supported; only v1 session/message/part SQLite transcripts are supported.'
const ROOT_SESSIONS = 'parent_id IS NULL'
const DB_NAME = /^opencode(?:-[a-zA-Z0-9._-]+)?\.db$/u

type Row = Record<string, unknown>
interface Schema { readonly v1: boolean, readonly native: readonly string[] }
interface Store { readonly paths: readonly string[], readonly diagnostics: readonly string[] }

function dataRoot(): string {
  const xdg = process.env.XDG_DATA_HOME
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'share'), 'opencode')
}

function configuredDatabase(): string | undefined {
  const value = process.env.OPENCODE_DB
  if (!value) return undefined
  return value === ':memory:' ? value : resolve(dataRoot(), value)
}

/** Channel is a compiled OpenCode constant, not an environment variable.
 * Enumerate its sanitized channel filenames rather than invent OPENCODE_CHANNEL. */
function stores(): Store {
  const explicit = configuredDatabase()
  if (explicit === ':memory:') return { paths: [], diagnostics: ['OpenCode OPENCODE_DB=:memory: cannot be migrated from another process.'] }
  if (explicit) return { paths: existsSync(explicit) ? [explicit] : [], diagnostics: [] }
  const root = dataRoot()
  const paths: string[] = []
  const diagnostics: string[] = []
  let directory
  try { directory = opendirSync(root) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostics.push('OpenCode data directory cannot be read.')
    return { paths, diagnostics }
  }
  try {
    let examined = 0
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (++examined > 4096) throw new Error('OpenCode data directory exceeds the 4096-entry discovery limit.')
      if (!DB_NAME.test(entry.name) || (!entry.isFile() && !entry.isSymbolicLink())) continue
      // Even a forged locator or a symlink cannot open an unrelated database.
      const path = join(root, entry.name)
      if (dirname(realpathSync(path)) !== realpathSync(root)) {
        diagnostics.push(`OpenCode database symlink outside the configured data root was ignored: ${entry.name}`)
        continue
      }
      paths.push(path)
      if (paths.length > MAX_DATABASES) throw new Error(`OpenCode exceeds the ${MAX_DATABASES}-database discovery limit.`)
    }
  } catch (error) {
    diagnostics.push(describe(error))
  } finally { directory.closeSync() }
  if (!paths.length && existsSync(join(root, 'storage', 'session'))) diagnostics.push(LEGACY_ERROR)
  return { paths: paths.slice(0, MAX_DATABASES).sort(), diagnostics }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'OpenCode database could not be read.'
}

function openSnapshot(path: string): DatabaseSync {
  // Do not load node:sqlite (and emit its experimental warning on Node 22)
  // merely because the migration registry is imported during TUI startup.
  const { DatabaseSync: SQLite } = require('node:sqlite') as typeof import('node:sqlite')
  const db = new SQLite(path, { readOnly: true, enableDoubleQuotedStringLiterals: false })
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 100; BEGIN')
    return db
  } catch (error) { db.close(); throw error }
}

function schema(db: DatabaseSync): Schema {
  const names = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' LIMIT 129").all().map(row => row.name))
  if (names.size > 128) throw new Error('OpenCode database exceeds the 128-table schema limit.')
  const check = (table: string, required: readonly string[]): Set<string> => {
    if (!names.has(table)) throw new Error(`Unsupported OpenCode SQLite schema: missing ${table} table.`)
    // Table names are fixed constants here, never source-controlled SQL.
    const columns = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(row => String(row.name)))
    const absent = required.filter(column => !columns.has(column))
    if (absent.length) throw new Error(`Malformed OpenCode SQLite schema: ${table} is missing ${absent.join(', ')}.`)
    return columns
  }
  check('session', ['id', 'parent_id', 'title', 'directory', 'time_created', 'time_updated', 'revert'])
  const native = ['session_message', 'session_input'].filter(name => names.has(name))
  for (const table of native) check(table, ['session_id'])
  const v1 = names.has('message') || names.has('part')
  if (v1) {
    check('message', ['id', 'session_id', 'time_created', 'data'])
    check('part', ['id', 'message_id', 'session_id', 'data'])
  } else if (!native.length) {
    throw new Error('Unsupported OpenCode SQLite schema: expected message/part or native session_message/session_input tables.')
  }
  return { v1, native }
}

function snapshot<T>(path: string, fn: (db: DatabaseSync, shape: Schema) => T): T {
  const db = openSnapshot(path)
  try { return fn(db, schema(db)) } finally { db.close() }
}

function nativeSession(db: DatabaseSync, shape: Schema, id: string): boolean {
  return shape.native.some(table => db.prepare(`SELECT 1 FROM "${table}" WHERE session_id = ? LIMIT 1`).get(id) !== undefined)
}

function locator(path: string, id: string): string {
  return `opencode-db:${Buffer.from(JSON.stringify([path, id])).toString('base64url')}`
}

function decodeLocator(ref: string): { path: string, id: string } {
  if (ref.length > 16_384 || !/^opencode-db:[A-Za-z0-9_-]+$/u.test(ref)) throw new Error('Invalid OpenCode database session locator.')
  let value: unknown
  try { value = JSON.parse(Buffer.from(ref.slice('opencode-db:'.length), 'base64url').toString('utf8')) } catch { throw new Error('Invalid OpenCode database session locator.') }
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || !validId(value[1])) throw new Error('Invalid OpenCode database session locator.')
  const [path, id] = value as [string, string]
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Invalid OpenCode database path.')
  const explicit = configuredDatabase()
  if (explicit ? path !== explicit : dirname(path) !== dataRoot() || !DB_NAME.test(path.slice(dirname(path).length + 1))) {
    throw new Error('OpenCode database locator is outside the configured roots.')
  }
  if (!explicit && existsSync(path) && dirname(realpathSync(path)) !== realpathSync(dataRoot())) throw new Error('OpenCode database locator resolves outside the configured roots.')
  return { path, id }
}

function validId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 512 && !/[\u0000-\u001f]/u.test(id)
}

function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Malformed OpenCode session timestamp.')
  return value
}

function summary(path: string, row: Row): ForeignSessionSummary {
  if (!validId(row.id) || typeof row.title !== 'string' || typeof row.directory !== 'string') throw new Error('Malformed OpenCode session metadata.')
  if (row.title.length > 65536 || row.directory.length > 4096) throw new Error('OpenCode session metadata exceeds the 64 KiB title / 4096-character directory limit.')
  return {
    agentId: 'opencode', sessionKey: row.id, ref: locator(path, row.id),
    title: normalizeTitle(row.title), cwd: row.directory,
    createdAt: timestamp(row.time_created), lastMessageAt: timestamp(row.time_updated),
  }
}

function sessionRows(db: DatabaseSync) {
  // No message JSON, joins or database-wide sort. Bound strings before they
  // cross the SQLite/JS boundary; the browser sorts the resulting summaries.
  return db.prepare(`SELECT substr(id, 1, 513) AS id, substr(title, 1, 65537) AS title, substr(directory, 1, 4097) AS directory,
    time_created, time_updated FROM session WHERE ${ROOT_SESSIONS} LIMIT ${MAX_SESSIONS + 1}`).iterate()
}

function jsonObject(value: unknown, context: string): Row {
  if (typeof value !== 'string') throw new Error(`Malformed OpenCode ${context}: expected JSON text.`)
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error(`Malformed OpenCode ${context}: invalid JSON.`) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Malformed OpenCode ${context}: expected JSON object.`)
  return parsed as Row
}

function loadSession(db: DatabaseSync, shape: Schema, id: string): { session: MigrationSession | LoadSkip, bytes: number } {
  const row = db.prepare(`SELECT id, substr(title, 1, 65537) AS title, substr(directory, 1, 4097) AS directory,
    parent_id, time_created, time_updated, substr(revert, 1, 65537) AS revert FROM session WHERE id = ?`).get(id)
  if (!row) return { session: { skip: 'missing' }, bytes: 0 }
  if (row.parent_id !== null) return { session: { skip: 'not-a-session' }, bytes: 0 }
  if (!shape.v1 || nativeSession(db, shape, id)) throw new Error(NATIVE_ERROR)
  summary('', row) // Validate metadata before handing it to the pure parser.
  if (typeof row.revert === 'string' && row.revert.length > 65536) throw new Error('OpenCode session revert metadata exceeds the 64 KiB limit.')
  let bytes = 0
  for (const [table, limit] of [['message', MAX_MESSAGES], ['part', MAX_PARTS]] as const) {
    const size = db.prepare(`SELECT count(*) AS n, coalesce(sum(nbytes), 0) AS bytes FROM
      (SELECT length(CAST(data AS BLOB)) AS nbytes FROM "${table}" WHERE session_id = ? LIMIT ${limit + 1})`).get(id)
    if (!size || Number(size.n) > limit) return { session: { skip: 'too-large' }, bytes: 0 }
    bytes += Number(size.bytes)
  }
  if (bytes > MAX_SESSION_BYTES) return { session: { skip: 'too-large' }, bytes: 0 }
  const messages: { info: Row, parts: Row[] }[] = []
  const byId = new Map<string, { info: Row, parts: Row[] }>()
  for (const message of db.prepare('SELECT substr(id, 1, 513) AS id, data FROM message WHERE session_id = ? ORDER BY message.time_created, message.id').iterate(id)) {
    if (!validId(message.id)) throw new Error('Malformed OpenCode message id.')
    const entry = { info: { ...jsonObject(message.data, 'message'), id: message.id, sessionID: id }, parts: [] as Row[] }
    messages.push(entry)
    byId.set(message.id, entry)
  }
  for (const part of db.prepare('SELECT substr(id, 1, 513) AS id, substr(message_id, 1, 513) AS message_id, data FROM part WHERE session_id = ? ORDER BY part.id').iterate(id)) {
    if (!validId(part.id) || !validId(part.message_id)) throw new Error('Malformed OpenCode part identity.')
    const message = byId.get(part.message_id)
    if (!message) throw new Error('Malformed OpenCode part references a missing message.')
    message.parts.push({ ...jsonObject(part.data, 'part'), id: part.id, messageID: part.message_id, sessionID: id })
  }
  const info = {
    id, title: row.title, directory: row.directory,
    time: { created: row.time_created, updated: row.time_updated },
    ...(row.revert !== null ? { revert: jsonObject(row.revert, 'session revert') } : {}),
  }
  return { session: parseOpenCodeExport({ info, messages }) ?? { skip: 'not-a-session' }, bytes }
}

export const opencodeAdapter: MigrationAdapter = {
  id: 'opencode',
  label: 'OpenCode',
  roots: () => [configuredDatabase() ?? dataRoot()],
  count(): number {
    let count = 0
    for (const path of stores().paths) {
      try { count += snapshot(path, db => Number(db.prepare(`SELECT count(*) AS n FROM session WHERE ${ROOT_SESSIONS}`).get()?.n ?? 0)) } catch { /* Selection reports the diagnostic, not the all-source picker. */ }
    }
    return count
  },
  hasSessions(): boolean {
    const store = stores()
    if (store.diagnostics.length) return true
    for (const path of store.paths) {
      try {
        if (snapshot(path, db => db.prepare(`SELECT 1 FROM session WHERE ${ROOT_SESSIONS} LIMIT 1`).get() !== undefined)) return true
      } catch { return true }
    }
    return false
  },
  newestActivity(): number | null {
    let newest: number | null = null
    for (const path of stores().paths) {
      try {
        const value = snapshot(path, db => db.prepare(`SELECT max(time_updated) AS time FROM session WHERE ${ROOT_SESSIONS}`).get()?.time)
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) newest = Math.max(newest ?? 0, value)
      } catch { /* Unknown or unreadable stores have no usable activity. */ }
    }
    return newest
  },
  discover(): MigrationDiscovery {
    const store = stores()
    const diagnostics = [...store.diagnostics]
    const sessions: MigrationSession[] = []
    let total = 0
    let bytes = 0
    for (const path of store.paths) {
      try {
        snapshot(path, (db, shape) => {
          const failures = new Map<string, number>()
          for (const row of sessionRows(db)) {
            if (++total > MAX_SESSIONS) throw new Error(`OpenCode discovery exceeds the ${MAX_SESSIONS}-session limit.`)
            try {
              if (!validId(row.id)) throw new Error('Malformed OpenCode session id.')
              const loaded = loadSession(db, shape, row.id)
              bytes += loaded.bytes
              if (bytes > MAX_DISCOVERY_BYTES) throw new Error('OpenCode discovery exceeds the 128 MiB transcript limit; import individual sessions instead.')
              if ('skip' in loaded.session) {
                if (loaded.session.skip === 'too-large') throw new Error('OpenCode session exceeds the 64 MiB / 20000-message / 100000-part import limit.')
              } else sessions.push(loaded.session)
            } catch (error) {
              const reason = describe(error)
              failures.set(reason, (failures.get(reason) ?? 0) + 1)
              if (bytes > MAX_DISCOVERY_BYTES) break
            }
          }
          for (const [reason, n] of failures) diagnostics.push(`${n} session(s): ${reason}`)
        })
      } catch (error) { diagnostics.push(describe(error)) }
      if (total > MAX_SESSIONS || bytes > MAX_DISCOVERY_BYTES) break
    }
    return { roots: this.roots(), sessions, diagnostics }
  },
  async scan(options?: ScanOptions): Promise<readonly ScanEntry[]> {
    options?.signal?.throwIfAborted()
    const store = stores()
    if (store.diagnostics.length) throw new Error(store.diagnostics.join('\n'))
    const entries: ScanEntry[] = []
    for (const path of store.paths) {
      options?.signal?.throwIfAborted()
      const db = openSnapshot(path)
      try {
        schema(db)
        for (const row of sessionRows(db)) {
          options?.signal?.throwIfAborted()
          if (entries.length >= MAX_SESSIONS) throw new Error(`OpenCode summary scan exceeds the ${MAX_SESSIONS}-session limit.`)
          const item = summary(path, row)
          // Deliberately bypass options.cached: DB mtime/size miss WAL commits.
          entries.push({ ref: item.ref, fp: { mtimeMs: item.lastMessageAt, size: 0 }, summary: item })
          options?.onEntry?.(item)
          if (entries.length % 32 === 0) {
            await new Promise<void>(resolve => setImmediate(resolve))
            options?.signal?.throwIfAborted()
          }
        }
      } finally { db.close() }
    }
    return entries
  },
  async load(ref: string): Promise<MigrationSession | LoadSkip> {
    const { path, id } = decodeLocator(ref)
    if (!existsSync(path)) return { skip: 'missing' }
    if (!statSync(path).isFile()) throw new Error('OpenCode database locator is not a regular file.')
    return snapshot(path, (db, shape) => loadSession(db, shape, id).session)
  },
}

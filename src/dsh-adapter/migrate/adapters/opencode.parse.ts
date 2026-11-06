/**
 * Pure parser for OpenCode's v1 export, verified against 1.18.34 / commit
 * aec0b9a6d8898f68f923aaf08b7306d931fd9d76 in anomalyco/opencode:
 * packages/opencode/src/session/{message-v2,revert,compaction,session}.ts.
 *
 * An export is a storage snapshot, NOT model context. Apply revert first,
 * then project the latest successful compaction to summary + tail + later.
 * Discarded history never enters the destination log. ImportCompaction's
 * existing headless fallback carries the summary; no tail-specific session
 * events or invented source messages are needed.
 *
 * Child sessions (session.parentID) are excluded, never flattened. Forks are
 * independent roots upstream and import their copied history. Assistant
 * parentID, by contrast, links a reply to a USER MESSAGE in this session.
 * Files/media are descriptive placeholders only; resolved text/plain and
 * directory file parts are ignored as upstream does. No URI, snapshot, patch,
 * tool, subagent, provider metadata, credentials or permission is executed or
 * restored. Snapshot/patch/retry/agent parts are non-model metadata and omitted;
 * subtask parts retain upstream's historical marker, not an executable task.
 * Unknown parts/statuses or ambiguous boundaries fail closed with an Error.
 */
import { isRecord, type JsonRecord } from '../parse/jsonl.js'
import { emptyStats } from '../parse/role-turns.js'
import { normalizeTitle } from '../parse/title.js'
import { clampToolText, closeToolPairs, newStep } from '../parse/tools.js'
import type { ImportCompaction, ImportStats, ImportStep, ImportTurn, MigrationSession } from '../types.js'

interface Message {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly info: JsonRecord
  readonly parts: JsonRecord[]
  readonly parentID?: string
}

function invalid(detail: string): never {
  throw new Error(`OpenCode: ${detail}`)
}

function record(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) invalid(`${field} must be an object`)
  return value
}

function text(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) invalid(`${field} must be a string${allowEmpty ? '' : ' (non-empty)'}`)
  return value
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(`${field} must be a non-negative finite timestamp`)
  return value
}

function optionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'boolean') invalid(`${field} must be a boolean`)
}

const partTypes = new Set(['text', 'reasoning', 'tool', 'file', 'step-start', 'step-finish', 'compaction', 'subtask', 'snapshot', 'patch', 'retry', 'agent'])
const metadataParts = new Set(['snapshot', 'patch', 'retry', 'agent'])

function readMessages(values: unknown[], sessionID: string): Message[] {
  const messages: Message[] = []
  const ids = new Map<string, Message>()
  const partIds = new Set<string>()
  let previousTime = -1
  for (const value of values) {
    const row = record(value, 'message')
    const info = record(row.info, 'message.info')
    const id = text(info.id, 'message.info.id')
    if (ids.has(id)) invalid(`duplicate message id ${id}`)
    if (info.sessionID !== sessionID) invalid(`message ${id} has a different sessionID`)
    const role = info.role
    if (role !== 'user' && role !== 'assistant') invalid(`message ${id} has unsupported role`)
    const created = timestamp(record(info.time, `message ${id}.time`).created, `message ${id}.time.created`)
    if (created < previousTime) invalid('messages must be in chronological export order')
    previousTime = created
    if (!Array.isArray(row.parts)) invalid(`message ${id}.parts must be an array`)
    const parts = row.parts.map(value => {
      const part = record(value, `message ${id} part`)
      const partID = text(part.id, `message ${id} part.id`)
      if (partIds.has(partID)) invalid(`duplicate part id ${partID}`)
      partIds.add(partID)
      if (part.messageID !== id || part.sessionID !== sessionID) invalid(`part ${partID} has mismatched messageID/sessionID`)
      text(part.type, `part ${partID}.type`)
      return part
    })
    const parentID = role === 'assistant' ? text(info.parentID, `assistant ${id}.parentID`) : undefined
    if (parentID !== undefined && ids.get(parentID)?.role !== 'user') invalid(`assistant ${id}.parentID must reference an earlier user message`)
    if (role === 'assistant') {
      optionalBoolean(info.summary, `assistant ${id}.summary`)
      if (info.finish !== undefined) text(info.finish, `assistant ${id}.finish`)
      if (info.error !== undefined) text(record(info.error, `assistant ${id}.error`).name, `assistant ${id}.error.name`)
    }
    const message: Message = { id, role, info, parts, parentID }
    ids.set(id, message)
    messages.push(message)
  }
  return messages
}

/** Mirror SessionRevert.cleanup without mutating the source or its snapshots. */
function applyRevert(messages: Message[], value: unknown): Message[] {
  if (value === undefined) return messages
  const revert = record(value, 'session.revert')
  const messageID = text(revert.messageID, 'revert.messageID')
  const index = messages.findIndex(message => message.id === messageID)
  if (index < 0) invalid(`revert.messageID ${messageID} was not found`)
  if (revert.partID === undefined) return messages.slice(0, index)
  const partID = text(revert.partID, 'revert.partID')
  const target = messages[index]!
  const partIndex = target.parts.findIndex(part => part.id === partID)
  if (partIndex < 0) invalid(`revert.partID ${partID} was not found in ${messageID}`)
  if (target.role === 'assistant' && target.info.summary === true) invalid('revert inside a compaction summary is unsupported')
  return [...messages.slice(0, index), { ...target, parts: target.parts.slice(0, partIndex) }]
}

function successfulSummary(message: Message): boolean {
  return message.role === 'assistant' && message.info.summary === true && Boolean(message.info.finish) && message.info.error === undefined
}

/** Select the same successful boundary and retained span as filterCompacted. */
function effectiveContext(messages: Message[]): { messages: Message[], compaction?: ImportCompaction } {
  const indices = new Map(messages.map((message, index) => [message.id, index]))
  const checkpoints = new Map<string, JsonRecord>()
  for (const message of messages) {
    const parts = message.parts.filter(part => part.type === 'compaction')
    if (!parts.length) continue
    if (message.role !== 'user' || parts.length !== 1) invalid(`message ${message.id} has an ambiguous compaction boundary`)
    const part = parts[0]!
    if (typeof part.auto !== 'boolean') invalid(`compaction ${message.id}.auto must be a boolean`)
    optionalBoolean(part.overflow, `compaction ${message.id}.overflow`)
    if (part.tail_start_id !== undefined) {
      const tailID = text(part.tail_start_id, 'compaction.tail_start_id')
      const tailIndex = indices.get(tailID)
      if (tailIndex === undefined || tailIndex >= indices.get(message.id)!) invalid(`compaction.tail_start_id ${tailID} must reference an earlier message`)
    }
    checkpoints.set(message.id, part)
  }
  let latest: { user: number, summary: number, part: JsonRecord } | undefined
  const completed = new Set<string>()
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'assistant' || message.info.summary !== true) continue
    const part = checkpoints.get(message.parentID!)
    if (!part) invalid(`summary ${message.id} has no compaction user parent`)
    if (!successfulSummary(message)) continue
    if (completed.has(message.parentID!)) invalid(`multiple successful summaries for compaction ${message.parentID}`)
    completed.add(message.parentID!)
    const user = indices.get(message.parentID!)!
    if (!latest || user > latest.user) latest = { user, summary: index, part }
  }
  if (!latest) return { messages }
  const { user, summary, part } = latest
  if (messages[user]!.parts.some(item => item.type !== 'compaction' && !metadataParts.has(String(item.type)))) {
    invalid('successful compaction request contains additional semantic content')
  }
  // A concurrent unrelated conversation between request and summary cannot be
  // represented by a single checkpoint without changing its order/meaning.
  if (messages.slice(user + 1, summary).some(message => message.role !== 'assistant' || message.parentID !== messages[user]!.id || message.info.summary !== true)) {
    invalid('interleaved messages inside a successful compaction are unsupported')
  }
  const summaryMessage = messages[summary]!
  if (summaryMessage.parts.some(part => !['text', 'reasoning', 'step-start', 'step-finish', 'snapshot', 'patch', 'retry'].includes(String(part.type)))) {
    invalid('successful compaction summary contains unsupported non-text content')
  }
  const summaryText = summaryMessage.parts.filter(part => part.type === 'text')
    .map(part => text(part.text, 'compaction summary text', true).trim()).filter(Boolean).join('\n\n')
  if (!summaryText) invalid('successful compaction summary is empty')
  const tail = part.tail_start_id === undefined ? [] : messages.slice(indices.get(String(part.tail_start_id))!, user)
  return {
    messages: [...tail, ...messages.slice(summary + 1)],
    compaction: { summary: summaryText, model: modelOf(summaryMessage) },
  }
}

function modelOf(message: Message): string | undefined {
  if (message.info.modelID === undefined) return undefined
  return text(message.info.modelID, `assistant ${message.id}.modelID`)
}

function attachmentNote(value: unknown): string {
  const attachment = record(value, 'attachment')
  const mime = text(attachment.mime, 'attachment.mime')
  const filename = attachment.filename === undefined ? 'file' : text(attachment.filename, 'attachment.filename', true)
  // Deliberately do not inspect url/source (including data URLs and file URIs).
  return `[Attached ${mime}: ${filename}]`
}

function toolPart(part: JsonRecord, step: ImportStep, turn: ImportTurn, calls: Set<string>): void {
  const callId = text(part.callID, 'tool.callID')
  if (calls.has(callId)) invalid(`duplicate tool callID ${callId}`)
  calls.add(callId)
  const name = text(part.tool, 'tool.tool')
  const state = record(part.state, `tool ${callId}.state`)
  const input = record(state.input, `tool ${callId}.state.input`)
  let args: string
  try {
    args = JSON.stringify(input)
  } catch {
    invalid(`tool ${callId}.state.input must be JSON serializable`)
  }
  let output: string
  let isError = false
  switch (state.status) {
    case 'completed': {
      const time = record(state.time, `tool ${callId}.state.time`)
      if (time.compacted !== undefined) timestamp(time.compacted, `tool ${callId}.state.time.compacted`)
      // A pruned result MUST NOT resurrect output or attachments still on disk.
      if (time.compacted) output = '[Old tool result content cleared]'
      else {
        output = text(state.output, `tool ${callId}.state.output`, true)
        if (state.attachments !== undefined) {
          if (!Array.isArray(state.attachments)) invalid(`tool ${callId}.state.attachments must be an array`)
          output = [output, ...state.attachments.map(attachmentNote)].filter(Boolean).join('\n')
        }
      }
      break
    }
    case 'error': {
      const metadata = state.metadata === undefined ? undefined : record(state.metadata, `tool ${callId}.state.metadata`)
      // OpenCode preserves interrupted tool output when explicitly recorded.
      if (metadata?.interrupted === true && typeof metadata.output === 'string') output = metadata.output
      else {
        output = text(state.error, `tool ${callId}.state.error`, true)
        isError = true
      }
      break
    }
    case 'pending':
    case 'running':
      output = '[Tool execution was interrupted]'
      isError = true
      turn.aborted = true
      break
    default:
      invalid(`tool ${callId} has unsupported status`)
  }
  step.blocks.push({ type: 'tool-call', id: callId, name, arguments: args })
  step.results.push({ callId, text: clampToolText(output), isError })
}

/**
 * Parse an official `{ info, messages: [{ info, parts }] }` export without I/O.
 * Returns undefined for unrelated values, child sessions or empty effective
 * conversations. Recognized malformed exports/unsupported boundaries throw;
 * callers must report that diagnostic, not retry with the raw history.
 */
export function parseOpenCodeExport(value: unknown): MigrationSession | undefined {
  if (!isRecord(value) || (!('info' in value) && !('messages' in value))) return undefined
  const info = record(value.info, 'session.info')
  const sourceId = text(info.id, 'session.info.id')
  const cwd = text(info.directory, 'session.info.directory')
  const time = record(info.time, 'session.info.time')
  const startedAt = timestamp(time.created, 'session.info.time.created')
  timestamp(time.updated, 'session.info.time.updated')
  if (!Array.isArray(value.messages)) invalid('session.messages must be an array')
  if (info.parentID !== undefined) {
    text(info.parentID, 'session.info.parentID')
    return undefined
  }
  const rawMessages = readMessages(value.messages, sourceId)
  const active = applyRevert(rawMessages, info.revert)
  const projected = effectiveContext(active)
  const stats: ImportStats = emptyStats()
  stats.filtered = rawMessages.length - projected.messages.length
  const turns: ImportTurn[] = []
  const userTurns = new Map<string, ImportTurn>()
  const activeIds = new Set(projected.messages.map(message => message.id))
  let current: ImportTurn | undefined
  for (const message of projected.messages) {
    for (const part of message.parts) {
      if (!partTypes.has(String(part.type))) invalid(`part ${String(part.id)} has unsupported type ${String(part.type)}`)
    }
    if (message.role === 'user') {
      const pieces: string[] = []
      for (const part of message.parts) {
        if (part.type === 'text') {
          optionalBoolean(part.ignored, 'text.ignored')
          const content = text(part.text, 'text.text', true)
          if (part.ignored) stats.filtered += 1
          else if (content) pieces.push(content)
        } else if (part.type === 'file') {
          const mime = text(part.mime, 'file.mime')
          if (mime !== 'text/plain' && mime !== 'application/x-directory') pieces.push(attachmentNote(part))
          else stats.filtered += 1
        } else if (part.type === 'compaction') pieces.push('What did we do so far?')
        else if (part.type === 'subtask') pieces.push('The following tool was executed by the user')
        else if (metadataParts.has(String(part.type))) stats.filtered += 1
        else invalid(`user message ${message.id} contains unsupported ${String(part.type)} part`)
      }
      current = { prompt: pieces.join('\n'), steps: [] }
      turns.push(current)
      userTurns.set(message.id, current)
      continue
    }
    const error = message.info.error
    if (error !== undefined) {
      const aborted = record(error, 'assistant.error').name === 'MessageAbortedError'
      if (!aborted || !message.parts.some(part => part.type !== 'step-start' && part.type !== 'reasoning')) {
        stats.filtered += 1
        continue
      }
    }
    let turn = userTurns.get(message.parentID!)
    if (turn === undefined) {
      // select/splitTurn can retain an assistant whose user was compacted away.
      if (!projected.compaction || activeIds.has(message.parentID!)) invalid(`assistant ${message.id} has no effective user parent`)
      if (current !== undefined) invalid(`assistant ${message.id} crosses effective user turns`)
      turn = { prompt: '', steps: [] }
      turns.push(turn)
      userTurns.set(message.parentID!, turn)
      current = turn
    }
    if (turn !== current) invalid(`assistant ${message.id} crosses user turns`)
    if (error !== undefined) turn.aborted = true
    let step = newStep(modelOf(message))
    const calls = new Set<string>()
    const flush = (): void => {
      if (step.blocks.length > 0) turn.steps.push(step)
      step = newStep(modelOf(message))
      calls.clear()
    }
    for (const part of message.parts) {
      if (part.type === 'step-start' || part.type === 'step-finish') flush()
      else if (part.type === 'text' || part.type === 'reasoning') {
        const content = text(part.text, `${String(part.type)}.text`, true)
        if (content !== '') step.blocks.push({ type: part.type, text: content })
      } else if (part.type === 'tool') toolPart(part, step, turn, calls)
      else if (metadataParts.has(String(part.type)) || part.type === 'file') stats.filtered += 1
      else invalid(`assistant ${message.id} contains unsupported ${String(part.type)} part`)
    }
    flush()
  }
  const kept = turns.filter(turn => turn.prompt !== '' || turn.steps.length > 0)
  if (projected.compaction) {
    if (!kept.length) kept.push({ prompt: '', steps: [] })
    kept[0]!.compaction = projected.compaction
  }
  if (!kept.length) return undefined
  // OpenCode may reuse call IDs after a step settles; DSH indexes them across
  // the session. Rename collisions together with their already-paired results.
  stats.droppedToolResults = closeToolPairs(kept)
  const ownTitle = normalizeTitle(info.title === undefined ? undefined : text(info.title, 'session.info.title', true))
  const title = ownTitle || normalizeTitle(kept.find(turn => turn.prompt)?.prompt)
  return { sourceId, cwd, title: title || undefined, titleExplicit: ownTitle !== '', startedAt, turns: kept, stats }
}

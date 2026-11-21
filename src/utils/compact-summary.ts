// dsh-compaction-basic's frameSummary framing, also used by migrated checkpoints.
// Keep this display-only: the model context and search still need the raw text.
const PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'
const OPEN_TAG = '<compacted-summary>'
const CLOSE_TAG = '</compacted-summary>'
const PREFIX = `${PREAMBLE}\n\n${OPEN_TAG}`

/** Unwrap known complete checkpoints for display; ambiguous or empty input stays raw. */
export function compactSummaryDisplayText(raw: string): string {
  if (!raw.startsWith(PREFIX) || !raw.endsWith(CLOSE_TAG)) return raw
  const body = raw.slice(PREFIX.length, -CLOSE_TAG.length)
  if (!body.trim() || body.includes(OPEN_TAG) || body.includes(CLOSE_TAG)) return raw
  return body
}

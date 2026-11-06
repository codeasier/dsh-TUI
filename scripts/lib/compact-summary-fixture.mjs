// Independent fixture copied from installed dsh-compaction-basic@0.2.0-rc.2
// lib/index.js: frameSummary preserves each body block between opener and closer.
// Do not derive expected display text from the product helper under test.
export const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'
export const SUMMARY_OPEN_TAG = '<compacted-summary>'
export const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** @param {...string} bodyBlocks */
export function frameCompactSummary(...bodyBlocks) {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...bodyBlocks.map(text => ({ type: 'text', text })),
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

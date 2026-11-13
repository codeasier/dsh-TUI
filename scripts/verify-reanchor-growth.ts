/**
 * Pure LogUpdate regression: an inline dock closing in the same paint as a
 * tool + async question must not discard newly arrived rows above the final
 * viewport. No React scheduler, reveal cache, backend, or wall-clock waits.
 * Run: node --import tsx/esm scripts/verify-reanchor-growth.ts
 */
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import type { Terminal as XTermInstance } from '@xterm/headless'
import { emptyFrame, type Frame } from '../src/ink/frame.js'
import { LogUpdate } from '../src/ink/log-update.js'
import Output from '../src/ink/output.js'
import { CharPool, HyperlinkPool, StylePool, createScreen } from '../src/ink/screen.js'
import { serializeDiff } from '../src/ink/terminal.js'

const { Terminal: XTerm } = await import('@xterm/headless')

const rows = 30
const styles = new StylePool()
const chars = new CharPool()
const links = new HyperlinkPool()
const sink = new PassThrough()
sink.resume()
const streams = { stdout: sink, stderr: sink }
const label = (prefix: string, y: number): string => `${prefix}-${String(y).padStart(2, '0')}`

function frame(lines: string[], columns: number): Frame {
  const screen = createScreen(columns, lines.length, styles, chars, links)
  const output = new Output({ width: columns, height: lines.length, stylePool: styles, screen })
  output.write(0, 0, lines.join('\n'))
  output.get()
  return { screen, viewport: { width: columns, height: rows }, cursor: { x: 0, y: lines.length, visible: false } }
}

function bufferLines(term: XTermInstance): string[] {
  const buffer = term.buffer.active
  return Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '')
}

const parse = (term: XTermInstance, text: string): Promise<void> => new Promise(resolve => term.write(text, resolve))

for (const columns of [40, 24]) {
  const oldLines = Array.from({ length: 50 }, (_, y) => label('old', y))
  const newLines = Array.from({ length: 79 }, (_, y) => y < 43 ? oldLines[y]! : label('new', y))
  newLines[48] = '$ sleep 30'
  // Coalesced requests keep the last caller's policy (an explicit rewrite
  // can supersede a dock change, or a later dock change can preserve growth).
  // The last case models the dock effect followed by Chat's coupon effect:
  // both are lifecycle requests and must preserve newly arrived transcript.
  for (const requests of [[false], [true], [true, false], [false, true], [true, true]]) {
    const preserveGrowth = requests.at(-1)!
    const term = new XTerm({ cols: columns, rows, scrollback: 200, allowProposedApi: true })
    try {
      const log = new LogUpdate({ isTTY: true, stylePool: styles })
      const prev = frame(oldLines, columns)
      const next = frame(newLines, columns)
      await parse(term, serializeDiff(streams, log.render(emptyFrame(rows, columns, styles, chars, links), prev)))
      const oldBase = term.buffer.active.baseY
      for (const preserveGrowth of requests) log.requestViewportReanchor({ preserveGrowth })
      const bytes = serializeDiff(streams, log.render(prev, next))
      await parse(term, bytes)
      const painted = bufferLines(term)
      assert.deepEqual(painted.slice(term.buffer.active.baseY, term.buffer.active.baseY + rows - 1), newLines.slice(-29))
      if (preserveGrowth) {
        // Includes rows 43..49 replacing the old chrome, not just rows
        // appended beyond prev.height. The title at 48 must reach scrollback.
        assert.equal(painted.filter(value => value === '$ sleep 30').length, 1, `${columns}c: the first-paint title reaches native scrollback`)
        for (const line of newLines) assert.equal(painted.filter(value => value === line).length, 1, `${columns}c: ${line} is painted exactly once`)
        assert.equal(term.buffer.active.baseY, oldBase + newLines.length - oldLines.length)
        assert(bytes.includes('\n'), 'incremental growth creates native scrollback')
      } else {
        // Ctrl+O / explicit rewrites retain their old no-deposit tail policy.
        assert.equal(term.buffer.active.baseY, oldBase)
        assert(!painted.includes('$ sleep 30'), 'control reproduces the lost first-paint title')
        assert(!bytes.includes('\n'), 'explicit rewrites do not deposit duplicated history')
      }
    } finally {
      term.dispose()
    }
  }

  // A prior shrink strands extra rows in native scrollback (anchoredPad >
  // the height-derived offset). Growth recovery must also work from there,
  // including a subsequent sparse diff after the one-shot reanchor is spent.
  {
    const term = new XTerm({ cols: columns, rows, scrollback: 200, allowProposedApi: true })
    try {
      const log = new LogUpdate({ isTTY: true, stylePool: styles })
      const tall = frame(Array.from({ length: 55 }, (_, y) => label('old', y)), columns)
      const prev = frame(oldLines, columns)
      const next = frame(newLines, columns)
      await parse(term, serializeDiff(streams, log.render(emptyFrame(rows, columns, styles, chars, links), tall)))
      await parse(term, serializeDiff(streams, log.render(tall, prev)))
      assert.equal(term.buffer.active.baseY, 26, 'shrink keeps its stranded scrollback rows')
      log.requestViewportReanchor({ preserveGrowth: true })
      await parse(term, serializeDiff(streams, log.render(prev, next)))
      let painted = bufferLines(term)
      for (const line of newLines.slice(43)) assert.equal(painted.filter(value => value === line).length, 1, `${columns}c anchored shrink: ${line} is preserved once`)
      assert.deepEqual(painted.slice(term.buffer.active.baseY, term.buffer.active.baseY + rows - 1), newLines.slice(-29))
      const editedLines = [...newLines]
      editedLines[70] = 'sparse-edit-70'
      await parse(term, serializeDiff(streams, log.render(next, frame(editedLines, columns))))
      painted = bufferLines(term)
      assert.deepEqual(painted.slice(term.buffer.active.baseY, term.buffer.active.baseY + rows - 1), editedLines.slice(-29))
      assert.equal(painted.filter(value => value === '$ sleep 30').length, 1)
    } finally {
      term.dispose()
    }
  }

  // v0.20 bottom-anchors short full repaints. Preserving growth must keep
  // that mapping both while the new frame still fits and after it overflows.
  for (const height of [20, 40]) {
    const term = new XTerm({ cols: columns, rows, scrollback: 200, allowProposedApi: true })
    try {
      const log = new LogUpdate({ isTTY: true, stylePool: styles })
      const shortLines = Array.from({ length: 10 }, (_, y) => label('short', y))
      const lines = Array.from({ length: height }, (_, y) => shortLines[y] ?? label('grown', y))
      const prev = frame(shortLines, columns)
      await parse(term, serializeDiff(streams, log.render(emptyFrame(rows, columns, styles, chars, links), prev)))
      log.requestViewportReanchor({ preserveGrowth: true })
      await parse(term, serializeDiff(streams, log.render(prev, frame(lines, columns))))
      const painted = bufferLines(term)
      const visible = painted.slice(term.buffer.active.baseY, term.buffer.active.baseY + rows)
      const contentRows = Math.min(height, rows - 1)
      assert.deepEqual(visible.slice(rows - 1 - contentRows, rows - 1), lines.slice(-contentRows), 'short-frame growth remains bottom-anchored')
      assert.equal(visible[rows - 1], '', 'growth leaves the cursor-park row clear')
      for (const line of lines) assert.equal(painted.filter(value => value === line).length, 1, `${columns}c short growth: ${line} is preserved once`)
    } finally {
      term.dispose()
    }
  }

  // v0.20 top-anchors the surviving tail after shrink-to-fit. A subsequent
  // preserveGrowth reanchor must reset that mapping before appending new rows.
  {
    const term = new XTerm({ cols: columns, rows, scrollback: 200, allowProposedApi: true })
    try {
      const log = new LogUpdate({ isTTY: true, stylePool: styles })
      const tallLines = Array.from({ length: 40 }, (_, y) => label('before-shrink', y))
      const shortLines = tallLines.slice(0, 20)
      const lines = Array.from({ length: 50 }, (_, y) => shortLines[y] ?? label('after-shrink', y))
      const tall = frame(tallLines, columns)
      const prev = frame(shortLines, columns)
      const next = frame(lines, columns)
      await parse(term, serializeDiff(streams, log.render(emptyFrame(rows, columns, styles, chars, links), tall)))
      await parse(term, serializeDiff(streams, log.render(tall, prev)))
      assert.equal(term.buffer.active.getLine(term.buffer.active.baseY)?.translateToString(true), shortLines[11], 'shrink tail begins directly below native scrollback')
      log.requestViewportReanchor({ preserveGrowth: true })
      await parse(term, serializeDiff(streams, log.render(prev, next)))
      const edited = [...lines]
      edited[45] = 'post-shrink-sparse-edit'
      await parse(term, serializeDiff(streams, log.render(next, frame(edited, columns))))
      const painted = bufferLines(term)
      assert.deepEqual(painted.slice(term.buffer.active.baseY, term.buffer.active.baseY + rows - 1), edited.slice(-(rows - 1)))
      for (const line of edited.slice(shortLines.length)) assert.equal(painted.filter(value => value === line).length, 1, `${columns}c shrink-to-fit growth: ${line} is preserved once`)
    } finally {
      term.dispose()
    }
  }

  // Opt-in must be byte-identical to the old policy without growth. Include
  // shrink across and above the viewport, plus a steady frame with tty drift.
  for (const height of [20, 40, 50]) {
    const outputs: string[] = []
    for (const preserveGrowth of [false, true]) {
      const term = new XTerm({ cols: columns, rows, scrollback: 200, allowProposedApi: true })
      try {
        const log = new LogUpdate({ isTTY: true, stylePool: styles })
        const prev = frame(oldLines, columns)
        const lines = Array.from({ length: height }, (_, y) => label('recovered', y))
        const next = frame(lines, columns)
        await parse(term, serializeDiff(streams, log.render(emptyFrame(rows, columns, styles, chars, links), prev)))
        await parse(term, '\r\nstray external write\r\n')
        log.requestViewportReanchor({ preserveGrowth })
        const bytes = serializeDiff(streams, log.render(prev, next))
        outputs.push(bytes)
        await parse(term, bytes)
        const visible = bufferLines(term).slice(term.buffer.active.baseY, term.buffer.active.baseY + rows)
        const contentRows = Math.min(height, rows - 1)
        const blankBand = rows - 1 - contentRows
        assert.deepEqual(visible.slice(0, blankBand), Array(blankBand).fill(''), 'short full repaints leave their padding above the content')
        assert.deepEqual(visible.slice(blankBand, rows - 1), lines.slice(-contentRows))
        assert.equal(visible[rows - 1], '', 'the cursor-park row stays clear')
        assert(!visible.some(line => line.includes('stray external write')), 'reanchor repairs external cursor drift')
      } finally {
        term.dispose()
      }
    }
    assert.equal(outputs[1], outputs[0], `${columns}c height ${height}: non-growth reanchor policy is unchanged`)
  }
  console.log(`PASS ${columns}c reanchor: complete growth, no new-row duplicates, stranded shrink, request precedence and legacy recovery`)
}
sink.end()

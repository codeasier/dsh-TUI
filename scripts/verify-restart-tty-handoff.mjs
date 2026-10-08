/**
 * /restart must not put the shared tty back into cooked echo.
 *
 * The exiting process used to `stdin.destroy()` ~15s after spawn. libuv
 * restores the termios it saved at the first setRawMode(true) — cooked,
 * echoing — onto the terminal the replacement is using. The child's isRaw
 * flag stays true, and setRawMode(true) is then a libuv no-op, so mouse
 * reports and DECRPM/DA1 replies echo at the cursor as `^[...`.
 *
 * POSIX PTY probe: needs python3, stty and installed TypeScript (no lib build).
 * The detach path executes src/update.ts's AST-extracted production helper.
 * Run: node scripts/verify-restart-tty-handoff.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import ts from 'typescript'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const updateSrc = readFileSync(new URL('../src/update.ts', import.meta.url), 'utf8')
const restartAt = updateSrc.indexOf('export async function restartTui')
const restartBody = updateSrc.slice(restartAt)
// Execute the production function in the PTY parent without importing the
// update/network module graph there. The AST selects the declaration; TS only
// erases its types/exports, so the exercised detach is never a copied model.
const sourceFile = ts.createSourceFile('update.ts', updateSrc, ts.ScriptTarget.Latest, true)
const detachNode = sourceFile.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'detachHandoffStdin')
if (detachNode === undefined) throw new Error('missing production detachHandoffStdin')
const detachBody = detachNode.getText(sourceFile)
const detachJs = ts.transpileModule(detachBody, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
check(
  'restartTui does not destroy stdin (that restores cooked termios)',
  restartBody.includes('detachHandoffStdin') && !restartBody.includes('.destroy('),
)
check(
  'detachHandoffStdin does not close the tty or touch termios',
  !detachBody.includes('.destroy(') && !detachBody.includes('setRawMode'),
)
const ttyMode = readFileSync(new URL('../src/utils/ttyMode.ts', import.meta.url), 'utf8')
check(
  'raw-mode repair toggles false then true (a bare true is a libuv no-op)',
  ttyMode.includes('stdin.setRawMode(false)') && ttyMode.includes('stdin.setRawMode(true)'),
)

const scratch = mkdtempSync(join(tmpdir(), 'verify-restart-tty-'))
// Verify the absolute cleanup target before creating/removing fixture files.
const scratchPath = resolve(scratch)
if (!isAbsolute(scratch) || scratchPath !== scratch
  || !scratchPath.startsWith(join(resolve(tmpdir()), 'verify-restart-tty-'))) {
  throw new Error(`unexpected PTY fixture path: ${scratch}`)
}

writeFileSync(join(scratch, 'child.cjs'), `
const { execFileSync } = require('node:child_process')
function cooked() {
  const text = execFileSync('stty', ['-a'], { stdio: [0, 'pipe', 'pipe'], encoding: 'utf8' })
  const tokens = text.split(/\\s+/)
  return tokens.includes('icanon') || tokens.includes('echo')
}
process.stdin.setRawMode(true)
const before = cooked()
setTimeout(() => {
  process.stderr.write(JSON.stringify({ before, mid: cooked(), isRaw: process.stdin.isRaw === true }) + '\\n')
  process.exit(0)
}, 700)
`)

writeFileSync(join(scratch, 'repair-child.cjs'), `
const { execFileSync } = require('node:child_process')
function cooked() {
  const text = execFileSync('stty', ['-a'], { stdio: [0, 'pipe', 'pipe'], encoding: 'utf8' })
  const tokens = text.split(/\\s+/)
  return tokens.includes('icanon') || tokens.includes('echo')
}
process.stdin.setRawMode(true)
setTimeout(() => {
  const report = (phase, extra) => {
    process.stderr.write(JSON.stringify({ phase, ...extra }) + '\\n')
  }
  report('mid', { cooked: cooked(), isRaw: process.stdin.isRaw === true })
  process.stdin.setRawMode(true)
  report('noop', { cooked: cooked() })
  process.stdin.setRawMode(false)
  process.stdin.setRawMode(true)
  report('toggled', { cooked: cooked() })
  process.exit(0)
}, 600)
`)

function parentSource(childName, action) {
  return `
const { spawn } = require('node:child_process')
${detachJs}
process.stdin.setRawMode(true)
const child = spawn(process.execPath, [${JSON.stringify(join(scratch, childName))}], {
  stdio: ['inherit', 'inherit', 'pipe'],
})
let err = ''
child.stderr.on('data', (chunk) => { err += chunk.toString('utf8') })
setTimeout(() => {
  if (${JSON.stringify(action)} === 'destroy') {
    process.stdin.destroy()
  } else {
    detachHandoffStdin(process.stdin)
    // A late pump must neither consume shared input nor resume this stream.
    if (process.stdin.read() !== null) throw new Error('detached read consumed input')
    if (process.stdin.resume() !== process.stdin || !process.stdin.isPaused()) {
      throw new Error('detached resume reopened the tty reader')
    }
  }
}, 250)
child.on('exit', (code) => {
  process.stderr.write(err)
  process.exit(code ?? 1)
})
`
}

writeFileSync(join(scratch, 'parent-destroy.cjs'), parentSource('child.cjs', 'destroy'))
writeFileSync(join(scratch, 'parent-seal.cjs'), parentSource('child.cjs', 'seal'))
writeFileSync(join(scratch, 'repair-parent.cjs'), parentSource('repair-child.cjs', 'destroy'))

const driver = `
import os, pty, select, time, subprocess, sys
node, script = sys.argv[1], sys.argv[2]
master, slave = pty.openpty()
proc = subprocess.Popen([node, script], stdin=slave, stdout=slave, stderr=subprocess.PIPE, close_fds=True)
os.close(slave)
end = time.time() + 5
err = b''
while time.time() < end:
    watch = [master]
    if proc.stderr is not None:
        watch.append(proc.stderr)
    r, _, _ = select.select(watch, [], [], 0.2)
    if master in r:
        try:
            os.read(master, 4096)
        except OSError:
            break
    if proc.stderr is not None and proc.stderr in r:
        err += os.read(proc.stderr.fileno(), 4096)
    if proc.poll() is not None:
        if proc.stderr is not None:
            rest = proc.stderr.read()
            if rest:
                err += rest
        break
sys.stdout.buffer.write(err)
`

function runPty(scriptPath) {
  return new Promise(resolve => {
    const py = spawn('python3', ['-c', driver, process.execPath, scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    py.stdout.on('data', chunk => { out += chunk.toString('utf8') })
    py.stderr.on('data', chunk => { err += chunk.toString('utf8') })
    py.on('exit', code => resolve({ code, out, err }))
  })
}

function jsonLines(text) {
  return text.split('\n').map(row => row.trim()).filter(row => row.startsWith('{')).flatMap(row => {
    try {
      return [JSON.parse(row)]
    } catch {
      return []
    }
  })
}

const destroyRun = await runPty(join(scratch, 'parent-destroy.cjs'))
const sealRun = await runPty(join(scratch, 'parent-seal.cjs'))
const repairRun = await runPty(join(scratch, 'repair-parent.cjs'))

const destroyed = jsonLines(destroyRun.out).at(-1)
const sealed = jsonLines(sealRun.out).at(-1)
check(
  'control: stdin.destroy restores cooked echo (the footgun)',
  destroyed?.before === false && destroyed?.mid === true,
  `out=${destroyRun.out.trim()} err=${destroyRun.err.trim()}`,
)
check(
  'production detach + late read/resume keeps the shared tty in raw mode',
  sealed?.before === false && sealed?.mid === false,
  `out=${sealRun.out.trim()} err=${sealRun.err.trim()}`,
)

const phases = jsonLines(repairRun.out)
const mid = phases.find(row => row.phase === 'mid')
const noop = phases.find(row => row.phase === 'noop')
const toggled = phases.find(row => row.phase === 'toggled')
check(
  'after destroy, isRaw stays true while the device is cooked',
  mid?.cooked === true && mid?.isRaw === true,
  JSON.stringify(mid),
)
check(
  'setRawMode(true) alone does not repair a clobbered tty',
  noop?.cooked === true,
  JSON.stringify(noop),
)
check(
  'false→true toggle puts the shared tty back in raw mode',
  toggled?.cooked === false,
  `out=${repairRun.out.trim()} err=${repairRun.err.trim()}`,
)

rmSync(scratch, { recursive: true, force: true })

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nrestart tty handoff OK')

/**
 * Shared-tty raw-mode repair.
 *
 * libuv remembers the termios from this process's first setRawMode(true)
 * and writes it back when that tty handle is closed (`stdin.destroy()`,
 * and again at process exit). A /restart parent and its replacement share
 * one terminal device. The parent's close therefore undoes the child's raw
 * mode. Node's `isRaw` flag stays true — it is the handle's belief, not a
 * fresh tcgetattr — so the child never notices and never calls setRawMode
 * again. libuv also no-ops setRawMode(true) when the handle already thinks
 * it is raw. Echo and ICANON come back; mouse reports and DECRPM/DA1
 * replies are painted at the cursor as `^[...` (ECHOCTL).
 *
 * Repair is a false→true toggle, which forces libuv to rewrite termios.
 * Only do it after confirming the device actually left raw mode.
 */

import { execFileSync, spawn } from 'node:child_process'

type RawStdin = NodeJS.ReadStream & {
  fd?: number
  isRaw?: boolean
  setRawMode?: (mode: boolean) => void
}

function ttyFd(stdin: RawStdin): number {
  return typeof stdin.fd === 'number' ? stdin.fd : 0
}

function looksCooked(text: string): boolean {
  // `echoe` / `echoctl` are separate tokens; a bare `echo` or `icanon`
  // (not the `-echo` / `-icanon` forms) means the line discipline will
  // paint input, including protocol replies.
  const tokens = text.split(/\s+/)
  return tokens.includes('icanon') || tokens.includes('echo')
}

/** True when the shared tty is back in cooked echo. Undefined if unknowable. */
export function sharedTtyLooksCooked(stdin: RawStdin = process.stdin): boolean | undefined {
  if (process.platform === 'win32') return undefined
  if (stdin.isTTY !== true) return undefined
  try {
    const text = execFileSync('stty', ['-a'], {
      stdio: [ttyFd(stdin), 'pipe', 'pipe'],
      encoding: 'utf8',
    })
    return looksCooked(text)
  } catch {
    return undefined
  }
}

/**
 * If this process believes stdin is raw but the device is cooked, toggle
 * raw mode so libuv rewrites termios. Returns true when a repair ran.
 * Synchronous — for tests and other callers that are already off the UI
 * thread. The restart child uses {@link pokeRawMode} instead.
 */
export function reassertRawMode(stdin: RawStdin = process.stdin): boolean {
  if (stdin.isRaw !== true || typeof stdin.setRawMode !== 'function') return false
  if (sharedTtyLooksCooked(stdin) !== true) return false
  stdin.setRawMode(false)
  stdin.setRawMode(true)
  return stdin.isRaw === true
}

let sttyMissing = false
let pokeInFlight = false

/**
 * Async, single-flight form of {@link reassertRawMode}. `stty` must not
 * stall a frame, and a missing `stty` disables further probes.
 * `onRepair` runs only when termios was rewritten.
 */
export function pokeRawMode(stdin: RawStdin, onRepair: () => void): void {
  if (sttyMissing || pokeInFlight || process.platform === 'win32') return
  if (stdin.isTTY !== true || stdin.isRaw !== true || typeof stdin.setRawMode !== 'function') return
  pokeInFlight = true
  const child = spawn('stty', ['-a'], { stdio: [ttyFd(stdin), 'pipe', 'pipe'] })
  let text = ''
  let settled = false
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    text += chunk
  })
  const finish = (ok: boolean): void => {
    if (settled) return
    settled = true
    pokeInFlight = false
    if (!ok || !looksCooked(text)) return
    if (stdin.isRaw !== true || typeof stdin.setRawMode !== 'function') return
    stdin.setRawMode(false)
    stdin.setRawMode(true)
    onRepair()
  }
  child.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') sttyMissing = true
    finish(false)
  })
  child.once('close', code => finish(code === 0))
}

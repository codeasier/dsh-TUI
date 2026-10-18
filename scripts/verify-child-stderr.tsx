/**
 * Child-stderr guard regression (issue #17): an MCP server spawned with an
 * inherited stderr (the MCP SDK's stdio default) writes straight to the
 * terminal device from the child process, bypassing the renderer's
 * process.stderr patch and corrupting the alt-screen. The guard rewrites such
 * spawns to a pipe and surfaces the lines as deduplicated notifications.
 *
 * Fixture modes (re-run this file as `--import tsx/esm <self> <mode>`):
 * the fixture spawns a grandchild that writes BOOM-LINE to stderr with an
 * inherited fd 2, with or without the guard installed. The driver captures
 * the fixture's stderr and asserts the raw line reaches fd 2 only when
 * unguarded. The fixture calls `spawn` through the default-import exports
 * object — the same access pattern cross-spawn (used by the MCP SDK) has.
 *
 * Driver mode additionally unit-tests the reporter: debounce dedup with a
 * repeat count, cooldown silence, ANSI stripping, truncation, empty lines,
 * content-graded severity, and that a start-up banner is not a notice at all.
 */
process.env.DSH_TUI_LANG = 'zh'

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { settled, sleep } from './lib/term-test.mjs'

const SELF = fileURLToPath(import.meta.url)

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

async function runInner(mode: string): Promise<void> {
  const { installChildStderrGuard } = await import('../src/dsh-adapter/childStderr.js')
  if (mode !== 'inner-plain') {
    installChildStderrGuard(line => process.stdout.write(`SINK:${line}\n`))
  }
  // Default import = the CJS exports object, read at call time — this is the
  // access pattern the patch must cover (cross-spawn does exactly this).
  const childProcess = (await import('node:child_process')).default
  const stdio = mode === 'inner-guard-string' ? 'inherit' : ['pipe', 'pipe', 'inherit']
  const child = childProcess.spawn(process.execPath, ['-e', 'process.stderr.write("BOOM-LINE\\n")'], {
    stdio,
  } as never)
  process.stdout.write(child.stderr === null ? 'STDERR-NULL\n' : 'STDERR-PIPED\n')
  child.on('exit', () => setTimeout(() => process.exit(0), 100))
}

function runFixture(mode: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', SELF, mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('exit', code => resolve({ stdout, stderr, code }))
  })
}

async function runDriver(): Promise<void> {
  // ── fixture: unguarded inherited stderr reaches fd 2 ──────────────────
  const plain = await runFixture('inner-plain')
  check('未接管：inherit 的子进程 stderr 直达 fd 2（复现 issue 场景）', plain.stderr.includes('BOOM-LINE'))
  check('未接管：inherit 的子进程 stderr 不可读（STDERR-NULL）', plain.stdout.includes('STDERR-NULL'))

  // ── fixture: guarded, stdio array form ────────────────────────────────
  const guarded = await runFixture('inner-guard')
  check('接管（数组 stdio）：裸 stderr 不再到达 fd 2', !guarded.stderr.includes('BOOM-LINE'))
  check('接管（数组 stdio）：stderr 被改成管道（STDERR-PIPED）', guarded.stdout.includes('STDERR-PIPED'))
  check('接管（数组 stdio）：输出行进入受控 sink', guarded.stdout.includes('SINK:BOOM-LINE'))

  // ── fixture: guarded, whole-stdio 'inherit' string form ───────────────
  const guardedString = await runFixture('inner-guard-string')
  check('接管（字符串 stdio）：裸 stderr 不再到达 fd 2', !guardedString.stderr.includes('BOOM-LINE'))
  check('接管（字符串 stdio）：输出行进入受控 sink', guardedString.stdout.includes('SINK:BOOM-LINE'))

  // ── reporter: dedup / cooldown / cleanup ──────────────────────────────
  const { childStderrSeverity, createChildStderrReporter } = await import('../src/dsh-adapter/childStderr.js')
  const notices: string[] = []
  const noticeColors: Array<string | undefined> = []
  const reporter = createChildStderrReporter((text, options) => {
    notices.push(text)
    noticeColors.push(options?.color)
  }, {
    debounceMs: 60,
    cooldownMs: 400,
    maxLineLength: 50,
  })
  const failing = 'Error: Non-HTTPS URLs are only allowed for localhost'

  reporter.push(failing)
  reporter.push(failing)
  reporter.push(failing)
  // 固定窗:探针 不得多出通知：settle 会在第一条通知出现时立即返回，
  // 测不到「只出一条」的上界。
  await sleep(150)
  check('去重：同一行连发 3 次只出一条通知', notices.length === 1)
  check('去重：通知带重复计数（重复 3 次）', notices[0]?.includes('重复 3 次') ?? false)

  reporter.push(failing)
  // 固定窗:探针 冷却期内不得出新通知：条件在 push 前就成立，轮询等于没测。
  await sleep(150)
  check('冷却：刚通知过的行在冷却期内静默', notices.length === 1)

  // 固定窗:墙钟 等 reporter 的 cooldownMs=400 冷却窗过去，没有可观察的状态翻转。
  await sleep(400)
  reporter.push(failing)
  check('冷却结束：同一行可再次通知', await settled(() => notices.length === 2))

  // 换一条带失败词汇的行：「不同行各自成条」要测的是通知路径，信息行已静默。
  reporter.push('ENOENT: no such file or directory, open /etc/mcp.json')
  check('不同的行各自成条通知', await settled(() => notices.length === 3 && (notices[2]?.includes('ENOENT') ?? false)))

  reporter.push('\x1b[31mError: red-line\x1b[39m')
  check('ANSI 转义被剥离', await settled(() => (notices.at(-1) ?? '').includes('red-line') && !(notices.at(-1) ?? '').includes('\x1b')))

  const longLine = `Error: ${'x'.repeat(100)}`
  reporter.push(longLine)
  check('超长行被截断（带省略号）', await settled(() => (notices.at(-1) ?? '').includes('…') && !(notices.at(-1) ?? '').includes(longLine)))

  const countBefore = notices.length
  reporter.push('   ')
  reporter.push('')
  // 固定窗:探针 空行不得产生通知：条件在 push 前就成立，轮询等于没测。
  await sleep(150)
  check('空行/纯空白行被丢弃', notices.length === countBefore)

  // ── reporter: 信息行静默、问题行按内容分级 ────────────────────────────
  // 出厂症状：MCP server 每次 tools/list 握手都往 stderr 播报一行诊断，
  // 被当成错误横幅挂在每次启动的落地页上。
  const benignStart = notices.length
  reporter.push('[@agentmemory/mcp] Standalone MCP server v0.9.30 starting...')
  reporter.push('[@agentmemory/mcp] proxying to agentmemory server at http://10.66.0.3:3111')
  // 固定窗:探针 静默行不得产生通知：条件在 push 前就成立，轮询等于没测。
  await sleep(150)
  check('静默：正常启动播报不产生任何通知', notices.length === benignStart)

  const failureStart = notices.length
  reporter.push('Error: spawn agentmemory-mcp ENOENT')
  check(
    '失败行：出通知且为 error 色',
    await settled(() => notices.length === failureStart + 1) && noticeColors[failureStart] === 'error',
  )

  const cautionStart = notices.length
  reporter.push('Warning: AGENTMEMORY_URL points at an old host')
  check(
    '告警行：出通知但为 warning 色',
    await settled(() => notices.length === cautionStart + 1) && noticeColors[cautionStart] === 'warning',
  )

  const graded: Array<[string, 'error' | 'warning' | 'info']> = [
    ['[@agentmemory/mcp] proxying to agentmemory server at http://10.66.0.3:3111', 'info'],
    ['Standalone MCP server v0.9.30 starting...', 'info'],
    ['Usage: tsx proxy.ts <url>', 'info'],
    ['no server reachable at http://localhost:3111; running reduced LOCAL FALLBACK with 7 of 8 tools.', 'error'],
    ['Error: Non-HTTPS URLs are only allowed for localhost', 'error'],
    ['unhandledRejection: ECONNREFUSED 10.66.0.3:3111', 'error'],
    ['Warning: retrying in 5s', 'warning'],
  ]
  for (const [line, expected] of graded) {
    check(`分级：${expected} ← ${line.slice(0, 44)}`, childStderrSeverity(line) === expected)
  }

  // 失败词落在显示上限之后：截断只该缩短正文，不得把失败吞成静默。
  const tailStart = notices.length
  reporter.push(`slow handshake, giving up: ${'y'.repeat(60)} ECONNRESET`)
  check(
    '截断只缩短正文，不吞失败判定',
    await settled(() => notices.length === tailStart + 1) && noticeColors[tailStart] === 'error',
  )

  reporter.dispose()

  console.log(results.join('\n'))
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall child-stderr guard checks passed')
}

const mode = process.argv[2]
if (mode !== undefined && mode.startsWith('inner-')) {
  await runInner(mode)
} else {
  await runDriver()
}

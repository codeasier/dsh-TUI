/**
 * 后台任务（ctx.jobs）UI 投影回归：/jobs 面板、转录任务卡、状态栏角标、完成 toast。
 *
 * Group A — BackgroundJobStore 单元（无渲染）：
 *   注册/转换/消失合成 killed、概述 metadata 生命周期、输出镜像过滤与有界、时长格式化。
 * Group B — channel 集成（真实 cordis Context + 假 agents/jobs 服务）：
 *   任务注册建卡、job_output 结果镜像进瀑布、落定 toast、存活任务消失冻结、
 *   jobControl.kill 权限传递、无 jobs 服务降级、/new 重置投影；前台 shell 隐藏、后台启动/超时移交显卡；
 *   native/PTC/live/replay 概述关联、并发反序结果、无效概述回退。
 * Group C — 渲染冒烟（headless xterm）：
 *   JobCard 运行态三行瀑布（有输出时）/仅头行（无输出时）、settled 折叠、JobsPanel 标题/行/提示。
 * Group D — 按键归属（Chat 整屏 + 假 channel）：
 *   面板打开时 Esc 关面板而非中断对话；面板关闭后 Esc 仍能中断（防假通过）。
 * Group E — 40 列 inline/fullscreen Chat：前台不重复显卡、后台概述/ID/状态同一行。
 *
 * 运行：node --import tsx/esm scripts/verify-jobs-panel.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'

// 家目录隔离：channel 构造路径会 touch 用户目录，先切临时目录再 import。
const { mkdtempSync, mkdirSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')
const isolatedHome = mkdtempSync(joinPath(tmpdir(), 'dshtui-jobs-panel-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
mkdirSync(joinPath(isolatedHome, '.dsh-tui'), { recursive: true })

const [
  { Context },
  { createChannel },
  { BackgroundJobStore, formatJobDuration, jobTitleOf, JOBS_MAX_TRACKED, JOBS_MAX_OUTPUT_LINES },
  { settled, settle, sleep },
  React,
  { render },
  { JobCard },
  { JobsPanel, resolveJobsRowColumns },
  { Chat },
  { QuestionStore },
  { createJobProjection },
  { getTheme },
] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/jobs.js'),
  import('./lib/term-test.mjs'),
  import('react'),
  import('../src/ui.js'),
  import('../src/components/Chat/JobCard.js'),
  import('../src/components/JobsPanel.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/channel/job-projection.js'),
  import('../src/theme.js'),
])
const { Writable, PassThrough } = await import('node:stream')
const { Terminal: XTerm } = (await import('@xterm/headless')) as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ---------------------------------------------------------------------------
// Group A — BackgroundJobStore 单元
// ---------------------------------------------------------------------------
console.log('--- A: BackgroundJobStore units ---')
{
  const settledJobs: string[] = []
  let changes = 0
  const store = new BackgroundJobStore({
    onSettled: job => settledJobs.push(`${job.id}:${job.status}`),
    onChanged: () => { changes += 1 },
  })
  const snap = (id: string, status: 'running' | 'completed', extra: Record<string, unknown> = {}) =>
    ({ id, kind: 'pwsh', label: `cmd ${id}`, status, startedAt: 1000, ...extra })

  store.replace([snap('pwsh-1', 'running'), snap('pwsh-2', 'running')])
  check('A1 注册两个任务', store.snapshot().length === 2 && changes === 1)
  const changesAfterNoop = changes
  store.replace([snap('pwsh-1', 'running'), snap('pwsh-2', 'running')])
  check('A1 无变化 replace 不触发事件', changes === changesAfterNoop)

  store.replace([snap('pwsh-1', 'completed', { detail: 'exit code: 0', finishedAt: 5000 }), snap('pwsh-2', 'running')])
  check('A2 running→completed 触发一次 onSettled', settledJobs.join(',') === 'pwsh-1:completed', settledJobs.join(','))
  store.replace([snap('pwsh-1', 'completed', { detail: 'exit code: 0', finishedAt: 5000 }), snap('pwsh-2', 'running')])
  check('A2 重复终态不重复触发', settledJobs.length === 1)

  // 存活任务从 list 消失（owner 处置/会话切换）→ 冻结为 killed 并保留为历史。
  store.replace([snap('pwsh-1', 'completed', { detail: 'exit code: 0', finishedAt: 5000 })])
  check('A3 存活任务消失合成 killed', settledJobs.join(',') === 'pwsh-1:completed,pwsh-2:killed', settledJobs.join(','))
  check('A3 消失任务冻结保留在快照', store.get('pwsh-2')?.status === 'killed')

  store.onOutputSeen('pwsh-1', 'line A\n\nline B  \n[status: completed, exit code: 0]')
  const job1 = store.get('pwsh-1')
  check(
    'A4 镜像输出去空行 + 去 [status:] 尾缀',
    (job1?.outputLines ?? []).map(line => line.text).join('|') === 'line A|line B',
    JSON.stringify(job1?.outputLines),
  )
  store.onOutputSeen('pwsh-1', Array.from({ length: 40 }, (_, i) => `tail ${i}`).join('\n'))
  check(
    'A4 输出尾部有界',
    job1?.outputLines.length === JOBS_MAX_OUTPUT_LINES && job1?.outputLines.at(-1)?.text === 'tail 39',
    `len=${job1?.outputLines.length}`,
  )
  store.onOutputSeen('unknown-job', 'x')
  check('A4 未知任务镜像被忽略', store.get('unknown-job') === undefined)

  // A7 内核 output 环摄取：通道标签、跨 chunk 行拼接、gap 标记、游标推进。
  {
    const kernelStore = new BackgroundJobStore()
    kernelStore.replace([{
      id: 'pwsh-9', kind: 'pwsh', label: 'stream cmd', status: 'running', startedAt: 0,
      output: { total: 0, earliest: 0 },
    }])
    kernelStore.onKernelOutput('pwsh-9', {
      chunks: [
        { at: 0, text: 'partial without new', channel: 'stdout' },
        { at: 21, text: 'line end\n', channel: 'stdout' },
      ],
      next: 29,
    })
    check(
      'A7 跨 chunk 行拼接（无换行尾暂存）',
      kernelStore.get('pwsh-9')?.outputLines.length === 1
        && kernelStore.get('pwsh-9')?.outputLines[0]?.text === 'partial without newline end',
      JSON.stringify(kernelStore.get('pwsh-9')?.outputLines),
    )
    check('A7 游标推进到 next', kernelStore.kernelCursorOf('pwsh-9') === 29, String(kernelStore.kernelCursorOf('pwsh-9')))
    check('A7 总字节跟踪', kernelStore.get('pwsh-9')?.outputTotalBytes === 29, String(kernelStore.get('pwsh-9')?.outputTotalBytes))
    kernelStore.onKernelOutput('pwsh-9', {
      chunks: [
        { at: 29, text: 'warn line\n', channel: 'stderr', gapBefore: true },
        { at: 39, text: 'narration\n', channel: 'log' },
      ],
      next: 49,
    })
    const klines = kernelStore.get('pwsh-9')?.outputLines ?? []
    check(
      'A7 通道标签落行（stderr/log）',
      klines.some(line => line.channel === 'stderr' && line.text === 'warn line')
        && klines.some(line => line.channel === 'log' && line.text === 'narration'),
      JSON.stringify(klines),
    )
    check(
      'A7 gapBefore 标记在丢失后首行',
      klines.find(line => line.channel === 'stderr')?.gapBefore === true,
      JSON.stringify(klines),
    )
    check('A7 丢失标记置位 outputDropped', kernelStore.get('pwsh-9')?.outputDropped === true)
    kernelStore.onKernelOutput('pwsh-9', { chunks: [], next: 49, lossy: true })
    check('A7 空增量 lossy 不清丢失标记', kernelStore.get('pwsh-9')?.outputDropped === true)
  }

  const big = new BackgroundJobStore()
  big.replace(
    Array.from({ length: JOBS_MAX_TRACKED + 10 }, (_, i) => ({
      id: `bash-${i}`, kind: 'bash', label: 'x', status: i < 5 ? 'running' as const : 'completed' as const, startedAt: i, finishedAt: i + 1,
    })),
  )
  const remaining = big.snapshot()
  check(
    'A5 终态有界且存活全保留',
    remaining.length <= JOBS_MAX_TRACKED && remaining.filter(job => job.status === 'running').length === 5,
    `len=${remaining.length}`,
  )

  check(
    'A6 时长格式化',
    formatJobDuration({ startedAt: 0, finishedAt: 3000 }) === '3s'
      && formatJobDuration({ startedAt: 0, finishedAt: 192_000 }) === '3m12s'
      && formatJobDuration({ startedAt: 0, finishedAt: 3_720_000 }) === '1h02m',
    `${formatJobDuration({ startedAt: 0, finishedAt: 192_000 })}`,
  )

  const proofs = new BackgroundJobStore()
  proofs.onStarted('bash-live', 'sleep 99')
  proofs.replace([{ id: 'bash-live', kind: 'bash', label: 'live', status: 'running', startedAt: 0 }])
  for (let i = 0; i <= JOBS_MAX_TRACKED; i += 1) proofs.onStarted(`bash-old-${i}`, 'true')
  proofs.replace([
    { id: 'bash-live', kind: 'bash', label: 'live', status: 'running', startedAt: 0 },
    { id: 'bash-old-0', kind: 'bash', label: 'evicted proof', status: 'completed', startedAt: 0 },
    { id: `bash-old-${JOBS_MAX_TRACKED}`, kind: 'bash', label: 'recent proof', status: 'completed', startedAt: 0 },
  ])
  check('A8 回放暂存有界但不丢存活任务证明',
    proofs.isBackground('bash-live') && !proofs.isBackground('bash-old-0') && proofs.isBackground(`bash-old-${JOBS_MAX_TRACKED}`))
  proofs.reset()
  proofs.onStarted('bash-next', 'sleep 1', 'old session summary')
  proofs.reset()
  proofs.replace([{ id: 'bash-next', kind: 'bash', label: 'next session', status: 'running', startedAt: 0 }])
  check('A8 空名册 reset 也清掉待注册移交（不串会话）', !proofs.isBackground('bash-next')
    && proofs.get('bash-next')?.command === undefined && proofs.get('bash-next')?.description === undefined)

  const metadataSettled: string[] = []
  const metadata = new BackgroundJobStore({ onSettled: job => metadataSettled.push(jobTitleOf(job)) })
  for (const ackFirst of [true, false]) {
    const id = ackFirst ? 'bash-ack-first' : 'pwsh-roster-first'
    const shot = { id, kind: ackFirst ? 'bash' : 'pwsh', label: `registry ${id}`, status: 'running' as const, startedAt: 0 }
    const description = `summary ${id}`
    if (ackFirst) metadata.onStarted(id, 'sleep 77', description)
    metadata.replace([...metadata.snapshot(), shot])
    if (!ackFirst) metadata.onStarted(id, 'sleep 77', description)
    check(`A9 ${id} ACK/roster 两种顺序均保留 registry label 和概述`,
      metadata.get(id)?.label === shot.label && metadata.get(id)?.description === description
        && metadata.get(id)?.command === 'sleep 77' && jobTitleOf(metadata.get(id)!) === description)
    metadata.onStarted(id)
    check(`A9 ${id} job_output 无 metadata 不清空概述/命令`,
      metadata.get(id)?.description === description && metadata.get(id)?.command === 'sleep 77')
    metadata.replace(metadata.snapshot().map(job => job.id === id ? { ...shot, label: `updated ${id}`, progress: '1/2' } : job))
    check(`A9 ${id} replace 更新 label/progress 不覆盖概述`,
      metadata.get(id)?.label === `updated ${id}` && metadata.get(id)?.progress === '1/2'
        && metadata.get(id)?.description === description)
    metadata.replace(metadata.snapshot().map(job => job.id === id
      ? { ...shot, label: `settled ${id}`, status: 'completed' as const, finishedAt: 10 } : job))
    check(`A9 ${id} settle 保留概述且回调优先概述`,
      metadata.get(id)?.description === description && metadataSettled.at(-1) === description)
  }
  metadata.onStarted('bash-pending', 'sleep 88', 'pending summary')
  metadata.onStarted('bash-pending')
  metadata.reset({ preservePendingStarts: true })
  metadata.replace([
    { id: 'bash-pending', kind: 'bash', label: 'pending registry', status: 'running', startedAt: 0 },
    { id: 'bash-ack-first', kind: 'bash', label: 'new registry', status: 'running', startedAt: 0 },
  ])
  check('A10 preservePendingStarts 保留待注册全部 metadata', metadata.isBackground('bash-pending')
    && metadata.get('bash-pending')?.description === 'pending summary' && metadata.get('bash-pending')?.command === 'sleep 88')
  check('A10 preservePendingStarts 不保留旧名册 metadata', !metadata.isBackground('bash-ack-first')
    && metadata.get('bash-ack-first')?.description === undefined && metadata.get('bash-ack-first')?.command === undefined)
  metadata.reset()
  metadata.replace([{ id: 'bash-pending', kind: 'bash', label: 'fresh registry', status: 'running', startedAt: 0 }])
  check('A10 reset 清理已注册 metadata', metadata.get('bash-pending')?.description === undefined
    && metadata.get('bash-pending')?.command === undefined && !metadata.isBackground('bash-pending'))
  check('A11 jobTitleOf description 优先，否则回退 registry label',
    jobTitleOf({ label: 'registry', description: 'summary' }) === 'summary'
      && jobTitleOf({ label: 'registry' }) === 'registry'
      && jobTitleOf({ label: 'registry', description: '' }) === 'registry')
}

// ---------------------------------------------------------------------------
// Group B — channel 集成
// ---------------------------------------------------------------------------
console.log('--- B: channel integration ---')
interface FakeAgent {
  id: string
  status: string
  options: Record<string, unknown>
  ctx: unknown
  session: { id: string; seq: number; events: unknown[]; header: Record<string, unknown> }
  steered: string[]
  followup(message: unknown): void
  steer(message: unknown): void
  inbox: { remove(): boolean }
  cancel(): void
  whenIdle(): Promise<void>
}
function makeAgent(id: string, sessionId: string): FakeAgent {
  const steered: string[] = []
  return {
    id,
    status: 'idle',
    options: {},
    ctx: { on: () => () => {} },
    session: { id: sessionId, seq: 0, events: [], header: {} },
    steered,
    followup() {},
    steer(message) { steered.push(JSON.stringify((message as { content?: unknown }).content)) },
    inbox: { remove: () => true },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  } as FakeAgent
}
const makeHandle = (agent: FakeAgent) => ({ agent, dispose: () => Promise.resolve() })

function makeFakeJobs(currentOwner: () => string | undefined = () => undefined): {
  runtime: Record<string, unknown>
  register(snap: Record<string, unknown>): void
  update(snap: Record<string, unknown>): void
  remove(id: string): void
  kills: string[]
} {
  const snapshots = new Map<string, Record<string, unknown>>()
  // 内核口径：`list(caller)` 只返回 `owner === undefined || owner.id === caller`
  // 的任务。假注册表原先忽略 caller 一律全返，于是「切会话后按新会话重读」
  // 这条路在夹具里永远看不到为空——真实内核会过滤掉上一个会话的任务。
  const owners = new Map<string, string | undefined>()
  const changed = new Set<(owner: unknown) => void>()
  const done = new Set<(snap: unknown, owner: unknown) => void>()
  const kills: string[] = []
  const fire = (): void => { for (const listener of changed) listener(undefined) }
  return {
    kills,
    runtime: {
      list: (caller?: string) => [...snapshots.values()].filter(snap => owners.get(String(snap.id)) === undefined || owners.get(String(snap.id)) === caller),
      kill: (id: string) => { kills.push(id); return 'requested' },
      onJobsChanged: (listener: (owner: unknown) => void) => { changed.add(listener); return () => changed.delete(listener) },
      onJobDone: (listener: (snap: unknown, owner: unknown) => void) => { done.add(listener); return () => done.delete(listener) },
    },
    register(snap) { snapshots.set(snap.id as string, snap); owners.set(String(snap.id), currentOwner()); fire() },
    update(snap) { snapshots.set(snap.id as string, snap); fire() },
    remove(id) { snapshots.delete(id); fire() },
  }
}

const jobRows = (channel: { rows: Array<{ kind: string }> }) => channel.rows.filter(row => row.kind === 'job')
const NOW = Date.now()

{
  const ctx = new Context()
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  const emit = (event: string, ...args: unknown[]) =>
    (ctx as unknown as { emit(event: string, ...args: unknown[]): void }).emit(event, ...args)
  const initial = makeAgent('agent-a', 'sess-a')
  provide('agents', {
    get: () => undefined,
    create: () => Promise.resolve(makeHandle(makeAgent('agent-b', 'sess-b'))),
  })
  // 本组所有注册都发生在 /new 之前，归属于初始 agent。
  const fake = makeFakeJobs(() => initial.id)
  provide('jobs', fake.runtime)
  const channel = createChannel(ctx as never, initial as never, {
    model: 'm0', cwd: '/tmp/demo', provider: 'p0', activity: false,
  })

  const shellResult = (id: string, name: string, command: string, result: string, background = false, description?: unknown): void => {
    emit('session/event', initial.session, {
      type: 'tool/call',
      data: { callId: `call-${id}`, name, arguments: JSON.stringify({ command, run_in_background: background, description }) },
    })
    emit('session/event', initial.session, {
      type: 'tool/result',
      data: { message: { source: { callId: `call-${id}` }, content: [{ type: 'text', text: result }] } },
    })
  }

  // Modern shell producers register even foreground commands, settle them
  // while the tool waits, then remove the record before returning the result.
  for (const kind of ['bash', 'pwsh']) {
    for (const status of ['completed', 'failed', 'killed']) {
      const id = `${kind}-foreground-${status}`
      const notices = channel.notifications.length
      fake.register({ id, kind, label: 'git status', status: 'running', startedAt: NOW })
      check(`B0 ${id} 运行中只显示工具事实`, jobRows(channel).length === 0 && channel.backgroundJobs.length === 0)
      fake.update({ id, kind, label: 'git status', status, startedAt: NOW, finishedAt: NOW })
      fake.remove(id)
      shellResult(id, kind, 'git status', status === 'completed' ? 'clean' : '[exit code: 1]')
      check(`B0 ${id} 落定不留 job 卡/面板记录/重复通知`,
        jobRows(channel).length === 0 && channel.backgroundJobs.length === 0 && channel.notifications.length === notices)
      check(`B0 ${id} 工具输出仍保留`, channel.rows.some(row => row.tool?.callId === `call-${id}` && row.tool.resultFull !== undefined))
    }
  }

  fake.register({ id: 'pwsh-1', kind: 'pwsh', label: 'gh run watch 42', status: 'running', startedAt: NOW - 3000 })
  shellResult('pwsh-1', 'pwsh', 'gh run watch 42', 'started background job pwsh-1', true, '  Watch\n  CI\tresults  ')
  check('B1 roster 先于 native explicit ACK：概述归一化且 registry label 保留',
    await settled(() => channel.backgroundJobs[0]?.description === 'Watch CI results' && channel.backgroundJobs[0]?.label === 'gh run watch 42'
      && jobRows(channel)[0]?.job?.description === 'Watch CI results' && jobRows(channel)[0]?.text === 'Watch CI results'),
    JSON.stringify(channel.backgroundJobs))
  check('B1 任务注册进快照', await settled(() => channel.backgroundJobs.length === 1))
  check('B1 转录出现任务卡行', await settled(() => jobRows(channel).length === 1))
  check('B1 卡行初态 running', jobRows(channel)[0]?.job?.status === 'running', String(jobRows(channel)[0]?.job?.status))

  // job_output 工具结果流经事件流 → 镜像进瀑布（去掉 [status:] 尾缀）。
  emit('session/event', initial.session, {
    type: 'tool/call',
    data: { callId: 'cj1', name: 'job_output', arguments: JSON.stringify({ job_id: 'pwsh-1' }) },
  })
  emit('session/event', initial.session, {
    type: 'tool/result',
    data: {
      message: {
        source: { callId: 'cj1' },
        content: [{ type: 'tool-result', content: [{ type: 'text', text: 'build step 1 ok\nbuild step 2 ok\n[status: running]' }] }],
      },
    },
  })
  check(
    'B2 job_output 结果镜像进卡行',
    await settled(() => (jobRows(channel)[0]?.job?.outputLines ?? []).map(line => line.text).join('|') === 'build step 1 ok|build step 2 ok'),
    JSON.stringify(jobRows(channel)[0]?.job?.outputLines),
  )
  check(
    'B2 镜像记录输出更新时间',
    await settled(() => typeof channel.backgroundJobs[0]?.lastOutputAt === 'number'),
    String(channel.backgroundJobs[0]?.lastOutputAt),
  )

  check('B2 job_output 无 command/description 不清空启动 metadata',
    channel.backgroundJobs[0]?.description === 'Watch CI results' && channel.backgroundJobs[0]?.command === 'gh run watch 42'
      && jobRows(channel)[0]?.job?.description === 'Watch CI results')
  fake.update({ id: 'pwsh-1', kind: 'pwsh', label: 'registry watch updated', progress: '1/2', status: 'running', startedAt: NOW - 3000 })
  check('B2 roster replace 更新 label/progress 但不丢概述', channel.backgroundJobs[0]?.label === 'registry watch updated'
    && channel.backgroundJobs[0]?.description === 'Watch CI results' && jobRows(channel)[0]?.job?.description === 'Watch CI results')

  const noticesBefore = channel.notifications.length
  fake.update({ id: 'pwsh-1', kind: 'pwsh', label: 'gh run watch 42', status: 'completed', detail: 'exit code: 0', startedAt: NOW - 3000, finishedAt: NOW })
  check('B3 落定后卡行 completed + exit detail', await settled(() =>
    jobRows(channel)[0]?.job?.status === 'completed' && jobRows(channel)[0]?.job?.detail === 'exit code: 0',
  ))
  check(
    'B3 完成 toast 送达（含任务 id）',
    await settled(() => channel.notifications.length > noticesBefore
      && channel.notifications.some(item => item.text.includes('pwsh-1') && item.text.includes('Watch CI results')
        && !item.text.includes('gh run watch 42'))),
    JSON.stringify(channel.notifications.map(item => item.text)),
  )

  // 第二个任务：存活中消失（owner 处置）→ 卡行冻结为 killed，随后移出面板。
  fake.register({ id: 'bash-2', kind: 'bash', label: 'sleep 99', status: 'running', startedAt: NOW })
  shellResult('bash-2', 'bash', 'sleep 99', 'started background job bash-2', true)
  check('B4 第二个任务注册', await settled(() => channel.backgroundJobs.length === 2))
  fake.remove('bash-2')
  check('B4 存活任务消失→卡行冻结 killed', await settled(() => {
    const row = jobRows(channel).find(r => r.job?.id === 'bash-2')
    return row?.job?.status === 'killed'
  }), String(jobRows(channel).find(r => r.job?.id === 'bash-2')?.job?.status))
  check('B4 面板快照冻结为 killed 保留', await settled(() =>
    channel.backgroundJobs.find(job => job.id === 'bash-2')?.status === 'killed',
  ))

  check('B5 jobControl.kill 调用注册表并带 owner', channel.jobControl.kill('pwsh-1') === true && fake.kills.join(',') === 'pwsh-1', fake.kills.join(','))
  await sleep(150) // 固定窗:探针 终态任务 kill 后观察窗内不得发出 steer
  check('B5 终态任务 kill 不触发 steer', initial.steered.length === 0, initial.steered.join('|'))

  // 存活任务被用户 kill → steer 通知模型（kill 会抑制 harness 完成通知）。
  fake.register({ id: 'bash-3', kind: 'bash', label: 'sleep 100', status: 'running', startedAt: NOW })
  shellResult('bash-3', 'bash', 'sleep 100', 'started background job bash-3', true)
  check('B8 存活任务注册', await settled(() => channel.backgroundJobs.some(job => job.id === 'bash-3')))
  check('B8 存活 kill 返回 true', channel.jobControl.kill('bash-3') === true)
  check(
    'B8 kill 后 steer 送达模型（含任务 id）',
    await settled(() => initial.steered.some(text => text.includes('bash-3'))),
    initial.steered.join('|'),
  )

  // 启动 ack（started background job <id>）先于注册到达：命令暂存，注册后挂上。
  emit('session/event', initial.session, {
    type: 'tool/call',
    data: { callId: 'cj9', name: 'pwsh', arguments: JSON.stringify({ command: 'gh pr checks --watch 42', description: 'watch ci' }) },
  })
  emit('session/event', initial.session, {
    type: 'tool/result',
    data: {
      message: {
        source: { callId: 'cj9' },
        content: [{ type: 'tool-result', content: [{ type: 'text', text: 'started background job pwsh-9' }] }],
      },
    },
  })
  fake.register({ id: 'pwsh-9', kind: 'pwsh', label: 'gh pr checks --watch 42', status: 'running', startedAt: NOW })
  check('B9 legacy nested explicit ACK 先于 roster：概述/label 独立保留',
    channel.backgroundJobs.find(job => job.id === 'pwsh-9')?.description === 'watch ci'
      && channel.backgroundJobs.find(job => job.id === 'pwsh-9')?.label === 'gh pr checks --watch 42'
      && jobRows(channel).find(row => row.job?.id === 'pwsh-9')?.job?.description === 'watch ci')
  check(
    'B9 启动 ack 捕获完整命令（注册后挂上）',
    await settled(() => channel.backgroundJobs.find(job => job.id === 'pwsh-9')?.command === 'gh pr checks --watch 42'),
    String(channel.backgroundJobs.find(job => job.id === 'pwsh-9')?.command),
  )
  check('B9 ack 先于注册也显示任务卡', jobRows(channel).some(row => row.job?.id === 'pwsh-9'))

  for (const kind of ['bash', 'pwsh']) {
    const id = `${kind}-promoted`
    fake.register({ id, kind, label: 'sleep 99', status: 'running', startedAt: NOW })
    check(`B10 ${kind} 移交前没有独立任务卡`, !jobRows(channel).some(row => row.job?.id === id))
    shellResult(id, kind, 'sleep 99', `partial output\n[still running after 100ms; moved to background job ${id}]\nThe command keeps running in the background.`, false, `  ${kind}\n timeout task  `)
    check(`B10 ${kind} 超时转后台显卡并保留命令/概述/registry label`,
      jobRows(channel).some(row => row.job?.id === id && row.job.status === 'running' && row.job.description === `${kind} timeout task`)
        && channel.backgroundJobs.some(job => job.id === id && job.command === 'sleep 99'
          && job.description === `${kind} timeout task` && job.label === 'sleep 99'))
    fake.update({ id, kind, label: 'sleep 99', status: 'completed', startedAt: NOW, finishedAt: NOW })
    check(`B10 ${kind} 超时任务落定不丢概述`, jobRows(channel).some(row => row.job?.id === id
      && row.job.status === 'completed' && row.job.description === `${kind} timeout task`))
  }

  // A very short explicit background command may settle before its ack.
  fake.register({ id: 'bash-fast', kind: 'bash', label: 'true', status: 'running', startedAt: NOW })
  fake.update({ id: 'bash-fast', kind: 'bash', label: 'true', status: 'completed', startedAt: NOW, finishedAt: NOW })
  shellResult('bash-fast', 'bash', 'true', 'started background job bash-fast', true, 'Fast background check')
  check('B11 快速后台任务 ack 到达后仍显示完成卡与概述', jobRows(channel).some(row => row.job?.id === 'bash-fast'
    && row.job.status === 'completed' && row.job.description === 'Fast background check'))

  // Reading an existing job is evidence even if its start was compacted away.
  fake.register({ id: 'bash-existing', kind: 'bash', label: 'existing work', status: 'running', startedAt: NOW })
  emit('session/event', initial.session, {
    type: 'tool/call', data: { callId: 'existing-output', name: 'job_output', arguments: JSON.stringify({ job_id: 'bash-existing' }) },
  })
  emit('session/event', initial.session, {
    type: 'tool/result', data: { message: { source: { callId: 'existing-output' }, content: [{ type: 'text', text: '[status: running]' }] } },
  })
  check('B12 job_output 可恢复已有后台任务卡', jobRows(channel).some(row => row.job?.id === 'bash-existing'))

  fake.register({ id: 'other-producer', kind: 'pty-send', label: 'independent work', status: 'running', startedAt: NOW })
  check('B13 其他任务生产者注册即显卡', jobRows(channel).some(row => row.job?.id === 'other-producer'))

  for (const kind of ['bash', 'pwsh']) {
    const id = `${kind}-ptc`
    fake.register({ id, kind, label: 'sleep 99', status: 'running', startedAt: NOW })
    emit('session/event', initial.session, {
      type: 'tool/ptc-dispatch',
      data: {
        rootCallId: 'run-code', parentCallId: 'run-code:ptc:outer', subCallId: `run-code:ptc:outer:${kind}`, name: kind,
        arguments: { command: 'sleep 99', description: `  Nested\n ${kind} task  `, run_in_background: kind === 'bash' }, isError: false,
        content: [{ type: 'text', text: kind === 'bash' ? `started background job ${id}`
          : `[still running after 100ms; moved to background job ${id}]` }],
      },
    })
    check(`B14 nested PTC ${kind} explicit/timeout 共享概述投影路径`,
      jobRows(channel).some(row => row.job?.id === id && row.job.description === `Nested ${kind} task`)
        && channel.backgroundJobs.some(job => job.id === id && job.label === 'sleep 99'
          && job.command === 'sleep 99' && job.description === `Nested ${kind} task`))
  }

  const invalidDescriptions: unknown[] = [undefined, '', ' \n\t ', 42, false, null, { text: 'not a string' }, '\u001b[31m\u0000\u001b[0m']
  for (const [index, description] of invalidDescriptions.entries()) {
    const kind = index % 2 === 0 ? 'bash' : 'pwsh'
    const id = `${kind}-fallback-${index}`
    fake.register({ id, kind, label: `fallback ${index}`, status: 'running', startedAt: NOW })
    shellResult(id, kind, 'true', `started background job ${id}`, true, description)
    const job = channel.backgroundJobs.find(job => job.id === id)
    check(`B15 缺失/空/非字符串/纯控制概述回退 ${index}`,
      job?.description === undefined && job !== undefined && jobTitleOf(job) === `fallback ${index}`
        && jobRows(channel).find(row => row.job?.id === id)?.text === `fallback ${index}`)
  }
  shellResult('bash-clean', 'bash', 'true', 'started background job bash-clean', true, '\u001b[31m  Clean\n title\u001b[0m')
  fake.register({ id: 'bash-clean', kind: 'bash', label: 'true', status: 'running', startedAt: NOW })
  check('B15 ANSI 描述剥离并归一化单行', channel.backgroundJobs.find(job => job.id === 'bash-clean')?.description === 'Clean title')

  // Calls interleave; results arrive in reverse order and only one has a roster yet.
  for (const kind of ['bash', 'pwsh']) {
    emit('session/event', initial.session, {
      type: 'tool/call', data: { callId: `concurrent-${kind}`, name: kind,
        arguments: JSON.stringify({ command: `command ${kind}`, description: `Summary ${kind}`, run_in_background: true }) },
    })
  }
  fake.register({ id: 'bash-concurrent', kind: 'bash', label: 'registry bash', status: 'running', startedAt: NOW })
  for (const kind of ['pwsh', 'bash']) {
    emit('session/event', initial.session, {
      type: 'tool/result', data: { message: { source: { callId: `concurrent-${kind}` },
        content: [{ type: 'text', text: `started background job ${kind}-concurrent` }] } },
    })
  }
  fake.register({ id: 'pwsh-concurrent', kind: 'pwsh', label: 'registry pwsh', status: 'running', startedAt: NOW })
  check('B16 并发不同 call ID 反序结果不串命令/概述', ['bash', 'pwsh'].every(kind =>
    channel.backgroundJobs.some(job => job.id === `${kind}-concurrent` && job.description === `Summary ${kind}`
      && job.command === `command ${kind}` && job.label === `registry ${kind}`)
      && jobRows(channel).some(row => row.job?.id === `${kind}-concurrent` && row.job.description === `Summary ${kind}`)))

  check('B6 /new 成功', (await channel.newSession()) === true)
  check('B6 切换后面板快照清空', channel.backgroundJobs.length === 0)
  check('B6 切换后任务卡行清空', jobRows(channel).length === 0)
}

// Durable replay uses the same result projection as live native and nested PTC events.
{
  const ctx = new Context()
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  const agent = makeAgent('replay-agent', 'replay-session')
  const fake = makeFakeJobs(() => agent.id)
  provide('jobs', fake.runtime)
  agent.session.events = [
    { type: 'tool/call', data: { callId: 'replay-native', name: 'bash', arguments: JSON.stringify({
      command: 'sleep 11', description: ' Replay\n native task ', run_in_background: true,
    }) } },
    { type: 'tool/result', data: { message: { source: { callId: 'replay-native' },
      content: [{ type: 'text', text: 'started background job bash-replay' }] } } },
    { type: 'tool/ptc-dispatch', data: {
      rootCallId: 'replay-code', parentCallId: 'replay-code:outer', subCallId: 'replay-code:outer:pwsh', name: 'pwsh',
      arguments: { command: 'sleep 22', description: 'Replay PTC task' }, isError: false,
      content: [{ type: 'text', text: '[still running after 100ms; moved to background job pwsh-replay]' }],
    } },
    { type: 'tool/call', data: { callId: 'replay-output', name: 'job_output', arguments: JSON.stringify({ job_id: 'bash-replay' }) } },
    { type: 'tool/result', data: { message: { source: { callId: 'replay-output' }, content: [{ type: 'text', text: '[status: running]' }] } } },
  ].map((event, seq) => ({ ...event, seq, time: NOW + seq }))
  agent.session.seq = agent.session.events.length
  fake.register({ id: 'bash-replay', kind: 'bash', label: 'sleep 11', status: 'running', startedAt: NOW })
  const channel = createChannel(ctx as never, agent as never, { model: 'm0', cwd: '/tmp/demo', provider: 'p0', activity: false })
  try {
    fake.register({ id: 'pwsh-replay', kind: 'pwsh', label: 'sleep 22', status: 'running', startedAt: NOW })
    check('B17 replay native explicit + job_output 保留概述/命令/registry label',
      await settled(() => channel.backgroundJobs.some(job => job.id === 'bash-replay' && job.description === 'Replay native task'
        && job.command === 'sleep 11' && job.label === 'sleep 11')
        && jobRows(channel).some(row => row.job?.id === 'bash-replay' && row.job.description === 'Replay native task')),
      JSON.stringify(channel.backgroundJobs))
    check('B17 replay nested PTC timeout 先于 roster 保留概述/命令/registry label',
      await settled(() => channel.backgroundJobs.some(job => job.id === 'pwsh-replay' && job.description === 'Replay PTC task'
        && job.command === 'sleep 22' && job.label === 'sleep 22')
        && jobRows(channel).some(row => row.job?.id === 'pwsh-replay' && row.job.description === 'Replay PTC task')),
      JSON.stringify(channel.backgroundJobs))
  } finally {
    channel.releaseContributions()
  }
}

// 无 jobs 服务：功能静默降级，kill 返回 false。
{
  const ctx = new Context()
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  provide('agents', {
    get: () => undefined,
    create: () => Promise.resolve(makeHandle(makeAgent('agent-b', 'sess-b'))),
  })
  const channel = createChannel(ctx as never, makeAgent('agent-a', 'sess-a') as never, {
    model: 'm0', cwd: '/tmp/demo', provider: 'p0', activity: false,
  })
  await sleep(50) // 固定窗:探针 无 jobs 服务时快照必须始终为空（轮询空条件会立即返回）
  check('B7 无 jobs 服务：快照为空', channel.backgroundJobs.length === 0)
  check('B7 无 jobs 服务：kill 安全返回 false', channel.jobControl.kill('pwsh-9') === false)
}

// ---------------------------------------------------------------------------
// Group B2 — 内核事件总线集成（events.subscribe + readAt 非消费增量）
// ---------------------------------------------------------------------------
console.log('--- B2: kernel event bus integration ---')
{
  const ctx2 = new Context()
  const provide2 = (ctx2 as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx2)
  provide2('agents', {
    get: () => undefined,
    create: () => Promise.resolve(makeHandle(makeAgent('agent-k', 'sess-k'))),
  })

  /** 内核形状的假注册表：events 总线 + 环形 readAt（字节偏移切片）。 */
  const ring: string[] = []
  const listeners = new Set<(event: Record<string, unknown>) => void>()
  const shots = new Map<string, Record<string, unknown>>()
  let nextByte = 0
  const append = (text: string, channel?: string, gapBefore?: boolean): void => {
    ring.push((gapBefore ? '\u0000' : '') + JSON.stringify({ at: nextByte, text, ...(channel ? { channel } : {}), ...(gapBefore ? { gapBefore: true } : {}) }))
    nextByte += text.length
    for (const listener of listeners) listener({ type: 'output', id: 'pwsh-7', total: nextByte })
  }
  const kernelRuntime = {
    list: (caller?: string) => {
      if (caller !== 'agent-k-id') throw new Error('fence: caller must be the session id string')
      return [...shots.values()]
    },
    kill: (id: string, caller?: string) => {
      if (caller !== 'agent-k-id') throw new Error('fence: caller must be the session id string')
      return 'requested'
    },
    events: {
      subscribe: (_filter: unknown, listener: (event: Record<string, unknown>) => void) => {
        listeners.add(listener as (event: Record<string, unknown>) => void)
        return () => { listeners.delete(listener as (event: Record<string, unknown>) => void) }
      },
    },
    readAt: (id: string, from: number) => {
      if (id !== 'pwsh-7') throw new Error('unknown job')
      const chunks: Array<{ at: number; text: string; channel?: string; gapBefore?: true }> = []
      let next = from
      for (const raw of ring) {
        const gap = raw.startsWith('\u0000')
        const chunk = JSON.parse(gap ? raw.slice(1) : raw) as { at: number; text: string; channel?: string }
        if (chunk.at < from) continue
        chunks.push({ ...chunk, ...(gap ? { gapBefore: true } : {}) })
        next = chunk.at + chunk.text.length
      }
      return { chunks, next }
    },
  }
  provide2('jobs', kernelRuntime)
  const kernelAgent = makeAgent('agent-k', 'sess-k')
  // 会话 id 字符串才是围栏口径（Agent.id）；FakeAgent.id 字段直接充当。
  ;(kernelAgent as unknown as { id: string }).id = 'agent-k-id'
  const channel2 = createChannel(ctx2 as never, kernelAgent as never, {
    model: 'm0', cwd: '/tmp/demo', provider: 'p0', activity: false,
  })
  const emit2 = (event: string, ...args: unknown[]) =>
    (ctx2 as unknown as { emit(event: string, ...args: unknown[]): void }).emit(event, ...args)
  emit2('session/event', kernelAgent.session, {
    type: 'tool/call', data: { callId: 'kernel-start', name: 'pwsh', arguments: JSON.stringify({ command: 'kernel stream', run_in_background: true }) },
  })
  emit2('session/event', kernelAgent.session, {
    type: 'tool/result', data: { message: { source: { callId: 'kernel-start' }, content: [{ type: 'text', text: 'started background job pwsh-7' }] } },
  })

  shots.set('pwsh-7', {
    id: 'pwsh-7', kind: 'pwsh', label: 'kernel stream', status: 'running', startedAt: NOW,
    progress: '2/5', output: { total: 0, earliest: 0 },
  })
  for (const listener of listeners) listener({ type: 'registered', job: shots.get('pwsh-7') })
  check('B2a 内核 registered 事件建卡', await settled(() => channel2.backgroundJobs.length === 1))
  check(
    'B2a roster 携带 progress 进度行',
    await settled(() => channel2.backgroundJobs[0]?.progress === '2/5'),
    String(channel2.backgroundJobs[0]?.progress),
  )

  append('kernel line 1\n', 'stdout')
  append('kernel warn\n', 'stderr')
  check(
    'B2b output 事件拉取增量（通道落行）',
    await settled(() => {
      const lines = channel2.backgroundJobs[0]?.outputLines ?? []
      return lines.some(line => line.text === 'kernel line 1')
        && lines.some(line => line.text === 'kernel warn' && line.channel === 'stderr')
    }),
    JSON.stringify(channel2.backgroundJobs[0]?.outputLines),
  )
  check(
    'B2b 非消费游标推进（cursor 跟踪字节）',
    await settled(() => channel2.backgroundJobs[0]?.outputTotalBytes === 'kernel line 1\nkernel warn\n'.length),
    String(channel2.backgroundJobs[0]?.outputTotalBytes),
  )

  append('after gap\n', 'stdout', true)
  check(
    'B2c gapBefore → 丢失标记 + 行级 gap 标记',
    await settled(() => channel2.backgroundJobs[0]?.outputDropped === true
      && (channel2.backgroundJobs[0]?.outputLines ?? []).some(line => line.text === 'after gap' && line.gapBefore === true)),
    JSON.stringify(channel2.backgroundJobs[0]?.outputLines),
  )

  shots.set('pwsh-7', {
    id: 'pwsh-7', kind: 'pwsh', label: 'kernel stream', status: 'completed', detail: 'exit code: 0',
    startedAt: NOW, finishedAt: Date.now(), output: { total: nextByte, earliest: 0 },
  })
  const notices2 = channel2.notifications.length
  for (const listener of listeners) listener({ type: 'settled', job: shots.get('pwsh-7'), cause: 'producer', awaited: false })
  check(
    'B2d settled 事件 → 完成 toast',
    await settled(() => channel2.notifications.length > notices2
      && channel2.notifications.some(item => item.text.includes('pwsh-7'))),
    JSON.stringify(channel2.notifications.map(item => item.text)),
  )

  check(
    'B2e kill 以会话 id 字符串过围栏',
    channel2.jobControl.kill('pwsh-7') === true,
  )
}

// ---------------------------------------------------------------------------
// Group B3 — 会话换绑：订阅不得冻结在启动会话上
// ---------------------------------------------------------------------------
console.log('--- B3: session rebind (the roster must follow the binding) ---')
{
  // 现场：dsh-tui 启动先建一个全新会话，随后才恢复用户会话。jobs 投影在
  // 「服务注入」时 attach——那一刻若把订阅过滤器钉死成启动会话，内核之后会按
  // owner 丢弃全部事件，refresh 永不触发，面板永远停在 attach 时的空名册。
  const bootJob = { id: 'boot-job', kind: 'bash', label: 'boot work', status: 'running' as const, startedAt: 1 }
  const userJob = { id: 'user-job', kind: 'pwsh', label: 'user work', status: 'running' as const, startedAt: 2 }
  const calls: string[] = []
  const subs: Array<{ filter: Record<string, unknown>; listener: (event: Record<string, unknown>) => void }> = []
  const kernelJobs = {
    list(caller?: string) {
      calls.push(String(caller))
      if (caller === 'sess-boot') return [bootJob]
      if (caller === 'sess-user') return [userJob]
      return []
    },
    kill() {},
    readAt() { return { chunks: [], next: 0 } },
    events: {
      subscribe(filter: Record<string, unknown>, listener: (event: Record<string, unknown>) => void) {
        subs.push({ filter, listener })
        return () => {}
      },
    },
  }
  /** 内核投递口径：`ownerId !== filter.owner` 的事件直接丢弃。 */
  const emit = (event: Record<string, unknown>, ownerId: string): void => {
    for (const sub of subs) {
      if ('owner' in sub.filter && sub.filter.owner !== ownerId) continue
      sub.listener(event)
    }
  }
  let bound: { id: string } = { id: 'sess-boot' }
  const state = { backgroundJobs: [], rows: [], emit() {} }
  const projection = createJobProjection(
    () => state as never,
    {
      owner: { current: () => true, own: () => () => {} },
      notify: () => {},
      rowIds: { value: 0 },
      agent: () => bound as never,
      steer: () => {},
    },
  )
  const ids = (): string => projection.store.snapshot().map(job => job.id).join(',')
  projection.attach(kernelJobs as never)
  check('B3a 订阅不带 owner 过滤（带则换绑后事件全被内核丢弃）',
    subs.length === 1 && !('owner' in (subs[0]?.filter ?? {})), JSON.stringify(subs.map(sub => sub.filter)))
  check('B3b 挂载即按当前会话读名册', calls.length === 1 && calls[0] === 'sess-boot', calls.join(','))
  projection.reanchor()
  check('B3c 会话未变时 reanchor 不重复读（挂载只读一次）', calls.length === 1, calls.join(','))

  bound = { id: 'sess-user' }
  projection.reset()
  // Adoption replays the new log before bind/reanchor reads its live roster.
  projection.store.onStarted('user-job', 'user work', 'Resumed user task')
  projection.reanchor()
  check('B3d 换绑后按新会话重读且旧名册被替换',
    calls.at(-1) === 'sess-user' && ids() === 'user-job', `${calls.join(',')} → ${ids()}`)
  check('B3d 重锚保留新会话回放的后台移交与待注册 metadata', projection.store.isBackground('user-job')
    && projection.store.get('user-job')?.description === 'Resumed user task' && projection.store.get('user-job')?.command === 'user work'
    && projection.store.get('user-job')?.label === 'user work')

  const beforeEvent = calls.length
  emit({ type: 'registered', job: userJob }, 'sess-user')
  check('B3e 换绑后本会话事件仍能触发刷新（反证：订阅没被冻结）',
    calls.length === beforeEvent + 1 && calls.at(-1) === 'sess-user', calls.join(','))
  emit({ type: 'output', id: 'boot-job', total: 10 }, 'sess-other')
  check('B3f 他人会话的输出事件被围栏挡住（不崩、不污染名册）',
    calls.length === beforeEvent + 1 && ids() === 'user-job', `${calls.join(',')} → ${ids()}`)
}

// ---------------------------------------------------------------------------
// Group C — 渲染冒烟
// ---------------------------------------------------------------------------
console.log('--- C: render smoke ---')
const COLS = 70
const ROWS = 24
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  constructor(private term: InstanceType<typeof XTerm>) { super() }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.term.write(String(chunk), callback)
  }
}
class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
async function withTerminal(
  make: () => React.ReactNode,
  run: (screen: () => string, rerender: (node: React.ReactNode) => void, stdin: Input, term: InstanceType<typeof XTerm>) => Promise<void>,
  columns = COLS,
): Promise<void> {
  const term = new XTerm({ cols: columns, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term) as unknown as NodeJS.WriteStream
  stdout.columns = columns
  const stdin = new Input()
  const instance = await render(make(), {
    stdout,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const screen = (): string =>
    Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n')
  try {
    await run(screen, node => instance.rerender(node), stdin, term)
  } finally {
    await instance.unmount()
    term.dispose()
  }
}

// ThemedText's dimColor uses inactive RGB rather than the ANSI faint flag.
function textHasStyle(term: InstanceType<typeof XTerm>, text: string, style: 'bold' | 'inactive'): boolean {
  const channels = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(getTheme('dark').inactive)
  if (channels === null) throw new Error('Expected the dark theme inactive color to use rgb()')
  const inactiveRgb = (Number(channels[1]) << 16) | (Number(channels[2]) << 8) | Number(channels[3])
  for (let y = 0; y < ROWS; y += 1) {
    const line = term.buffer.active.getLine(y)
    if (line === undefined) continue
    for (let x = 0; x < term.cols; x += 1) {
      let matched = ''
      let styled = true
      for (let column = x; column < term.cols && matched.length < text.length; column += 1) {
        const cell = line.getCell(column)
        // Cursor-skipped blank cells have no chars; wide-glyph continuation
        // cells also have no chars but must not add a second space.
        const chars = cell?.getWidth() === 0 ? '' : cell?.getChars() || ' '
        matched += chars
        if (chars !== '' && chars.trim() !== '') styled &&= style === 'bold'
          ? Boolean(cell?.isBold())
          : cell?.isFgRGB() === true && cell.getFgColor() === inactiveRgb && !cell.isBold()
        if (!text.startsWith(matched)) break
      }
      if (matched === text && styled) return true
    }
  }
  return false
}

const runningJob = {
  id: 'pwsh-1', kind: 'pwsh', label: 'gh pr checks --watch 42', description: 'Watch CI results', status: 'running' as const,
  command: 'gh pr checks --watch 42',
  startedAt: Date.now() - 65_000, outputLines: [{ text: 'build step 1 ok' }, { text: 'build step 2 ok' }],
}
await withTerminal(
  () => React.createElement(JobCard, { job: runningJob, marginTopOnTurn: false }),
  async screen => {
    // 固定窗:待迁移 一个 sleep 服务同一快照上的多条正/负混合断言，
    // 迁移需把全部条件合进一个 settled 谓词并在其中捕获快照，非平凡改写。
    await sleep(150)
    const text = screen()
    check('C1 运行卡头优先概述并保留 ID/kind', text.includes('job: Watch CI results') && text.includes('pwsh-1')
      && text.includes('pwsh') && !text.includes(runningJob.label))
    check('C1 瀑布呈现镜像输出', text.includes('build step 1 ok') && text.includes('build step 2 ok'))
  },
)
await withTerminal(
  () => React.createElement(JobCard, {
    job: { ...runningJob, outputLines: [] },
    marginTopOnTurn: false,
  }),
  async screen => {
    // 固定窗:待迁移 一个 sleep 服务同一快照上的多条正/负混合断言，
    // 迁移需把全部条件合进一个 settled 谓词并在其中捕获快照，非平凡改写。
    await sleep(150)
    const text = screen()
    check(
      'C1 无输出时卡片仅头行（无空瀑布 gutter）',
      // 头行本身就带机器活动竖线（`│ ● job: …`），「只有头行」不能再写成
      // 「不含 │」——按非空行数断言：整张卡占一行。
      text.includes('job: Watch CI results') && text.split('\n').filter(line => line.trim() !== '').length === 1,
      text.split('\n').filter(line => line.trim() !== '').join('|'),
    )
  },
)
await withTerminal(
  () => React.createElement(JobCard, {
    job: { ...runningJob, status: 'completed' as const, detail: 'exit code: 0', finishedAt: Date.now() },
    marginTopOnTurn: false,
  }),
  async screen => {
    // 固定窗:待迁移 一个 sleep 服务同一快照上的多条正/负混合断言，
    // 迁移需把全部条件合进一个 settled 谓词并在其中捕获快照，非平凡改写。
    await sleep(150)
    const text = screen()
    check('C2 落定卡折叠（无瀑布行）', !text.includes('│ build step 1 ok'))
    check('C2 落定卡头含 exit detail', text.includes('exit code: 0'))
  },
)
await withTerminal(
  () => React.createElement(JobsPanel, {
    jobs: [
      runningJob,
      { id: 'bash-2', kind: 'bash', label: 'pnpm build', status: 'completed' as const, detail: 'exit code: 0', startedAt: NOW - 90_000, finishedAt: NOW - 1000, outputLines: [] },
    ],
    onClose: () => {},
    onKill: () => {},
  }),
  async screen => {
    // 固定窗:待迁移 一个 sleep 服务同一快照上的多条正/负混合断言，
    // 迁移需把全部条件合进一个 settled 谓词并在其中捕获快照，非平凡改写。
    await sleep(150)
    const text = screen()
    check('C3 面板标题与两行任务', text.includes('Background Jobs') && text.includes('pwsh-1') && text.includes('bash-2'))
    check('C3 面板含操作提示', text.includes('press k twice'), text.split('\n').at(-3) ?? '')
    // 聚焦第一行（默认）→ 详情块展开：完整任务名 + 开始时间 + 输出尾巴。
    check('C3 聚焦行优先概述且详情含开始时间', text.includes('Watch CI results') && text.includes('started'), text.split('\n').slice(0, 8).join('|'))
    check('C3 聚焦行详情含完整命令', text.includes('command') && text.includes('gh pr checks --watch 42'), text.split('\n').slice(0, 8).join('|'))
    check('C3 聚焦行详情含镜像输出尾巴', text.includes('build step 1 ok') && text.includes('build step 2 ok'))
    // 非聚焦行不展开详情（bash-2 无输出 → 其无输出提示也不应出现）。
    check('C3 非聚焦行无详情块', !text.includes('no mirrored output yet'))
  },
)

for (const columns of [40, 100]) {
  for (const status of ['running', 'completed'] as const) {
    const description = 'Inspect jobs 🧪 regression headers without losing IDs'
    const job = { ...runningJob, description, status, outputLines: [],
      startedAt: NOW - 1000, ...(status === 'completed' ? { finishedAt: NOW } : {}) }
    await withTerminal(
      () => React.createElement(JobCard, { job, marginTopOnTurn: false }),
      async (screen, _rerender, _stdin, term) => {
        check(`C4 ${columns}列 ${status} 概述折行、ID/kind/状态留在首行`, await settled(() => {
          const lines = screen().split('\n').filter(line => line.trim() !== '')
          return (columns === 100 ? lines.length === 1 : lines.length > 1) && lines[0].includes('job: ')
            && lines[0].includes('pwsh-1 pwsh') && lines[0].includes(status)
            && lines.some(line => line.includes('IDs'))
        }), screen())
        const header = screen().split('\n').find(line => line.includes('job: ')) ?? ''
        check(`C4 ${columns}列 ${status} 概述优先且窄宽不截断`, !screen().includes(job.label)
          && (columns === 100 ? header.includes(`job: ${description}`) : !header.includes('…')), header)
        check(`C4 ${columns}列 ${status} prefix+标题粗体、ID+kind dim`,
          textHasStyle(term, columns === 100 ? `job: ${description}` : 'job:', 'bold')
            && textHasStyle(term, 'pwsh-1 pwsh', 'inactive'), header)
      },
      columns,
    )
  }
}
await withTerminal(
  () => React.createElement(JobCard, { job: { ...runningJob, description: undefined, outputLines: [] }, marginTopOnTurn: false }),
  async screen => {
    check('C5 缺失概述的卡片标题回退 registry label', await settled(() => screen().includes(`job: ${runningJob.label}`)), screen())
  },
  100,
)

await withTerminal(
  () => React.createElement(JobsPanel, {
    jobs: [
      runningJob,
      { id: 'bash-2', kind: 'bash', label: 'pnpm build', status: 'completed' as const, detail: 'exit code: 0', startedAt: NOW - 90_000, finishedAt: NOW - 1000, outputLines: [] },
      { id: 'subagent-3', kind: 'subagent', label: 'review the regressions', status: 'running' as const, startedAt: NOW - 10_000, outputLines: [] },
    ],
    initialFocusId: 'subagent-3',
    onClose: () => {},
    onKill: () => {},
  }),
  async screen => {
    await sleep(150) // 固定窗:探针 C4 渲染落定（initialFocusId 聚焦行渲染）
    const text = screen()
    const rows = text.split('\n')
    check(
      'C4 initialFocusId 聚焦指定任务（非首行）',
      rows.some(line => line.includes('review the regressions') && line.includes('❯')),
      rows.filter(line => line.includes('❯') || line.includes('subagent-3')).join('|'),
    )
    check(
      'C4 默认首行不被聚焦',
      !rows.some(line => line.includes('pwsh-1') && line.includes('❯')),
      rows.filter(line => line.includes('pwsh-1')).join('|'),
    )
  },
)

await withTerminal(
  () => React.createElement(JobsPanel, {
    jobs: [runningJob],
    initialFocusId: 'gone-job',
    onClose: () => {},
    onKill: () => {},
  }),
  async screen => {
    await sleep(150) // 固定窗:探针 C4 渲染落定（回退首行用例）
    const text = screen()
    check('C4 未知 initialFocusId 回退首行', text.includes('❯') && text.includes('pwsh-1'))
  },
)
// ---------------------------------------------------------------------------
// Group D — 按键归属：/jobs 面板打开时 Esc 关面板，不得同时中断对话
// ---------------------------------------------------------------------------
console.log('--- D: /jobs panel owns Esc ---')
{
  const cancelled: string[] = []
  const panelJob = {
    id: 'pwsh-7', kind: 'pwsh', label: 'gh run watch 42', status: 'running' as const,
    command: 'gh pr checks --watch 42', startedAt: NOW - 5_000, outputLines: [],
  }
  const channel: Record<string, unknown> = {
    version: 0,
    rows: [],
    status: 'idle',
    sessionTitle: 'jobs esc probe',
    agentId: 'probe',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    tokens: { input: 0, output: 0 },
    cwd: '/tmp/demo',
    displayCwd: '/tmp/demo',
    // /jobs 是 idle-only 的指挥行（working 时 Enter 走插话），所以初始为 idle：
    // 面板先打开，再让回合变成在跑（点转录任务卡进面板、或面板开着时回合起跑），
    // 这正是 bug 的现场——面板开着 + 回合在跑。
    working: false,
    spinnerMode: 'idle',
    responseChars: 0,
    activeToolCount: 0,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode(): void {},
    turnStart: NOW,
    lastUserText: '',
    pending: [],
    commandList: [{ name: 'jobs', description: 'Show background jobs of this session' }],
    commandCompletions: () => [{
      name: 'jobs',
      description: 'Show background jobs of this session',
      replacement: '/jobs',
      commandLine: '/jobs',
    }],
    notifications: [],
    activityEnabled: false,
    activityFrames: [],
    backgroundJobs: [panelJob],
    jobControl: { kill: () => true },
    subscribe: () => () => {},
    submit: (): void => {},
    cancel: (): void => { cancelled.push('cancel') },
    clear: (): void => {},
    notify: (): void => {},
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: (): void => {},
    stageImage: () => Promise.resolve(''),
    listSubagents: () => Promise.resolve([]),
    lastUsage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    contextWindow: 1_000_000,
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    tps: undefined,
    tpsSamples: [],
    reasoningEffort: 'high',
    agentPreset: 'standard',
  }

  await withTerminal(
    () => React.createElement(Chat, {
      channel: channel as never,
      questionStore: new QuestionStore() as never,
      onExit: () => {},
      fullscreen: true,
      trajectorySeen: true,
    }),
    async (screen, _rerender, stdin) => {
      // 等首帧上屏（等待后操作 → settle）再发键。
      await settle(() => screen().includes('❯'))
      // 打开面板：整行一次写入 → PromptInput 直接派发 /jobs。
      stdin.write('/jobs\r')
      check('D1 /jobs 打开后台任务面板', await settled(() => screen().includes('Background Jobs')), screen().split('\n')[0] ?? '')
      // 面板开着时回合起跑（字段按 key 时实时读取，无需重渲染）。
      channel.working = true
      channel.status = 'working'
      channel.spinnerMode = 'working'
      check('D1 面板已打开时回合在跑且未被打断', cancelled.length === 0)
      // Esc：面板拥有键盘 → 只关面板（等待后断言 → settled 把终值直接交给 check）。
      stdin.write('\x1b')
      check('D2 面板打开时 Esc 关闭面板', await settled(() => !screen().includes('Background Jobs')), screen().split('\n')[0] ?? '')
      check('D2 同一次 Esc 不中断对话', cancelled.length === 0, JSON.stringify(cancelled))
      // 反证：无面板时同一个 Esc 仍需中断，证明 D2 不是"Esc 根本没送达"。
      const before = cancelled.length
      stdin.write('\x1b')
      check('D3 面板关闭后 Esc 恢复中断对话', await settled(() => cancelled.length === before + 1), JSON.stringify(cancelled))
    },
  )
}

// Whole-screen evidence: the real channel feeds Chat in narrow inline and
// fullscreen modes, so a hidden foreground record cannot leak via rendering.
console.log('--- E: narrow Chat foreground/background projection ---')
for (const fullscreen of [false, true]) {
  const mode = fullscreen ? 'fullscreen' : 'inline'
  const ctx = new Context()
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  const emit = (event: string, ...args: unknown[]) =>
    (ctx as unknown as { emit(event: string, ...args: unknown[]): void }).emit(event, ...args)
  const agent = makeAgent(`screen-${mode}`, `screen-${mode}`)
  const fake = makeFakeJobs(() => agent.id)
  provide('jobs', fake.runtime)
  const channel = createChannel(ctx as never, agent as never, {
    model: 'm0', cwd: '/tmp/demo', provider: 'p0', activity: false,
  })
  const result = (callId: string, text: string): void => {
    emit('session/event', agent.session, {
      type: 'tool/result', data: { message: { source: { callId }, content: [{ type: 'text', text }] } },
    })
  }
  try {
    await withTerminal(
      () => React.createElement(Chat, {
        channel: channel as never, questionStore: new QuestionStore() as never,
        onExit: () => {}, fullscreen, trajectorySeen: true,
      }),
      async screen => {
        emit('session/event', agent.session, {
          type: 'tool/call', data: { callId: 'screen-fg', name: 'bash', arguments: JSON.stringify({ command: 'printf foreground-output', description: 'Foreground probe' }) },
        })
        fake.register({ id: 'bash-fg', kind: 'bash', label: 'foreground', status: 'running', startedAt: NOW })
        fake.update({ id: 'bash-fg', kind: 'bash', label: 'foreground', status: 'completed', startedAt: NOW, finishedAt: NOW })
        fake.remove('bash-fg')
        result('screen-fg', 'foreground-output')
        check(`E ${mode} 40列前台工具输出上屏`, await settled(() => screen().includes('foreground-output')))
        check(`E ${mode} 40列不重复显示前台 job`, !screen().includes('job:')
          && jobRows(channel).length === 0 && channel.backgroundJobs.length === 0)

        emit('session/event', agent.session, {
          type: 'tool/call', data: { callId: 'screen-bg', name: 'bash', arguments: JSON.stringify({ command: 'sleep 99', description: 'Wait for checks', run_in_background: true }) },
        })
        fake.register({ id: 'bash-bg', kind: 'bash', label: 'sleep 99', status: 'running', startedAt: NOW })
        result('screen-bg', 'started background job bash-bg')
        check(`E ${mode} 40列真正后台 job 概述卡上屏`, await settled(() => screen().split('\n').some(line =>
          line.includes('job: Wait') && line.includes('bash-bg') && line.includes('running'))
          && channel.backgroundJobs.some(job => job.id === 'bash-bg' && job.description === 'Wait for checks')), screen())
        fake.update({ id: 'bash-bg', kind: 'bash', label: 'sleep 99', status: 'completed', detail: 'exit code: 0', startedAt: NOW, finishedAt: NOW })
        check(`E ${mode} 40列后台任务可落定`, await settled(() => screen().includes('completed')))
      },
      40,
    )
  } finally {
    channel.releaseContributions()
  }
}

// ---------------------------------------------------------------------------
// Group F — 侧栏形态的列宽分配纯函数（panel variant 的行网格契约）
// ---------------------------------------------------------------------------
console.log('--- F: panel-variant column allocation ---')
{
  const full = resolveJobsRowColumns(52)
  check('E1 宽面板（52）三列全开', full.showProgress && full.showDuration && full.showStatus && full.idWidth === 9 && full.statusWidth === 9 && !full.labelWrap)
  const mid46 = resolveJobsRowColumns(46)
  check('E1 中宽面板（46）无进度列、有时长与状态', !mid46.showProgress && mid46.showDuration && mid46.showStatus)
  const mid = resolveJobsRowColumns(38)
  check('E1 中等面板（38）无进度列、有时长与状态', !mid.showProgress && mid.showDuration && mid.showStatus)
  const narrow = resolveJobsRowColumns(30)
  check('E1 窄面板（30）省略时长列、保留状态列', !narrow.showProgress && !narrow.showDuration && narrow.showStatus)
  const min = resolveJobsRowColumns(28)
  check('E1 minColumns=28 仍有状态列', min.showStatus && !min.showProgress && !min.showDuration)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nALL PASS')

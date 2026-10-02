#!/usr/bin/env node
// Run: node scripts/verify-local-install-rollback.mjs (no compile required).
// Copies the installer into disposable repos/profiles; compile, pack and DSH
// are stubs. Never reads or installs into the user's real DSH profile/store.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32') {
  console.log('SKIP: local-install.sh requires a POSIX shell')
  process.exit(0)
}
const repo = fileURLToPath(new URL('../', import.meta.url))
const packageName = '@deepseek-harness-tui/dsh-tui'
const root = mkdtempSync(join(tmpdir(), 'dsh-tui-install-rollback-'))
const put = (path, content) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
const tree = directory => {
  const entries = {}
  const walk = (path, prefix = '') => {
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name)
      const key = prefix + name
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) entries[key] = ['link', readlinkSync(file)]
      else if (stat.isDirectory()) { entries[key] = ['dir']; walk(file, key + '/') }
      else entries[key] = ['file', readFileSync(file).toString('base64'), stat.mode & 0o777]
    }
  }
  walk(directory)
  return entries
}

const stub = join(root, 'stub.mjs')
put(stub, `import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
const [command, ...args] = process.argv.slice(2)
const { MODE: mode, PROFILE_DIR: profile, FIXTURE: fixture, LAYOUT: layout, STATE: state } = process.env
const entry = join(profile, 'node_modules', '${packageName}')
const target = layout === 'isolated' ? join(profile, 'node_modules/.pnpm/tui-old/node_modules', '${packageName}') : entry
const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value) }
appendFileSync(state, JSON.stringify({ command, args, entryExists: existsSync(entry) }) + '\\n')
const config = () => {
  const path = join(profile, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  manifest.dependencies['${packageName}'] = args.find(a => a.startsWith('file:'))
  put(path, JSON.stringify(manifest) + '\\n')
  put(join(profile, 'pnpm-lock.yaml'), '# new lock ' + manifest.dependencies['${packageName}'] + '\\n')
}
const install = wrong => {
  // Model pnpm rewriting the old real package AND its dependency closure.
  rmSync(target, { recursive: true, force: true })
  rmSync(join(profile, 'node_modules/old-dep'), { recursive: true, force: true })
  rmSync(join(profile, 'node_modules/.pnpm/dep-old'), { recursive: true, force: true })
  cpSync(join(fixture, 'package'), target, { recursive: true })
  if (layout === 'isolated' && !existsSync(entry)) { mkdirSync(dirname(entry), { recursive: true }); symlinkSync('../.pnpm/tui-old/node_modules/${packageName}', entry) }
  if (wrong) put(join(target, 'lib/types/index.js'), "export const label = 'wrong'\\n")
  if (mode === 'missing-lib') rmSync(join(target, 'lib'), { recursive: true, force: true })
}
if (command === 'git') process.stdout.write(args.includes('--abbrev-ref') ? 'v0.12.0-patch\\n' : 'bc79ca99\\n')
else if (command === 'npm') {
  const output = join(args[args.indexOf('--pack-destination') + 1], 'deepseek-harness-tui-dsh-tui-0.12.0.tgz')
  const run = spawnSync('tar', ['-czf', output, '-C', fixture, 'package'])
  if (run.status !== 0) process.exit(run.status ?? 1)
  if (mode === 'unpack-fail') writeFileSync(output, 'invalid archive')
  if (mode === 'pack-fail') process.exit(41)
} else if (command === 'dsh') {
  if (mode === 'before-add') process.exit(42)
  config()
  install(!['success', 'partial-add', 'restore-fail'].includes(mode))
  if (mode === 'terminated-add') process.kill(process.ppid, 'SIGTERM')
  if (['partial-add', 'restore-fail'].includes(mode)) process.exit(42)
} else if (command === 'corepack') {
  if (args.includes('compile')) process.exit(0)
  install(mode !== 'relink-success')
  if (mode === 'relink-fail') process.exit(43)
} else if (command === 'mv') {
  if (mode === 'restore-fail' && args[0] === join(profile, '.dsh-tui-local-install.lock/node_modules')) process.exit(44)
  const run = spawnSync('/bin/mv', args, { stdio: 'inherit' })
  process.exit(run.status ?? 1)
}
`)
function verify(layout, mode, options = {}) {
  const dir = join(root, `${layout}-${mode}-${Object.keys(options).join('-')}`)
  const fakeRepo = join(dir, 'repo')
  const profile = join(dir, 'dsh home/profiles/test-profile')
  const packDir = join(profile, 'local-packages')
  const fixture = join(dir, 'fixture')
  const bin = join(dir, 'bin')
  const state = join(dir, 'calls.jsonl')
  const entry = join(profile, 'node_modules', packageName)
  const target = layout === 'isolated' ? join(profile, 'node_modules/.pnpm/tui-old/node_modules', packageName) : entry
  for (const path of [bin, packDir, join(dir, 'home'), join(dir, 'tmp')]) mkdirSync(path, { recursive: true })
  for (const file of ['local-install.sh', 'with-publish-manifest.mjs']) {
    put(join(fakeRepo, 'scripts', file), readFileSync(join(repo, 'scripts', file)))
  }
  const development = JSON.stringify({ name: packageName, version: '0.12.0', dependencies: { '@dsh-std/core': 'workspace:*' } }) + '\n'
  put(join(fakeRepo, 'package.json'), development)
  for (const name of ['command', 'connection', 'core', 'manifest', 'messages', 'presentation', 'storage']) {
    put(join(fakeRepo, 'vendor/dsh-std/packages', name, 'package.json'), JSON.stringify({ name: `@dsh-std/${name}`, version: '1.0.0' }))
  }
  put(join(fakeRepo, 'vendor/mathjax-tex-svg/package.json'), '{"version":"1.0.0"}')
  const manifest = { name: packageName, version: '0.12.0', type: 'module', main: './lib/types/index.js' }
  put(join(target, 'package.json'), JSON.stringify(manifest))
  const store = join(dir, 'store/old-index.js')
  const oldModule = "import { value } from 'old-dep'; export const label = 'old:' + value\n"
  put(store, oldModule)
  mkdirSync(join(target, 'lib/types'), { recursive: true })
  linkSync(store, join(target, 'lib/types/index.js'))
  const dependency = layout === 'isolated' ? join(profile, 'node_modules/.pnpm/dep-old/node_modules/old-dep') : join(profile, 'node_modules/old-dep')
  put(join(dependency, 'package.json'), '{"name":"old-dep","type":"module","main":"index.js"}')
  put(join(dependency, 'index.js'), "export const value = 'dependency'\n")
  if (layout === 'isolated') {
    mkdirSync(dirname(entry), { recursive: true })
    symlinkSync('../.pnpm/tui-old/node_modules/' + packageName, entry)
    symlinkSync('../../dep-old/node_modules/old-dep', join(profile, 'node_modules/.pnpm/tui-old/node_modules/old-dep'))
  }
  put(join(profile, 'node_modules/unrelated/keep.txt'), 'unrelated installation\n')
  put(join(profile, 'node_modules/.modules.yaml'), 'old pnpm layout metadata\n')
  const oldTar = join(packDir, 'deepseek-harness-tui-dsh-tui-0.12.0.tgz')
  const oldArchive = join(dir, 'old-archive')
  cpSync(target, join(oldArchive, 'package'), { recursive: true })
  assert.equal(spawnSync('tar', ['-czf', oldTar, '-C', oldArchive, 'package']).status, 0)
  const tarBytes = readFileSync(oldTar)
  const spec = 'file:' + (options.absoluteTar ? oldTar : 'local-packages/' + oldTar.split('/').at(-1))
  const profileManifest = JSON.stringify({ private: true, dependencies: { [packageName]: spec, unrelated: '1.0.0' }, dsh: { profile: { bundles: [packageName] } }, userField: 'keep' }) + '\n'
  put(join(profile, 'package.json'), profileManifest)
  const lock = '# old lock ' + spec + '\n'
  if (!options.noLock) put(join(profile, 'pnpm-lock.yaml'), lock)
  const untouched = ['cordis.patch.yml', 'pnpm-workspace.yaml', '.npmrc', 'user-data.txt']
  for (const name of untouched) put(join(profile, name), `user-owned ${name}\n`)
  put(join(fixture, 'package/package.json'), JSON.stringify(manifest))
  put(join(fixture, 'package/lib/types/index.js'), "export const label = 'new'\n")
  if (options.externalLink) {
    put(join(dir, 'external/package.json'), '{}')
    symlinkSync(join(dir, 'external'), join(profile, 'node_modules/external'))
  }
  const before = tree(join(profile, 'node_modules'))
  for (const command of ['git', 'npm', 'corepack', 'dsh', 'mv']) {
    put(join(bin, command), `#!/bin/sh\nexec "${process.execPath}" "${stub}" ${command} "$@"\n`)
    chmodSync(join(bin, command), 0o755)
  }
  put(join(bin, 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`)
  chmodSync(join(bin, 'node'), 0o755)
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: join(dir, 'home'), USERPROFILE: join(dir, 'home'), DSH_HOME: join(dir, 'dsh home'), DSH_TUI_PACK_DIR: packDir, TMPDIR: join(dir, 'tmp'), PROFILE_DIR: profile, FIXTURE: fixture, LAYOUT: layout, MODE: mode, STATE: state }
  const lockDir = join(profile, '.dsh-tui-local-install.lock')
  if (options.lockHeld) put(join(lockDir, 'owner'), 'another installer\n')
  const run = spawnSync('/bin/sh', [join(fakeRepo, 'scripts/local-install.sh'), 'test-profile'], { cwd: fakeRepo, env, encoding: 'utf8', timeout: 20000 })
  assert.equal(run.error, undefined)
  const success = ['success', 'relink-success'].includes(mode) && !options.lockHeld && !options.externalLink
  const expected = options.lockHeld || options.externalLink || mode === 'restore-fail' ? 1 : ({ 'before-add': 42, 'partial-add': 42, 'relink-fail': 43, 'pack-fail': 41, 'terminated-add': 143 }[mode] ?? (success ? 0 : 1))
  assert.equal(run.status, expected, `${layout}/${mode}: ${run.stdout}\n${run.stderr}`)
  const calls = existsSync(state) ? readFileSync(state, 'utf8').trim().split('\n').map(JSON.parse) : []
  if (options.lockHeld || options.externalLink) assert.equal(calls.some(call => call.command === 'dsh' || call.command === 'npm'), false, 'reject before mutating the profile/tarball')
  else if (!['pack-fail'].includes(mode)) assert.equal(calls.find(call => call.command === 'dsh')?.entryExists, false)
  const fresh = spawnSync(process.execPath, ['--input-type=module', '-e', `import { createRequire } from 'node:module'; const path = createRequire(${JSON.stringify(join(profile, 'package.json'))}).resolve(${JSON.stringify(packageName)}); console.log((await import(path)).label)`], { env, encoding: 'utf8' })
  if (mode === 'restore-fail') {
    assert.match(run.stderr, /恢复失败/)
    assert.doesNotMatch(run.stderr, /已恢复/)
    assert.equal(existsSync(join(lockDir, 'node_modules', packageName, 'lib/types/index.js')), true, 'retain usable backup after recovery failure')
    assert.equal(fresh.status === 0 && fresh.stdout.trim() === 'old:dependency', false)
  } else {
    assert.equal(fresh.status, 0, `${layout}/${mode}: new process cannot resolve old dependency closure: ${fresh.stderr}`)
    assert.equal(fresh.stdout.trim(), success ? 'new' : 'old:dependency')
    assert.equal(existsSync(lockDir), Boolean(options.lockHeld), 'release own lock only')
  }
  if (success) {
    const installedManifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
    const newSpec = installedManifest.dependencies[packageName]
    assert.equal(newSpec, 'file:' + oldTar)
    assert.equal(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8'), '# new lock ' + newSpec + '\n')
    assert.notDeepEqual(readFileSync(oldTar), tarBytes)
  } else {
    assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), profileManifest)
    assert.equal(existsSync(join(profile, 'pnpm-lock.yaml')), !options.noLock)
    if (!options.noLock) assert.equal(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8'), lock)
    assert.deepEqual(readFileSync(oldTar), tarBytes, 'restore exact old tarball even if pack overwrote the same filename')
    if (mode !== 'restore-fail') assert.deepEqual(tree(join(profile, 'node_modules')), before)
  }
  assert.equal(readFileSync(store, 'utf8'), oldModule, 'never mutate pnpm store/hardlink source')
  assert.equal(readFileSync(join(profile, 'node_modules/unrelated/keep.txt'), 'utf8'), 'unrelated installation\n')
  for (const name of untouched) assert.equal(readFileSync(join(profile, name), 'utf8'), `user-owned ${name}\n`)
  assert.equal(readFileSync(join(fakeRepo, 'package.json'), 'utf8'), development)
  if (!success && !options.lockHeld && !options.externalLink && mode !== 'restore-fail') assert.match(run.stderr, /已恢复/)
  console.log(`PASS ${layout}/${mode}${Object.keys(options).length ? ' ' + JSON.stringify(options) : ''}`)
}

try {
  for (const layout of ['hoisted', 'isolated']) {
    for (const mode of ['before-add', 'partial-add', 'terminated-add', 'relink-fail', 'mismatch', 'missing-lib', 'pack-fail', 'unpack-fail', 'success', 'relink-success', 'restore-fail']) verify(layout, mode)
    verify(layout, 'partial-add', { absoluteTar: true, noLock: true })
    verify(layout, 'success', { lockHeld: true })
    verify(layout, 'success', { externalLink: true })
  }
  console.log('local-install rollback: 28 disposable profile cases passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}

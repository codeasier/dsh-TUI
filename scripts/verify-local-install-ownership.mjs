#!/usr/bin/env node
/**
 * Run with `node scripts/verify-local-install-ownership.mjs`; no build required.
 * Exercises the real installer and publish-manifest wrapper with real npm pack,
 * a compile stub and a fake dsh profile installer. The temporary fixture has
 * its own HOME: neither the working tree's lib/ nor the user's profiles are touched.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { test } from 'node:test'

const packageName = '@deepseek-harness-tui/dsh-tui'
const filename = version => `deepseek-harness-tui-dsh-tui-${version}.tgz`

function write(path, content, executable = false) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, executable ? { mode: 0o755 } : undefined)
}

function command(name, args, options = {}) {
  const result = spawnSync(name, args, { encoding: 'utf8', timeout: 30_000, ...options })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${name}: ${result.stdout}\n${result.stderr}`)
  return result
}

function withFixture(options, run) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tui-install-ownership-'))
  try {
    const repo = join(root, 'repo')
    const home = join(root, 'home')
    const dshHome = join(home, '.dsh')
    const profile = join(dshHome, 'profiles', 'target')
    const otherProfile = join(dshHome, 'profiles', 'other')
    const bin = join(root, 'bin')
    const packDir = options.defaultDir
      ? join(profile, 'local-packages')
      : join(root, 'shared packages')
    const installLog = join(root, 'install-paths.jsonl')
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DSH_HOME: dshHome,
      DSH_TUI_PACK_DIR: packDir,
      PATH: `${bin}:${process.env.PATH}`,
      FIXTURE_INSTALL_LOG: installLog,
      FIXTURE_FAIL_ADD: options.failAdd ? '1' : '0',
      FIXTURE_MARKER: 'current build',
      npm_config_cache: join(root, 'npm-cache'),
      npm_config_update_notifier: 'false',
    }
    if (options.defaultDir) delete env.DSH_TUI_PACK_DIR
    if (options.relativeDir) env.DSH_TUI_PACK_DIR = 'relative packages'
    const destination = options.relativeDir ? join(repo, env.DSH_TUI_PACK_DIR) : packDir
    for (const path of [repo, home, profile, otherProfile, bin, destination]) {
      mkdirSync(path, { recursive: true })
    }

    const manifest = JSON.stringify({
      name: packageName,
      version: '0.12.0',
      files: ['lib'],
      dependencies: { '@dsh-std/core': 'workspace:*' },
    }, null, 2) + '\n'
    write(join(repo, 'package.json'), manifest)
    for (const script of ['local-install.sh', 'with-publish-manifest.mjs']) {
      mkdirSync(join(repo, 'scripts'), { recursive: true })
      copyFileSync(new URL(script, import.meta.url), join(repo, 'scripts', script))
    }
    for (const name of ['command', 'connection', 'core', 'manifest', 'messages', 'presentation', 'storage']) {
      write(join(repo, 'vendor/dsh-std/packages', name, 'package.json'), '{"version":"0.1.0"}')
    }
    write(join(repo, 'vendor/mathjax-tex-svg/package.json'), '{"version":"0.0.0"}')
    write(join(bin, 'git'), '#!/bin/sh\ncase "$*" in\n  *--abbrev-ref*) printf "v0.12.0-patch\\n" ;;\n  *) printf "bc79ca99\\n" ;;\nesac\n', true)
    write(join(bin, 'corepack'), `#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
assert.equal(process.argv.at(-1), 'compile')
mkdirSync('lib', { recursive: true })
writeFileSync('lib/index.js', process.env.FIXTURE_MARKER)
`, true)
    write(join(bin, 'dsh'), `#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
assert.deepEqual(args.slice(0, 4), ['plugin', '--profile', 'target', 'add'])
assert.ok(args[4].startsWith('file:'))
const tarball = args[4].slice(5)
appendFileSync(process.env.FIXTURE_INSTALL_LOG, JSON.stringify(tarball) + '\\n')
if (process.env.FIXTURE_FAIL_ADD === '1') process.exit(42)
const profile = join(process.env.DSH_HOME, 'profiles', 'target')
const installed = join(profile, 'node_modules', '${packageName}')
mkdirSync(installed, { recursive: true })
const result = spawnSync('tar', ['-xzf', tarball, '-C', installed, '--strip-components=1'])
assert.equal(result.status, 0, String(result.stderr))
writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { '${packageName}': args[4] } }))
`, true)

    // Seed a valid, externally referenced tarball, including the canonical
    // same-version filename when testing npm pack's overwrite behavior.
    const oldVersion = options.sameVersion ? '0.12.0' : '0.11.0'
    const seed = join(root, 'seed')
    write(join(seed, 'package.json'), JSON.stringify({ name: packageName, version: oldVersion, files: ['lib'] }))
    write(join(seed, 'lib/index.js'), 'old referenced build')
    command('npm', ['pack', '--ignore-scripts', '--pack-destination', destination], { cwd: seed, env })
    const referenced = join(destination, filename(oldVersion))
    const unknown = join(destination, 'other-plugin.tgz')
    write(unknown, Buffer.from([0, 255, 13, 10, 42]))
    utimesSync(unknown, 1, 1)
    utimesSync(referenced, 1, options.futureMtime ? 4_102_444_800 : 1)
    write(join(otherProfile, 'package.json'), JSON.stringify({ dependencies: { [packageName]: `file:${referenced}` } }))
    write(join(profile, 'package.json'), JSON.stringify({ dependencies: { [packageName]: `file:${referenced}` } }))
    const saved = [unknown, referenced, join(otherProfile, 'package.json')]
      .map(path => [path, readFileSync(path)])
    if (options.failPack) write(join(bin, 'npm'), '#!/bin/sh\nexit 43\n', true)

    const fixture = {
      install(marker = 'current build') {
        const result = spawnSync('sh', ['scripts/local-install.sh', 'target'], {
          cwd: repo,
          env: { ...env, FIXTURE_MARKER: marker },
          encoding: 'utf8',
          timeout: 30_000,
        })
        assert.ifError(result.error)
        assert.equal(result.status, options.failAdd ? 42 : options.failPack ? 43 : 0,
          `${result.stdout}\n${result.stderr}`)
        assert.equal(readFileSync(join(repo, 'package.json'), 'utf8'), manifest, 'source manifest must be restored')
        return existsSync(installLog)
          ? readFileSync(installLog, 'utf8').trim().split('\n').map(line => JSON.parse(line)).at(-1)
          : undefined
      },
      assertPreserved() {
        for (const [path, bytes] of saved) {
          assert.ok(existsSync(path), `deleted external artifact: ${path}`)
          assert.ok(readFileSync(path).equals(bytes), `overwrote external artifact: ${path}`)
        }
      },
      assertInstalled(marker = 'current build') {
        assert.equal(readFileSync(join(profile, 'node_modules', packageName, 'lib/index.js'), 'utf8'), marker)
      },
      destination,
      referenced,
    }
    run(fixture)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('successful install preserves unknown tarballs and another profile\'s referenced bytes', () => {
  withFixture({}, fixture => {
    fixture.install()
    fixture.assertPreserved()
    fixture.assertInstalled()
  })
})

test('failed install preserves unknown tarballs and another profile\'s referenced bytes', () => {
  withFixture({ failAdd: true }, fixture => {
    fixture.install()
    fixture.assertPreserved()
  })
})

test('a future mtime on an older tarball cannot change which build is installed', () => {
  withFixture({ futureMtime: true }, fixture => {
    assert.notEqual(fixture.install(), fixture.referenced, 'installed the older tarball instead of this pack')
    fixture.assertInstalled()
    fixture.assertPreserved()
  })
})

for (const failAdd of [false, true]) {
  test(`same-version pack preserves existing referenced bytes on ${failAdd ? 'failure' : 'success'}`, () => {
    withFixture({ sameVersion: true, failAdd }, fixture => {
      const installed = fixture.install()
      fixture.assertPreserved()
      assert.notEqual(installed, fixture.referenced)
    })
  })
}

test('reinstalling the same version keeps the prior installation\'s tarball immutable', () => {
  withFixture({}, fixture => {
    const first = fixture.install('first build')
    const bytes = readFileSync(first)
    const second = fixture.install('second build')
    assert.notEqual(second, first, 'reused the first installation\'s path')
    assert.deepEqual(readFileSync(first), bytes)
    fixture.assertInstalled('second build')
    fixture.assertPreserved()
  })
})

test('pack failure preserves all external artifacts without calling the profile installer', () => {
  withFixture({ failPack: true }, fixture => {
    assert.equal(fixture.install(), undefined)
    fixture.assertPreserved()
  })
})

for (const options of [{ defaultDir: true }, { relativeDir: true }]) {
  test(`uses this pack's artifact with a ${options.defaultDir ? 'default' : 'relative'} destination`, () => {
    withFixture(options, fixture => {
      const installed = fixture.install()
      assert.ok(isAbsolute(installed))
      assert.ok(realpathSync(installed).startsWith(`${realpathSync(fixture.destination)}/`))
      fixture.assertInstalled()
      fixture.assertPreserved()
    })
  })
}

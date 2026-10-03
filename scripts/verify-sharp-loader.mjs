/**
 * Sharp sharing regression with isolated host/profile dependency trees.
 * No real native module is loaded: the unwanted second copy throws on import.
 * Run: node --import tsx/esm scripts/verify-sharp-loader.mjs
 * Also runs in a fresh child of verify-image-downsample.tsx.
 */
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-sharp-loader-')))

function fakeSharp(dir, label, { broken = false, cjs = false } = {}) {
  mkdirSync(dir, { recursive: true })
  const entry = join(dir, cjs ? 'index.cjs' : 'index.js')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'sharp', type: 'module', main: basename(entry),
  }))
  const source = broken ? `throw new Error('second or broken sharp: ${label}')` : `
function sharp() {
  sharp.calls++
  return {
    metadata: async () => ({ width: 32, height: 16, pages: 1, hasAlpha: false }),
    resize() { return this },
    flatten() { return this },
    toFormat() { return { toBuffer: async () => Buffer.from('${label}') } },
  }
}
sharp.calls = 0
sharp.versions = { sharp: 'fixture', vips: 'fixture', fixture: '${label}' }
sharp.cache = () => {}
sharp.concurrency = () => {}
${cjs ? 'module.exports = sharp' : 'export default sharp'}
`
  writeFileSync(entry, source)
  return entry
}

function fixture(name, { host, local }) {
  const tree = join(root, name)
  const source = join(tree, 'plugin', 'src')
  mkdirSync(join(source, 'dsh-adapter'), { recursive: true })
  mkdirSync(join(source, 'utils'), { recursive: true })
  writeFileSync(join(tree, 'package.json'), '{"type":"module"}')
  // Copy unchanged sources so their real caller-relative resolution walks the
  // fixture tree, not the developer's node_modules or global installation.
  copyFileSync(new URL('../src/dsh-adapter/sharp.ts', import.meta.url), join(source, 'dsh-adapter', 'sharp.ts'))
  copyFileSync(new URL('../src/utils/imageResize.ts', import.meta.url), join(source, 'utils', 'imageResize.ts'))
  if (host) {
    const anchor = join(tree, 'node_modules', '@deepseek-ai', 'dsh-session')
    mkdirSync(anchor, { recursive: true })
    writeFileSync(join(anchor, 'package.json'), '{"name":"@deepseek-ai/dsh-session"}')
    fakeSharp(join(tree, 'node_modules', 'sharp'), `${name}-host`, { broken: host === 'broken' })
  }
  if (local) {
    fakeSharp(join(tree, 'plugin', 'node_modules', 'sharp'), `${name}-local`, { broken: local === 'broken' })
  }
  return source
}

try {
  for (const scenario of [
    { name: 'host-first', host: 'working', local: 'broken', selected: 'host' },
    { name: 'local-fallback', local: 'working', selected: 'local' },
    { name: 'broken-host', host: 'broken', local: 'working', selected: 'local' },
    { name: 'missing', selected: undefined },
    { name: 'already-loaded', local: 'broken', selected: 'cached' },
  ]) {
    const source = fixture(scenario.name, scenario)
    let cached
    if (scenario.selected === 'cached') {
      const entry = fakeSharp(join(root, 'preloaded', 'node_modules', 'sharp'), 'already-loaded-cached', { cjs: true })
      cached = createRequire(import.meta.url)(entry)
    }
    const { loadSharp, sharpCandidatePaths } = await import(pathToFileURL(join(source, 'dsh-adapter', 'sharp.ts')).href)
    const first = loadSharp()
    assert.equal(loadSharp(), first, `${scenario.name}: concurrent calls share the promise`)
    const sharp = await first
    const { adaptImageForAdmission } = await import(pathToFileURL(join(source, 'utils', 'imageResize.ts')).href)
    const outcome = await adaptImageForAdmission(
      new Uint8Array([1, 2, 3]), 'image/png',
      { maxImageDimension: 16, maxImagePixels: 256 }, ['image/png'],
    )
    if (scenario.selected === undefined) {
      assert.equal(sharp, undefined)
      assert.equal(outcome.kind, 'unavailable')
      assert.equal(outcome.reason, 'sharp-missing')
    } else {
      const label = `${scenario.name}-${scenario.selected}`
      assert.equal(sharp.versions.fixture, label, `${scenario.name}: expected factory selected`)
      assert.equal(outcome.kind, 'adapted', `${scenario.name}: admission uses the shared factory`)
      assert.equal(Buffer.from(outcome.data).toString(), label)
      assert.equal(sharp.calls, 1, `${scenario.name}: admission invokes that same instance`)
      assert.equal(outcome.width, 16)
      assert.equal(outcome.height, 8)
      if (cached) assert.equal(sharp, cached, 'an already-loaded CommonJS sharp wins over a second copy')
      if (scenario.host) {
        assert.equal(sharpCandidatePaths().length, 2)
        assert.ok(!sharpCandidatePaths()[0].includes(`${join('plugin', 'node_modules')}`))
      }
    }
    console.log(`PASS: sharp sharing ${scenario.name}`)
  }
} finally {
  // Only remove the freshly created fixture root, never a derived install path.
  assert.equal(dirname(root), realpathSync(tmpdir()))
  assert.ok(basename(root).startsWith('dsh-sharp-loader-'))
  rmSync(root, { recursive: true, force: true })
}

/**
 * ag-search preset regression: registration shape, endpoint and credential
 * resolution (row config → environment → opencode.json), request body and
 * headers, response mapping (answer.text → content, results → deduped
 * sources, truncated), and the failure taxonomy (gateway errors array, HTTP
 * status, unprocessable body, abort, deadline) — against a stubbed `fetch`,
 * with no network access.
 *
 * Zero dependencies: node: built-ins only; imports the preset file directly,
 * so it runs without a prior build (unlike scripts that import lib/types).
 *
 * Usage: node scripts/verify-ag-search.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const preset = await import(new URL('../presets/ag-search.mjs', import.meta.url).href)

let passed = 0
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log('  ok', name)
    })
    .catch((error) => {
      console.error('  FAIL', name)
      throw error
    })
}

const tmp = mkdtempSync(join(tmpdir(), 'verify-ag-search-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))

/** Mount the preset against a fake ctx and hand back the registered provider. */
function mount(config) {
  let provider
  const ctx = { web: { registerSearchProvider: (registered) => { provider = registered } } }
  preset.apply(ctx, config)
  return provider
}

/** Write an opencode.json fixture; returns its path. */
function opencodeFixture(name, options) {
  const file = join(tmp, name)
  writeFileSync(file, JSON.stringify({ provider: { gw: { options } } }))
  return file
}

/** Replace global fetch; returns the captured calls and a restore hook. */
function stubFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const SEARCH_OK = {
  provider: 'antigravity',
  query: 'q',
  results: [
    { url: 'https://a.test/1', title: 'A', snippet: 'sa', published_at: '2026-01-02T00:00:00Z' },
    { url: 'https://b.test/2', title: 'B' },
    { url: 'https://a.test/1', title: 'A dup' },
    { url: 'ftp://c.test/3', title: 'bad scheme' },
    { title: 'no url' },
  ],
  answer: { source: 'antigravity', text: 'SUMMARY', model: 'gemini-2.5-flash' },
  metrics: { total_results_available: 9 },
}

// ── V1: registration shape ────────────────────────────────────────────────
await ok('V1 registers one search provider under a stable id, available only with an endpoint', () => {
  assert.equal(preset.name, 'ag-search')
  assert.deepEqual(preset.inject, ['web'])
  const configured = mount({ baseURL: 'http://gw.test/v1' })
  assert.equal(configured.id, 'ag-search')
  assert.equal(configured.available(), true)
  assert.equal(typeof configured.search, 'function')
  assert.equal(typeof configured.fetch, 'undefined', 'fetch must stay with the shipped http provider')
  assert.equal(mount({ baseURL: 'ftp://gw.test' }).available(), false, 'a non-http(s) endpoint is unusable')
  assert.equal(mount({}).available(), false, 'no endpoint configured → unavailable, never a fallback')
})

// ── V2: endpoint resolution order ─────────────────────────────────────────
await ok('V2 resolves the endpoint: row baseURL → NINE_ROUTER_BASE_URL → opencode entry', async () => {
  const file = opencodeFixture('oc-endpoint.json', { baseURL: 'http://from-opencode.test/v1/', apiKey: 'k' })
  const previous = process.env.NINE_ROUTER_BASE_URL
  const { calls, restore } = stubFetch(() => jsonResponse(SEARCH_OK))
  try {
    delete process.env.NINE_ROUTER_BASE_URL
    await mount({ opencodeProvider: 'gw', opencodeConfig: file }).search({ query: 'q' })
    assert.equal(calls.at(-1).url, 'http://from-opencode.test/v1/search', 'opencode baseURL, trailing slash stripped')
    process.env.NINE_ROUTER_BASE_URL = 'http://from-env.test/v1'
    await mount({ apiKey: 'k' }).search({ query: 'q' })
    assert.equal(calls.at(-1).url, 'http://from-env.test/v1/search')
    await mount({ baseURL: 'http://from-row.test/v1', opencodeProvider: 'gw', opencodeConfig: file }).search({ query: 'q' })
    assert.equal(calls.at(-1).url, 'http://from-row.test/v1/search', 'row config wins')
    delete process.env.NINE_ROUTER_BASE_URL
    const noURL = mount({ opencodeProvider: 'gw', opencodeConfig: opencodeFixture('oc-nourl.json', { apiKey: 'k' }) })
    assert.equal(noURL.available(), false, 'an opencode entry without a baseURL is not an endpoint')
  } finally {
    if (previous === undefined) delete process.env.NINE_ROUTER_BASE_URL
    else process.env.NINE_ROUTER_BASE_URL = previous
    restore()
  }
})

// ── V3: request body, headers, response mapping ───────────────────────────
await ok('V3 posts the pinned provider/model with the seam request and maps answer.text + deduped sources', async () => {
  const { calls, restore } = stubFetch(() => jsonResponse(SEARCH_OK))
  try {
    const result = await mount({ baseURL: 'http://gw.test/v1/', apiKey: 'secret-key' }).search({ query: 'hello', maxResults: 3 })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'http://gw.test/v1/search', 'trailing slash must not double up')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.redirect, 'error')
    assert.equal(calls[0].init.headers.authorization, 'Bearer secret-key')
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      provider: 'ag',
      model: 'gemini-2.5-flash',
      query: 'hello',
      search_type: 'web',
      max_results: 3,
    })
    assert.equal(result.content, 'SUMMARY')
    assert.equal(result.sources.length, 2, 'duplicate and non-http(s) URLs are dropped')
    assert.deepEqual(result.sources[0], { url: 'https://a.test/1', title: 'A', snippet: 'sa', publishedAt: '2026-01-02T00:00:00Z' })
    assert.equal(result.truncated, true, 'metrics.total_results_available > returned count')
  } finally {
    restore()
  }
})

// ── V4: request maxResults beats the configured default ───────────────────
await ok('V4 uses the request maxResults, else the configured default, else 8', async () => {
  const { calls, restore } = stubFetch(() => jsonResponse(SEARCH_OK))
  try {
    const provider = mount({ baseURL: 'http://gw.test/v1', apiKey: 'k', defaultMaxResults: 4 })
    await provider.search({ query: 'q', maxResults: 2 })
    await provider.search({ query: 'q' })
    assert.equal(JSON.parse(calls[0].init.body).max_results, 2)
    assert.equal(JSON.parse(calls[1].init.body).max_results, 4)
    await mount({ baseURL: 'http://gw.test/v1', apiKey: 'k' }).search({ query: 'q' })
    assert.equal(JSON.parse(calls[2].init.body).max_results, 8)
  } finally {
    restore()
  }
})

/** Assert one call rejects with a WebError-shaped code. */
async function expectCode(promise, code, messagePattern) {
  try {
    await promise
  } catch (error) {
    assert.equal(error.code, code)
    if (messagePattern !== undefined) assert.match(error.message, messagePattern)
    return error
  }
  throw new Error(`expected rejection with code ${code}`)
}

// ── V5: credential resolution ─────────────────────────────────────────────
await ok('V5 resolves the key: row apiKey → apiKeyEnv → opencode entry; a missing key names its sources', async () => {
  const file = opencodeFixture('oc-key.json', { baseURL: 'http://opencode.test/v1', apiKey: 'opencode-key' })
  const { calls, restore } = stubFetch(() => jsonResponse(SEARCH_OK))
  const previous = process.env.NINE_ROUTER_API_KEY
  try {
    delete process.env.NINE_ROUTER_API_KEY
    await mount({ baseURL: 'http://gw.test/v1', opencodeProvider: 'gw', opencodeConfig: file }).search({ query: 'q' })
    assert.equal(calls.at(-1).init.headers.authorization, 'Bearer opencode-key')
    process.env.NINE_ROUTER_API_KEY = 'env-key'
    await mount({ baseURL: 'http://gw.test/v1', opencodeProvider: 'gw', opencodeConfig: file }).search({ query: 'q' })
    assert.equal(calls.at(-1).init.headers.authorization, 'Bearer env-key')
    await mount({ baseURL: 'http://gw.test/v1', apiKey: 'row-key', opencodeProvider: 'gw', opencodeConfig: file }).search({ query: 'q' })
    assert.equal(calls.at(-1).init.headers.authorization, 'Bearer row-key')
    delete process.env.NINE_ROUTER_API_KEY
    const error = await expectCode(
      mount({ baseURL: 'http://gw.test/v1', apiKeyEnv: 'MISSING_KEY_ENV' }).search({ query: 'q' }),
      'WEB_PROVIDER_CREDENTIAL_MISSING'
    )
    assert.match(error.message, /MISSING_KEY_ENV/)
    assert.equal(calls.length, 3, 'a missing key must fail before any request')
  } finally {
    if (previous === undefined) delete process.env.NINE_ROUTER_API_KEY
    else process.env.NINE_ROUTER_API_KEY = previous
    restore()
  }
})

// ── V6: no endpoint configured ────────────────────────────────────────────
await ok('V6 a search without an endpoint fails with a config error, not a request', async () => {
  const { calls, restore } = stubFetch(() => jsonResponse(SEARCH_OK))
  try {
    await expectCode(mount({}).search({ query: 'q' }), 'WEB_PROVIDER_ERROR', /no endpoint/)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

// ── V7: gateway failure taxonomy ──────────────────────────────────────────
await ok('V7 maps gateway errors[], bad status, and unprocessable bodies onto stable codes', async () => {
  const cases = [
    [{ ...SEARCH_OK, errors: ['upstream blew up'] }, 200, 'WEB_PROVIDER_ERROR', /upstream blew up/],
    [{ provider: 'antigravity' }, 200, 'WEB_PROVIDER_ERROR', /no results array/],
    [{ ...SEARCH_OK, results: [], metrics: {} }, 200, undefined, undefined],
    [{ error: { message: 'No credentials for provider: ag' } }, 401, 'WEB_PROVIDER_CREDENTIAL_MISSING', /No credentials/],
    [{ error: { message: '[ag] Upstream timeout' } }, 504, 'WEB_PROVIDER_ERROR', /HTTP 504/],
  ]
  for (const [body, status, code, pattern] of cases) {
    const { restore } = stubFetch(() => jsonResponse(body, status))
    try {
      const provider = mount({ baseURL: 'http://gw.test/v1', apiKey: 'k' })
      if (code === undefined) {
        const result = await provider.search({ query: 'q' })
        assert.deepEqual(result.sources, [])
        assert.equal(result.truncated, false)
      } else {
        await expectCode(provider.search({ query: 'q' }), code, pattern)
      }
    } finally {
      restore()
    }
  }

  const { restore } = stubFetch(() => new Response('<html>not json</html>', { status: 200 }))
  try {
    await expectCode(mount({ baseURL: 'http://gw.test/v1', apiKey: 'k' }).search({ query: 'q' }), 'WEB_PROVIDER_ERROR', /unprocessable/)
  } finally {
    restore()
  }
})

// ── V8: cancellation and deadline ─────────────────────────────────────────
await ok('V8 distinguishes an external abort from the request deadline', async () => {
  const hanging = (url, init) =>
    new Promise((resolve, reject) => {
      if (init.signal?.aborted === true) reject(new DOMException('aborted', 'AbortError'))
      else init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })

  const aborted = stubFetch(hanging)
  try {
    const controller = new AbortController()
    controller.abort()
    await expectCode(
      mount({ baseURL: 'http://gw.test/v1', apiKey: 'k' }).search({ query: 'q' }, controller.signal),
      'WEB_ABORTED'
    )
  } finally {
    aborted.restore()
  }

  const slow = stubFetch(hanging)
  // `AbortSignal.timeout()` schedules an unref'd timer, so a test that awaits
  // nothing else would let the loop drain first; this ref'd timer keeps the
  // process alive until the deadline fires.
  const keepAlive = setTimeout(() => {}, 500)
  try {
    await expectCode(mount({ baseURL: 'http://gw.test/v1', apiKey: 'k', timeoutMs: 20 }).search({ query: 'q' }), 'WEB_TIMEOUT', /timed out/)
  } finally {
    clearTimeout(keepAlive)
    slow.restore()
  }
})

// ── V9: the key never reaches an error message ────────────────────────────
await ok('V9 never leaks the API key through failures', async () => {
  const secret = 'super-secret-key'
  const failures = [
    stubFetch(() => { throw new TypeError('socket hang up') }),
    stubFetch(() => jsonResponse({ error: { message: 'gateway said no' } }, 403)),
    stubFetch(() => new Response('not json', { status: 200 })),
  ]
  const messages = []
  try {
    for (const stub of failures) {
      const provider = mount({ baseURL: 'http://gw.test/v1', apiKey: secret })
      try {
        await provider.search({ query: 'q' })
      } catch (error) {
        messages.push(error.message)
      }
      stub.restore()
    }
  } finally {
    for (const stub of failures) stub.restore()
  }
  assert.equal(messages.length, 3)
  for (const message of messages) assert.ok(!message.includes(secret), `key leaked: ${message}`)
})

console.log(`\nverify-ag-search: ALL ${passed} PASS`)

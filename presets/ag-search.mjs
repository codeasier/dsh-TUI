/**
 * ag-search — mount a self-hosted 9Router-style gateway's search endpoint on
 * the DSH web seam (`ctx.web`), so the native `web_search` tool is served by
 * that gateway instead of DSH's shipped provider.
 *
 * WHY THIS EXISTS: DSH's default `web-search-deepseek` provider requires the
 * upstream to implement Anthropic's `web_search_20250305` **server-side**
 * search tool. An OpenAI-compatible gateway (9Router and friends) hands that
 * tool definition to the model as a regular function instead of executing
 * searches server-side, so native search cannot work through it. This plugin
 * calls the gateway's own `POST {baseURL}/search` and maps its response onto
 * `WebSearchResult`.
 *
 * CONTRACT (verified against 9Router 0.2.x, 2026-10-18):
 * - `POST {baseURL}/search` with `Authorization: Bearer <key>`; the body
 *   requires `provider` (or `model` — that build resolves `model` as a
 *   provider name too) plus `query`; `max_results`, `search_type`, `country`,
 *   `language`, `time_range` and `domain_filter` are optional.
 * - The usable provider is the Gemini-backed one: `provider: "ag"`, reported
 *   as `antigravity` in the response, with model `gemini-2.5-flash`; one
 *   search costs a single grounding LLM turn (3–6 s).
 * - Response shape: `{ provider, query, results[], answer, usage, metrics,
 *   errors[] }`. On that build `answer` is an OBJECT (`{ source, text,
 *   model }`) rather than the string some 9Router docs show — the summary
 *   lives in `.text` — while each `results[]` item carries `url`, `title`,
 *   `snippet` and `content`. `answer.text` is mapped onto the seam's
 *   `content`, `results[]` onto `sources`.
 *
 * FETCH is deliberately NOT registered: `ag` answers `POST /v1/web/fetch` with
 * "does not support web fetch", so the `web` row keeps the shipped `http`
 * fetch provider.
 *
 * Zero framework dependencies (Node built-ins only), matching
 * `presets/winbash.mjs`: a profile has no `@deepseek-ai/*` copy of its own, so
 * a preset mounted by path must not import them. Consumers only read `code`
 * off a WebError, which a plain `Error` carries here just as well.
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'ag-search'

/** The web seam must exist before the provider can register. */
export const inject = ['web']

/** Provider id registered with `ctx.web`; the `web` row selects it by this id. */
const PROVIDER_ID = 'ag-search'

const DEFAULT_PROVIDER = 'ag'
const DEFAULT_MODEL = 'gemini-2.5-flash'
const DEFAULT_SEARCH_TYPE = 'web'
const DEFAULT_MAX_RESULTS = 8
const DEFAULT_TIMEOUT_MS = 45000
const DEFAULT_API_KEY_ENV = 'NINE_ROUTER_API_KEY'
const DEFAULT_OPENCODE_CONFIG = join(homedir(), '.config', 'opencode', 'opencode.json')
const SEARCH_BASE_URL_ENV = 'NINE_ROUTER_BASE_URL'

/** Only http(s) endpoints are accepted; there is no implicit fallback endpoint. */
const HTTP_URL = /^https?:\/\/\S+$/u

/** A non-empty string, or undefined. */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** WebError-shaped error: consumers read `code`; the message never carries the key. */
function webError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Read one provider's `options` out of an opencode.json, cached by mtime so a
 * search does not re-read the file every call. Opt-in: only consulted when the
 * row names `opencodeProvider`.
 * @returns the `options` object, or undefined when absent/unreadable.
 */
let opencodeCache = { file: undefined, mtimeMs: -1, options: undefined }
function opencodeOptions(file, provider) {
  let mtimeMs
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    opencodeCache = { file, mtimeMs: -1, options: undefined }
    return undefined
  }
  if (opencodeCache.file !== file || opencodeCache.mtimeMs !== mtimeMs) {
    let options
    try {
      const candidate = JSON.parse(readFileSync(file, 'utf8'))?.provider?.[provider]?.options
      if (candidate !== null && typeof candidate === 'object') options = candidate
    } catch {
      options = undefined
    }
    opencodeCache = { file, mtimeMs, options }
  }
  return opencodeCache.options
}

/**
 * Resolve one operation's options. Endpoint: row `baseURL` → `NINE_ROUTER_BASE_URL`
 * → the opencode entry's `baseURL`. Credential: row `apiKey` → `apiKeyEnv` →
 * the opencode entry's `apiKey`. Both fall back to opencode.json only when the
 * row opts in with `opencodeProvider`.
 */
function resolveOptions(config) {
  const cfg = config ?? {}
  const apiKeyEnv = str(cfg.apiKeyEnv) ?? DEFAULT_API_KEY_ENV
  const opencodeConfig = str(cfg.opencodeConfig) ?? DEFAULT_OPENCODE_CONFIG
  const opencodeProvider = str(cfg.opencodeProvider)
  const opencode = opencodeProvider === undefined ? undefined : opencodeOptions(opencodeConfig, opencodeProvider)
  const candidateBaseURL = str(cfg.baseURL) ?? str(process.env[SEARCH_BASE_URL_ENV]) ?? str(opencode?.baseURL)
  const baseURL = candidateBaseURL !== undefined && HTTP_URL.test(candidateBaseURL) ? candidateBaseURL.replace(/\/+$/u, '') : undefined
  return {
    baseURL,
    provider: str(cfg.provider) ?? DEFAULT_PROVIDER,
    model: str(cfg.model) ?? DEFAULT_MODEL,
    searchType: str(cfg.searchType) ?? DEFAULT_SEARCH_TYPE,
    maxResults: Number.isInteger(cfg.defaultMaxResults) && cfg.defaultMaxResults > 0 ? cfg.defaultMaxResults : DEFAULT_MAX_RESULTS,
    timeoutMs: Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS,
    resolveApiKey() {
      const literal = str(cfg.apiKey)
      if (literal !== undefined) return literal
      const fromEnv = str(process.env[apiKeyEnv])
      if (fromEnv !== undefined) return fromEnv
      return str(opencode?.apiKey)
    },
    apiKeyEnv,
    opencodeConfig,
    opencodeProvider,
  }
}

/** Map the gateway response onto the seam's result; the seam owns `maxResults` truncation. */
function mapResponse(payload) {
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw webError(`9router search failed: ${String(payload.errors[0])}`, 'WEB_PROVIDER_ERROR')
  }
  if (!Array.isArray(payload.results)) {
    throw webError('9router search response has no results array', 'WEB_PROVIDER_ERROR')
  }

  const seen = new Set()
  const sources = []
  for (const item of payload.results) {
    const url = typeof item?.url === 'string' ? item.url.trim() : ''
    if (url.length === 0 || !HTTP_URL.test(url) || seen.has(url)) continue
    seen.add(url)
    sources.push({
      url,
      ...(str(item.title) !== undefined ? { title: item.title } : {}),
      ...(str(item.snippet) !== undefined ? { snippet: item.snippet } : {}),
      ...(str(item.published_at) !== undefined ? { publishedAt: item.published_at } : {}),
    })
  }

  // This build answers with `{ source, text, model }`; a bare string is accepted too.
  const answer = payload.answer
  const text = str(answer) ?? str(answer?.text)
  const available = payload.metrics?.total_results_available

  return {
    ...(text !== undefined ? { content: text } : {}),
    sources,
    truncated: typeof available === 'number' && available > payload.results.length,
  }
}

/** Run one search; cancellation and deadline surface as WebError-shaped errors. */
async function runSearch(request, signal, getConfig) {
  const options = resolveOptions(getConfig())
  if (options.baseURL === undefined) {
    throw webError(
      'ag-search has no endpoint: set the row\'s "baseURL", or NINE_ROUTER_BASE_URL, or an "opencodeProvider" whose opencode.json entry carries a http(s) baseURL',
      'WEB_PROVIDER_ERROR'
    )
  }
  const apiKey = options.resolveApiKey()
  if (apiKey === undefined) {
    throw webError(
      `ag-search has no API key: set the row's "apiKey", or the ${options.apiKeyEnv} environment value, or an "opencodeProvider" whose opencode.json entry carries options.apiKey`,
      'WEB_PROVIDER_CREDENTIAL_MISSING'
    )
  }

  const body = {
    provider: options.provider,
    model: options.model,
    query: request.query,
    search_type: options.searchType,
    max_results: request.maxResults ?? options.maxResults,
  }

  const timeout = AbortSignal.timeout(options.timeoutMs)
  const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

  let response
  try {
    response = await fetch(`${options.baseURL}/search`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: composed,
    })
  } catch (error) {
    if (signal?.aborted === true) throw webError('9router search aborted', 'WEB_ABORTED')
    if (timeout.aborted) throw webError(`9router search timed out after ${options.timeoutMs} ms`, 'WEB_TIMEOUT')
    throw webError(`cannot reach the 9router gateway at ${options.baseURL}: ${String(error)}`, 'WEB_PROVIDER_ERROR')
  }

  let payload
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }

  if (!response.ok) {
    const detail = payload?.error?.message ?? payload?.error ?? `HTTP ${response.status}`
    const code = response.status === 401 || response.status === 403 ? 'WEB_PROVIDER_CREDENTIAL_MISSING' : 'WEB_PROVIDER_ERROR'
    throw webError(`9router search failed (HTTP ${response.status}): ${String(detail)}`, code)
  }
  if (payload === null || typeof payload !== 'object') {
    throw webError('9router search returned an unprocessable response body', 'WEB_PROVIDER_ERROR')
  }
  return mapResponse(payload)
}

/** Register the provider; config is read per call, so a settings change needs no remount. */
export function apply(ctx, config) {
  const getConfig = () => config
  ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    // Cheap, no network: an unusable endpoint reports unavailable. A missing key
    // stays available so search() can name the credential source precisely.
    available: () => resolveOptions(getConfig()).baseURL !== undefined,
    search: (request, signal) => runSearch(request, signal, getConfig),
  })
}

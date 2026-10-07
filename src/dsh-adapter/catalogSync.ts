/**
 * Official-model management for catalog routes.
 *
 * A catalog route's served models are the installed pi-ai snapshot plus
 * whatever its `llm-pi-ai` profile pins; neither follows the vendor's own
 * listing, and a profile only carries ROUTE-level `api`/`baseURL`, so an id
 * the installed catalog does not describe cannot join the catalog route
 * without forcing every catalog model of that route onto one wire protocol.
 * The vendor's extras therefore live on a derived route the USER manages
 * (`<route>-live`, see {@link derivedCatalogRoute}), whose single protocol and
 * endpoint are facts of this module.
 *
 * Enablement is the user's, never this module's:
 *
 *   - The derived route's stored `models` IS the enabled set. Nothing here
 *     turns a model on by itself — not the boot pass, not the inspection. A
 *     model the vendor advertises beyond the installed catalog only ever
 *     surfaces as a report until the user enables it.
 *   - The boot pass ({@link reportCatalogRoutesQuietly}) inspects and logs;
 *     the only writer is {@link writeCatalogSyncSelection}, called with
 *     exactly the ids the user picked.
 *
 * Only routes with a known live target ({@link CATALOG_LIVE_TARGETS}) are
 * eligible: which endpoint publishes a route's roster, and over which
 * protocol, is a vendor fact that no profile states. The catalog route itself
 * is read-only here — an explicit `models` list is the user's own selection
 * and is never rewritten (explicit config > persisted user choice > defaults).
 * A stored derived route pointing at another endpoint or protocol is refused,
 * never overwritten — that shape means a human repurposed the route.
 */

import type { LlmDiscoveredModel } from '../adapter/ports/channel-view.js'
import type { ConfiguredProvider, ProviderSetupHost } from '../adapter/ports/channel-settings.js'

/** Wire protocols a vendor listing can be read over (the wizard's own set). */
type LiveListingApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

/** Where one catalog route's vendor publishes its live model listing. */
export interface CatalogLiveTarget {
  /** Protocol the listing endpoint speaks; also the derived route's protocol. */
  readonly api: LiveListingApi
  /** Endpoint the listing lives on — never written to the catalog route. */
  readonly baseURL: string
  /**
   * Credential ref the provider itself reads, used only when the configured
   * profile names no ref of its own (an env-only connection). The derived
   * route always stores a ref: a route the host only knows from this
   * profile resolves its key through the harness credential seam, not
   * through pi-ai's own ambient discovery.
   */
  readonly envRef: string
  /**
   * models.dev providers holding this route's model metadata, most specific
   * first (default: the route's own id). The vendor's two catalogs overlap —
   * `opencode-go` documents most Go models while a few live only under the
   * plain `opencode` (zen) provider — so a lookup falls through the list.
   */
  readonly metadataProviders?: readonly string[]
}

/**
 * Catalog routes whose vendor publishes a live roster this build can read.
 * `opencode-go` is the registered case: the installed catalog splits its
 * models over three protocols and two base paths (`/zen/go` for
 * anthropic-messages, `/zen/go/v1` for both OpenAI protocols), while the
 * `/v1/models` listing is the vendor's whole Go roster — and the snapshot
 * that ships inside pi-ai lags it by double-digit model counts.
 */
export const CATALOG_LIVE_TARGETS: Readonly<Record<string, CatalogLiveTarget>> = {
  'opencode-go': {
    api: 'openai-completions',
    baseURL: 'https://opencode.ai/zen/go/v1',
    envRef: 'OPENCODE_API_KEY',
    metadataProviders: ['opencode-go', 'opencode'],
  },
}

/** The live target of one catalog route, or undefined when it has none. */
export function catalogLiveTarget(route: string): CatalogLiveTarget | undefined {
  return Object.hasOwn(CATALOG_LIVE_TARGETS, route) ? CATALOG_LIVE_TARGETS[route] : undefined
}

/** The derived route one catalog route's vendor extras are managed on. */
export function derivedCatalogRoute(route: string): string {
  return `${route}-live`
}

/**
 * Bound on a background pass's two discovery requests. A boot must not hold
 * a socket (or a promise) past its own usefulness, and a listing that takes
 * longer than this is indistinguishable from being offline.
 */
export const CATALOG_SYNC_TIMEOUT_MS = 15_000

/** Why an inspection could not compare the vendor listing with the profile. */
export type CatalogSyncReason =
  /** The stored route is not a catalog route (a custom endpoint). */
  | 'not-catalog'
  /** No API key: neither the profile's ref nor the vendor's own env var resolves. */
  | 'no-credential'
  /** The installed-catalog lookup failed, so the "already covered" set is unknown. */
  | 'catalog-failed'
  /** The vendor listing could not be read (offline, refused, non-JSON). */
  | 'listing-failed'
  /** The vendor listing answered with no models. */
  | 'listing-empty'
  /** A stored derived route points at another endpoint/protocol. */
  | 'derived-conflict'

/** One catalog route's vendor roster versus the models enabled on it. */
export interface CatalogSyncStatus {
  readonly route: string
  /** The derived route this status addresses: {@link derivedCatalogRoute}. */
  readonly derived: string
  readonly displayName: string
  /** The ref the derived route stores, when the inspection got that far. */
  readonly ref?: string
  /**
   * Vendor-advertised models the installed catalog does not describe — the
   * only ids this feature can enable. Absent when the inspection refused.
   */
  readonly vendorOnly?: readonly LlmDiscoveredModel[]
  /** Ids currently enabled on the derived route, in stored order. */
  readonly enabled: readonly string[]
  /** Vendor-advertised ids that are NOT enabled (the "new on endpoint" set). */
  readonly unenabled?: readonly string[]
  /** Enabled ids the vendor no longer advertises. */
  readonly retired?: readonly string[]
  readonly reason?: CatalogSyncReason
  /** Whether the refusal is a failure (a probe) rather than a plain skip. */
  readonly failed?: boolean
}

/** What one interactive write did to the derived route. */
export interface CatalogSyncWrite {
  readonly status: 'written' | 'removed' | 'unchanged' | 'nothing'
  /** Ids the derived route gained. */
  readonly added: readonly string[]
  /** Ids the derived route lost. */
  readonly removed: readonly string[]
  /** The enabled set after the write. */
  readonly models: readonly string[]
}

/** One catalog route a management pass could address. */
export interface CatalogSyncCandidate {
  readonly route: string
  readonly displayName: string
}

export interface CatalogSyncOptions {
  /** Address only this route; absent means every eligible configured route. */
  readonly route?: string
  /** Cancels the two discovery requests of every pass. */
  readonly signal?: AbortSignal
}

/**
 * Configured catalog routes this build can inspect, in configured order — the
 * picker rows. Eligibility is deliberately narrow: a route must be configured
 * (an unconfigured route has no key and serves nothing), be a catalog route,
 * and have a live target.
 */
export function syncableCatalogRoutes(host: ProviderSetupHost): readonly CatalogSyncCandidate[] {
  const names = new Map(host.listCatalogProviders().map(row => [row.provider, row.displayName] as const))
  return host.listConfiguredProviders()
    .filter(provider => provider.isCatalog && catalogLiveTarget(provider.route) !== undefined)
    .map(provider => ({ route: provider.route, displayName: names.get(provider.route) ?? provider.route }))
}

/**
 * Read one route's vendor roster and its enabled set. Nothing is written and
 * nothing throws for an ordinary refusal (no key, offline, unsupported route):
 * the outcome travels as its own {@link CatalogSyncStatus}.
 */
export async function inspectCatalogRoute(
  host: ProviderSetupHost,
  provider: ConfiguredProvider,
  target: CatalogLiveTarget,
  displayName: string,
  options: CatalogSyncOptions = {},
): Promise<CatalogSyncStatus> {
  const derived = derivedCatalogRoute(provider.route)
  const stored = host.listConfiguredProviders().find(row => row.route === derived)
  const enabled = stored?.models ?? []
  const refused = (reason: CatalogSyncReason, failed = false): CatalogSyncStatus =>
    ({ route: provider.route, derived, displayName, enabled, reason, failed })
  if (!provider.isCatalog) return refused('not-catalog')
  const ref = await syncRefOf(host, provider, target)
  if (ref === undefined) return refused('no-credential')
  const apiKey = host.envShadows(ref) ? host.envValue(ref) : await host.readCredential(ref)
  // An empty key is a hard invalid-credential upstream, so it is the same
  // refusal as a missing one rather than an anonymous listing.
  if (apiKey === undefined || apiKey === '') return refused('no-credential')
  // A derived route pointing somewhere else is a human's route: refuse rather
  // than compare it against (or later overwrite) the vendor's own target.
  if (stored !== undefined
    && ((stored.api !== undefined && stored.api !== target.api)
      || (stored.baseURL !== undefined && stored.baseURL !== target.baseURL))) {
    return refused('derived-conflict')
  }

  // Pass 1: the ids the installed catalog describes — the catalog route
  // already serves those, so they are never part of the managed set.
  let catalogIds: ReadonlySet<string>
  try {
    catalogIds = new Set((await host.discoverModels({ provider: provider.route }, { signal: options.signal }))
      .map(row => row.id))
  } catch {
    return refused('catalog-failed')
  }
  // Pass 2: the vendor's own roster.
  let vendorRows: readonly LlmDiscoveredModel[]
  try {
    vendorRows = await host.discoverModels(
      { baseURL: target.baseURL, api: target.api, apiKey },
      { signal: options.signal },
    )
  } catch {
    return refused('listing-failed', true)
  }
  if (vendorRows.length === 0) return refused('listing-empty', true)

  const vendorOnly = vendorRows.filter(row => !catalogIds.has(row.id))
  const vendorIds = new Set(vendorOnly.map(row => row.id))
  return {
    route: provider.route,
    derived,
    displayName,
    ref,
    vendorOnly,
    enabled,
    unenabled: vendorOnly.filter(row => !enabled.includes(row.id)).map(row => row.id),
    retired: enabled.filter(id => !vendorIds.has(id)),
  }
}

/** Inspect every eligible configured route (or just `options.route`). */
export async function inspectCatalogRoutes(
  host: ProviderSetupHost,
  options: CatalogSyncOptions = {},
): Promise<readonly CatalogSyncStatus[]> {
  const names = new Map(host.listCatalogProviders().map(row => [row.provider, row.displayName] as const))
  const statuses: CatalogSyncStatus[] = []
  for (const provider of host.listConfiguredProviders()) {
    if (options.route !== undefined && provider.route !== options.route) continue
    const target = catalogLiveTarget(provider.route)
    if (target === undefined) continue
    statuses.push(await inspectCatalogRoute(
      host,
      provider,
      target,
      names.get(provider.route) ?? provider.route,
      options,
    ))
  }
  return statuses
}

/**
 * Apply one route's enabled set to its derived route. This is the ONLY writer:
 * the caller passes exactly the ids the user picked, so nothing is ever enabled
 * on the user's behalf.
 *
 * An empty selection removes the derived route — a route serving no models
 * cannot validate, and "nothing enabled" is the honest end state. Per-model
 * fields of ids that stay enabled re-enter their stored entries verbatim, so
 * hand-tuned capacities survive a management pass. An id the vendor listing
 * does not advertise is writable here (the derived route declares protocol and
 * endpoint outright) — that is what makes it the management surface.
 *
 * @param host - the provider-setup seam.
 * @param spec - the catalog route and the credential ref its derived route stores.
 * @param selectedIds - the ids to enable (order preserved).
 */
export async function writeCatalogModels(
  host: ProviderSetupHost,
  spec: { readonly route: string; readonly ref: string },
  selectedIds: readonly string[],
  metadata?: ReadonlyMap<string, VendorModelMetadata>,
): Promise<CatalogSyncWrite> {
  const target = catalogLiveTarget(spec.route)
  if (target === undefined) throw new Error(`dsh-tui: "${spec.route}" has no live target`)
  const derived = derivedCatalogRoute(spec.route)
  const stored = host.listConfiguredProviders().find(row => row.route === derived)
  const previous = stored?.models ?? []
  if (selectedIds.length === 0) {
    if (!host.routeExists(derived)) {
      return { status: 'nothing', added: [], removed: [], models: [] }
    }
    await host.removeProfile(derived)
    return { status: 'removed', added: [], removed: previous, models: [] }
  }
  const added = selectedIds.filter(id => !previous.includes(id))
  const removed = previous.filter(id => !selectedIds.includes(id))
  const storedEntries = stored?.modelEntries ?? []
  const displayName = host.listCatalogProviders().find(row => row.provider === spec.route)?.displayName
    ?? spec.route
  const storedById = new Map((stored?.modelEntries ?? [])
    .flatMap(entry => typeof entry['id'] === 'string' ? [[entry['id'], entry] as const] : []))
  // Catalog metadata fills what a stored entry does not state; the entry
  // itself always wins, so a hand-tuned capacity (or a name) survives every
  // management pass. An id the vendor catalog does not describe stays a bare
  // `{id}` and keeps the adapter's route-level defaults.
  const entries = selectedIds.map(id => ({
    ...(metadata?.get(id) ?? {}),
    ...(storedById.get(id) ?? { id }),
  }))
  // Unchanged means the entries themselves match: an enrichment pass that
  // adds a name or a capacity really does change the profile, while a
  // re-submitted identical set must not rewrite settings.
  if (stored !== undefined && stored.ref === spec.ref && sameEntries(entries, storedEntries)) {
    return { status: 'unchanged', added: [], removed: [], models: [...selectedIds] }
  }
  await host.mutateProfile(derived, [
    { op: 'set', path: ['models'], value: entries },
    { op: 'set', path: ['api'], value: target.api },
    { op: 'set', path: ['baseURL'], value: target.baseURL },
    { op: 'set', path: ['apiKeyEnv'], value: spec.ref },
    { op: 'set', path: ['displayName'], value: `${displayName} (live)` },
  ])
  return { status: 'written', added, removed, models: [...selectedIds] }
}

/**
 * {@link writeCatalogModels} for one inspection's route, refusing a status
 * that never reached the vendor listing (its `ref` is the credential the
 * derived route must store).
 */
export async function writeCatalogSyncSelection(
  host: ProviderSetupHost,
  status: CatalogSyncStatus,
  selectedIds: readonly string[],
  metadata?: ReadonlyMap<string, VendorModelMetadata>,
): Promise<CatalogSyncWrite> {
  if (status.reason !== undefined || status.ref === undefined) {
    throw new Error(`dsh-tui: cannot write a catalog selection for "${status.route}" (${status.reason ?? 'not inspected'})`)
  }
  return await writeCatalogModels(host, { route: status.route, ref: status.ref }, selectedIds, metadata)
}

/**
 * One model's metadata as a vendor catalog publishes it — the fields a
 * `llm-pi-ai` model entry accepts that the vendor's own `/v1/models` listing
 * does not carry (it answers ids only). Absent fields stay undeclared, so the
 * adapter's own defaults apply exactly as before.
 */
export interface VendorModelMetadata {
  readonly name?: string
  readonly contextWindow?: number
  readonly maxTokens?: number
  /** Modalities the model accepts, restricted to what a profile can declare. */
  readonly input?: readonly ('text' | 'image')[]
  /**
   * Thinking levels, as `llm-pi-ai` spells them: level → wire value (`false`
   * is its explicit "not a reasoning model").
   */
  readonly reasoningEfforts?: Readonly<Record<string, string>> | false
}

/** A models.dev-shaped catalog document (`{ [provider]: { models: {…} } }`). */
export type VendorCatalogDocument = unknown

/** The community catalog the OpenCode vendor's own metadata lives in. */
export const VENDOR_CATALOG_URL = 'https://models.dev/api.json'

/** Thinking levels a profile may declare (mirrors llm-pi-ai's THINKING_LEVELS). */
const PROFILE_THINKING_LEVELS: ReadonlySet<string> = new Set([
  'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
])

/** Cache one catalog read per process: it is a multi-megabyte document. */
let vendorCatalogCache: { at: number; document: VendorCatalogDocument } | undefined
/** How long a fetched catalog is reused before another read is attempted. */
const VENDOR_CATALOG_TTL_MS = 10 * 60_000

/**
 * Read the vendor catalog (`models.dev/api.json`) for model metadata. Nothing
 * here is required for the wizard to work — a failure returns `undefined` and
 * the caller falls back to bare ids — so every error is swallowed on purpose.
 * @param signal - cancels the read.
 * @param url - override for tests/proxies.
 */
export async function readVendorCatalog(
  signal?: AbortSignal,
  url: string = VENDOR_CATALOG_URL,
): Promise<VendorCatalogDocument | undefined> {
  if (vendorCatalogCache !== undefined && Date.now() - vendorCatalogCache.at < VENDOR_CATALOG_TTL_MS) {
    return vendorCatalogCache.document
  }
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: signal ?? AbortSignal.timeout(CATALOG_SYNC_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const document: unknown = await response.json()
    vendorCatalogCache = { at: Date.now(), document }
    return document
  } catch {
    return undefined
  }
}

/**
 * The metadata the catalog holds for `ids` of one catalog route. Lookups run
 * through the target's `metadataProviders` in order, so the route's own
 * provider wins and the vendor's sibling catalog fills the gaps.
 * @param route - the catalog route the ids belong to.
 * @param ids - the model ids to describe.
 * @param catalog - the document {@link readVendorCatalog} returned.
 */
export function vendorMetadataFor(
  route: string,
  ids: readonly string[],
  catalog: VendorCatalogDocument,
): ReadonlyMap<string, VendorModelMetadata> {
  const providers = catalogLiveTarget(route)?.metadataProviders ?? [route]
  const found = new Map<string, VendorModelMetadata>()
  for (const id of ids) {
    for (const provider of providers) {
      const entry = catalogEntry(catalog, provider, id)
      if (entry === undefined) continue
      const metadata = metadataFromEntry(entry)
      if (metadata !== undefined) {
        found.set(id, metadata)
        break
      }
    }
  }
  return found
}

/** One `catalog[provider].models[id]` entry, when it is a plain object. */
function catalogEntry(catalog: VendorCatalogDocument, provider: string, id: string): Record<string, unknown> | undefined {
  const models = asRecord(asRecord(asRecord(catalog)?.[provider])?.['models'])
  return asRecord(models?.[id])
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A positive integer, or undefined for anything else (junk never reaches a profile). */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** Map one catalog entry onto the fields a model entry accepts. */
function metadataFromEntry(entry: Record<string, unknown>): VendorModelMetadata | undefined {
  const limit = asRecord(entry['limit'])
  const contextWindow = positiveInt(limit?.['context'])
  const maxTokens = positiveInt(limit?.['output'])
  const input = modalitiesFrom(entry)
  const reasoningEfforts = reasoningEffortsFrom(entry)
  const name = typeof entry['name'] === 'string' && entry['name'] !== '' ? entry['name'] : undefined
  if (name === undefined && contextWindow === undefined && maxTokens === undefined
    && input === undefined && reasoningEfforts === undefined) return undefined
  return {
    ...(name === undefined ? {} : { name }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(input === undefined ? {} : { input }),
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
  }
}

/**
 * Declared input modalities, narrowed to what a profile can carry
 * (`llm-pi-ai` models text and image only): a catalog naming video/pdf keeps
 * the modalities this build can actually honour, never a wider claim.
 */
function modalitiesFrom(entry: Record<string, unknown>): readonly ('text' | 'image')[] | undefined {
  const declared = asRecord(entry['modalities'])?.['input']
  if (!Array.isArray(declared)) return undefined
  const allowed = declared.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
  return allowed.length > 0 ? allowed : undefined
}

/**
 * Thinking levels from a catalog entry. An explicit `reasoning: false` is the
 * profile's own "not a reasoning model"; an effort list maps its values onto
 * the levels a profile declares (`none` is the wire value for `off`), and a
 * toggle becomes the vendor's customary off/high pair. Anything else stays
 * undeclared — guessing tiers a vendor never published would send a request
 * the model rejects.
 */
function reasoningEffortsFrom(entry: Record<string, unknown>): Readonly<Record<string, string>> | false | undefined {
  if (entry['reasoning'] === false) return false
  if (entry['reasoning'] !== true) return undefined
  const options = Array.isArray(entry['reasoning_options']) ? entry['reasoning_options'] : []
  for (const option of options) {
    const record = asRecord(option)
    if (record?.['type'] === 'effort' && Array.isArray(record['values'])) {
      const efforts: Record<string, string> = {}
      for (const value of record['values']) {
        if (value === 'none') efforts['off'] = 'none'
        else if (typeof value === 'string' && PROFILE_THINKING_LEVELS.has(value)) efforts[value] = value
      }
      // A list offering nothing beyond "off" cannot be declared (the adapter
      // refuses an efforts map with no thinking level), so it stays undeclared.
      if (Object.keys(efforts).some(level => level !== 'off')) return efforts
    }
    if (record?.['type'] === 'toggle') return { off: 'none', high: 'high' }
  }
  return undefined
}

/**
 * Best-effort boot pass: inspect every eligible route and log what the user has
 * not enabled (and what the vendor retired). It writes nothing — a boot must
 * never change which models the user can pick — so repeated starts stay silent
 * apart from these lines.
 * @param host - the provider-setup seam.
 * @param log - one line per real event; the caller picks level and prefix.
 */
export async function reportCatalogRoutesQuietly(
  host: ProviderSetupHost,
  log: (message: string, level: 'debug' | 'warn') => void,
  options: CatalogSyncOptions = {},
): Promise<void> {
  for (const status of await inspectCatalogRoutes(host, options)) {
    if (status.reason !== undefined) {
      if (status.failed) log(`${status.route}: ${status.reason}`, 'debug')
      continue
    }
    const unenabled = status.unenabled ?? []
    const retired = status.retired ?? []
    if (unenabled.length > 0) {
      log(`${status.route}: ${unenabled.length} official model(s) not enabled (${unenabled.join(', ')}) — enable them from /provider`, 'debug')
    }
    if (retired.length > 0) {
      log(`${status.route}: ${retired.length} enabled model(s) the endpoint no longer advertises (${retired.join(', ')})`, 'debug')
    }
  }
}

/**
 * Structural equality for model entries, key order ignored: two entries with
 * the same fields are the same entry no matter how a previous write happened
 * to order them.
 */
function sameEntries(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false
  return a.every((entry, index) => canonicalJson(entry) === canonicalJson(b[index]))
}

/** JSON with object keys sorted at every depth, for stable comparison. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = asRecord(value)
  if (record === undefined) return JSON.stringify(value) ?? 'null'
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/** The ref the derived route stores: the profile's own, else the vendor's env var. */
async function syncRefOf(
  host: ProviderSetupHost,
  provider: ConfiguredProvider,
  target: CatalogLiveTarget,
): Promise<string | undefined> {
  if (provider.ref !== '') return provider.ref
  if (host.envShadows(target.envRef)) return target.envRef
  return await host.readCredential(target.envRef) === undefined ? undefined : target.envRef
}

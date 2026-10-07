/**
 * Official-model sync for catalog routes.
 *
 * A catalog route's served models are the installed pi-ai snapshot plus
 * whatever its `llm-pi-ai` profile pins; neither follows the vendor's own
 * listing, and a profile only carries ROUTE-level `api`/`baseURL`, so an id
 * the installed catalog does not describe cannot join the catalog route
 * without forcing every catalog model of that route onto one wire protocol.
 * This module therefore leaves the catalog route alone and mirrors the
 * vendor's EXTRA models into a derived route it owns
 * (`<route>-live`, see {@link derivedCatalogRoute}), whose single protocol
 * and endpoint are the sync's own facts.
 *
 * Only routes with a known live target ({@link CATALOG_LIVE_TARGETS}) are
 * eligible: which endpoint publishes a route's roster, and over which
 * protocol, is a vendor fact that no profile states. The catalog route
 * itself is read-only here — an explicit `models` list is the user's own
 * selection and is never rewritten (explicit config > persisted user choice
 * > defaults), so a model the user un-checked never comes back through a
 * sync.
 *
 * The derived route is sync-owned: its `models` are replaced wholesale from
 * the vendor listing (minus the ids the installed catalog already covers),
 * so a model the vendor retires leaves the picker at the next pass. A stored
 * derived route pointing at another endpoint or protocol is refused, never
 * overwritten — that shape means a human repurposed the route.
 */

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
  },
}

/** The live target of one catalog route, or undefined when it has none. */
export function catalogLiveTarget(route: string): CatalogLiveTarget | undefined {
  return Object.hasOwn(CATALOG_LIVE_TARGETS, route) ? CATALOG_LIVE_TARGETS[route] : undefined
}

/** The derived route this sync owns for one catalog route: `<route>-live`. */
export function derivedCatalogRoute(route: string): string {
  return `${route}-live`
}

/**
 * Bound on a background pass's two discovery requests. A boot must not hold
 * a socket (or a promise) past its own usefulness, and a listing that takes
 * longer than this is indistinguishable from being offline.
 */
export const CATALOG_SYNC_TIMEOUT_MS = 15_000

/** Why a pass changed nothing. */
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

/** One route's sync pass. */
export interface CatalogSyncResult {
  readonly route: string
  /** The derived route this pass addressed: {@link derivedCatalogRoute}. */
  readonly derived: string
  readonly status: 'synced' | 'unchanged' | 'removed' | 'skipped' | 'failed'
  /** Ids the derived route gained in this pass. */
  readonly added: readonly string[]
  /** Ids the derived route lost in this pass (retired, or now catalog-covered). */
  readonly removed: readonly string[]
  /** The derived route's model ids this pass settled on (empty for a refusal or a removal). */
  readonly models: readonly string[]
  readonly reason?: CatalogSyncReason
}

/** One catalog route a sync pass could address. */
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
 * Configured catalog routes this build can sync, in configured order — the
 * wizard's picker rows. Eligibility is deliberately narrow: a route must be
 * configured (an unconfigured route has no key and serves nothing), be a
 * catalog route, and have a live target.
 */
export function syncableCatalogRoutes(host: ProviderSetupHost): readonly CatalogSyncCandidate[] {
  const names = new Map(host.listCatalogProviders().map(row => [row.provider, row.displayName] as const))
  return host.listConfiguredProviders()
    .filter(provider => provider.isCatalog && catalogLiveTarget(provider.route) !== undefined)
    .map(provider => ({ route: provider.route, displayName: names.get(provider.route) ?? provider.route }))
}

/**
 * Run one sync pass per eligible route. Nothing here throws for an ordinary
 * refusal (no key, offline, unsupported route): each outcome is reported as
 * its own {@link CatalogSyncResult}, so a boot pass and an interactive pass
 * share one code path and one vocabulary.
 */
export async function syncCatalogRoutes(
  host: ProviderSetupHost,
  options: CatalogSyncOptions = {},
): Promise<readonly CatalogSyncResult[]> {
  const configured = host.listConfiguredProviders()
  const names = new Map(host.listCatalogProviders().map(row => [row.provider, row.displayName] as const))
  const results: CatalogSyncResult[] = []
  for (const provider of configured) {
    if (options.route !== undefined && provider.route !== options.route) continue
    const target = catalogLiveTarget(provider.route)
    if (target === undefined) continue
    results.push(await syncOneRoute(host, provider, target, names.get(provider.route), options))
  }
  return results
}

/**
 * Best-effort boot pass: sync every eligible route, logging real changes and
 * real write failures only. A boot must never depend on the network (an
 * offline or unauthenticated host is a normal state, not a report), and a
 * pass that changes nothing writes nothing, so repeated starts are silent.
 * @param host - the provider-setup seam.
 * @param log - one line per real event; the caller picks level and prefix.
 * @returns whether any route's derived profile actually changed.
 */
export async function syncCatalogRoutesQuietly(
  host: ProviderSetupHost,
  log: (message: string, level: 'debug' | 'warn') => void,
  options: CatalogSyncOptions = {},
): Promise<boolean> {
  const results = await syncCatalogRoutes(host, options)
  let changed = false
  for (const result of results) {
    if (result.status === 'synced') {
      changed = true
      log(`${result.route} → ${result.derived}: +${result.added.length} / -${result.removed.length}`, 'debug')
    } else if (result.status === 'removed') {
      changed = true
      log(`${result.route}: no models beyond the installed catalog — removed ${result.derived}`, 'debug')
    } else if (result.status === 'failed') {
      log(`${result.route}: ${result.reason ?? 'sync failed'}`, 'debug')
    }
  }
  return changed
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

async function syncOneRoute(
  host: ProviderSetupHost,
  provider: ConfiguredProvider,
  target: CatalogLiveTarget,
  displayName: string | undefined,
  options: CatalogSyncOptions,
): Promise<CatalogSyncResult> {
  const derived = derivedCatalogRoute(provider.route)
  const skipped = (reason: CatalogSyncReason, status: 'skipped' | 'failed' = 'skipped'): CatalogSyncResult =>
    ({ route: provider.route, derived, status, added: [], removed: [], models: [], reason })
  if (!provider.isCatalog) return skipped('not-catalog')
  const ref = await syncRefOf(host, provider, target)
  if (ref === undefined) return skipped('no-credential')
  const apiKey = host.envShadows(ref) ? host.envValue(ref) : await host.readCredential(ref)
  // An empty key is a hard invalid-credential upstream, so it is the same
  // refusal as a missing one rather than an anonymous listing.
  if (apiKey === undefined || apiKey === '') return skipped('no-credential')

  // Pass 1: the ids the installed catalog describes — the catalog route
  // already serves those, so they are never duplicated into the derived route.
  let catalogIds: ReadonlySet<string>
  try {
    catalogIds = new Set((await host.discoverModels({ provider: provider.route }, { signal: options.signal }))
      .map(row => row.id))
  } catch {
    return skipped('catalog-failed')
  }
  // Pass 2: the vendor's own roster.
  let liveIds: readonly string[]
  try {
    liveIds = (await host.discoverModels(
      { baseURL: target.baseURL, api: target.api, apiKey },
      { signal: options.signal },
    )).map(row => row.id)
  } catch {
    return skipped('listing-failed', 'failed')
  }
  if (liveIds.length === 0) return skipped('listing-empty', 'failed')

  const vendorOnly = liveIds.filter(id => !catalogIds.has(id))
  const existing = host.listConfiguredProviders().find(row => row.route === derived)
  if (existing !== undefined
    && ((existing.api !== undefined && existing.api !== target.api)
      || (existing.baseURL !== undefined && existing.baseURL !== target.baseURL))) {
    return skipped('derived-conflict')
  }
  const previous = existing?.models ?? []
  if (vendorOnly.length === 0) {
    // Nothing beyond the catalog: a route serving no models cannot validate,
    // so the honest end state is no route at all. Removal only happens on a
    // listing that SUCCEEDED — an offline pass never prunes.
    if (!host.routeExists(derived)) {
      return { route: provider.route, derived, status: 'unchanged', added: [], removed: [], models: [] }
    }
    await host.removeProfile(derived)
    return { route: provider.route, derived, status: 'removed', added: [], removed: previous, models: [] }
  }

  // Kept ids re-enter their stored entries verbatim, so per-model fields this
  // module never learned about (contextWindow tuned by hand, compat, …)
  // survive a re-sync.
  const storedById = new Map((existing?.modelEntries ?? [])
    .flatMap(entry => typeof entry['id'] === 'string' ? [[entry['id'], entry] as const] : []))
  const models = vendorOnly.map(id => storedById.get(id) ?? { id })
  // An already-matching route is left completely alone: a start (or a re-run
  // of the sync) must not rewrite settings just because it could.
  if (existing !== undefined && existing.ref === ref && sameModelIds(vendorOnly, previous)) {
    return { route: provider.route, derived, status: 'unchanged', added: [], removed: [], models: vendorOnly }
  }
  await host.mutateProfile(derived, [
    { op: 'set', path: ['models'], value: models },
    { op: 'set', path: ['api'], value: target.api },
    { op: 'set', path: ['baseURL'], value: target.baseURL },
    { op: 'set', path: ['apiKeyEnv'], value: ref },
    { op: 'set', path: ['displayName'], value: `${displayName ?? provider.route} (live)` },
  ])
  return {
    route: provider.route,
    derived,
    status: 'synced',
    added: vendorOnly.filter(id => !previous.includes(id)),
    removed: previous.filter(id => !vendorOnly.includes(id)),
    models: vendorOnly,
  }
}

/** Same ids, order included: the vendor listing's order is part of its answer. */
function sameModelIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

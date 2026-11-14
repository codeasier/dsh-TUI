/**
 * Headless regression for the `/provider` wizard (src/dsh-adapter/providerWizard.ts).
 * Drives runProviderWizard with a stubbed ProviderSetupHost and a scripted
 * `ask` (answers keyed by question id, the way AskUserQuestionPanel would
 * submit them), asserting per scenario:
 *
 * 1. catalog path: profile shape (apiKeyEnv only + narrowed models, never
 *    an `api` field), credential written under the derived ref, switch
 *    question answered "keep" → no switchModel call.
 * 2. catalog path with NO models picked: profile omits `models` (whole
 *    catalog stays served) and the switch question is skipped.
 * 3. custom path with failed discovery: falls back to the manual model-id
 *    question; profile carries api + baseURL + plain id models.
 * 4. custom path with discovery: adopted capacities land on the models.
 * 5. writeProfile failure with no prior credential unsets the new one.
 * 6. env shadow: credential write skipped, profile still references the ref.
 * 7. user cancel (Esc) mid-wizard: zero side effects, outcome 'cancelled'.
 * 8. invalid route id is rejected and re-asked before proceeding.
 * 9. deriveKeyRef matches the web UI's convention.
 * 10. overwrite rollback RESTORES the previous credential value instead of
 *    deleting it (regression: unconditional unset destroyed the old key).
 * 11. providerSetup availability must not call APIs absent from dsh-llm rc.6
 *    (regression: listModelDiscoveryNamespaces() is undefined there and the
 *    guard threw before the wizard could open).
 * 13. OAuth branch: mode gains a third option, picking an unsigned provider
 *    runs login, pushes a masked summary, reports success.
 * 13b. Host-owned DeepSeek account: no token expiry is invented in the
 *    provider picker or successful-login summary.
 * 14. OAuth branch, signed-in provider choosing sign-out: logout runs, no
 *    login attempt, outcome 'signed-out'.
 * 15. OAuth branch, login failure: error surfaced with the cause.
 * 16. without host.oauth the mode question stays two options (optional-plugin
 *    contract); the action layer offers add/edit — delete is gone from the
 *    top level (it now lives inside the edit menu).
 * 17. edit a catalog route: the menu offers only key/models/delete; editing
 *    the model list pre-checks the enabled models (defaultSelected) and
 *    PATCHES just `models` (no whole-profile rewrite), outcome updated.
 * 18. edit a custom route, API key only: credential overwritten, profile
 *    untouched, transcript notes the updated key.
 * 19. edit a custom route, base URL: a single-field path patch sets
 *    `baseURL` and nothing else — no profile rewrite, no discovery.
 * 20. edit a custom route, wire protocol: the current protocol is
 *    default-focused (defaultSelected); a single-field path patch sets `api`.
 * 21. edit a shadowed-key route: "Edit API Key" refuses (env) → cancelled,
 *    nothing written.
 * 22. edit with no configured providers: warning, cancelled.
 * 23. delete via the edit menu (stored key): profile then credential removed,
 *    both in transcript.
 * 24. delete via the edit menu with an env-shadowed key: credential left
 *    alone, env line pushed.
 * 25. delete cancelled at the confirm: nothing removed.
 * 26. a no-op base URL edit (empty input): nothing written, 'cancelled'.
 * 27. custom-route model-list edit that ends up empty: rejected with the
 *    required-models error, nothing written.
 * 28. menu shape: built-in routes offer key/models/delete only; custom routes
 *    also offer base URL and wire protocol.
 * 29. a catalog route that carries an explicit `api` override is still
 *    catalog (isCatalog), so its menu stays built-in-shaped (#3).
 * 30. delete where the profile unsets but the credential removal throws:
 *    outcome is still 'deleted', completion invalidated, a warning surfaces,
 *    transcript says the key cleanup failed (#2).
 * 31. delete of a route whose key ref is shared with another configured
 *    route: the credential is kept, the shared-key line is pushed (#5).
 * 32. a targeted edit of a stored profile that carries unknown fields:
 *    mutateProfile receives only the changed path — the untouched fields
 *    never enter the op list (#1).
 * 34. a catalog route with a stored baseURL is discovered TWICE — the
 *    installed catalog (rich metadata) plus a live endpoint probe (no
 *    `provider` field, so the upstream seam cannot short-circuit to the
 *    static catalog); rows merge with live-only ids tagged new, and an
 *    endpoint-only id carries its disclosed capacities into the write
 *    while a catalog-covered id stays plain `{id}`.
 * 35. a catalog route without a baseURL stays on the installed-catalog
 *    listing: exactly one discovery request, no credential resolved, and
 *    the models question notes the snapshot origin.
 * 36. a live probe that fails for a catalog+baseURL route degrades to the
 *    catalog rows with a warning — not to the manual-id fallback.
 * 37. a custom route with no resolvable key probes anonymously: the
 *    discovery request OMITS apiKey instead of sending an empty string.
 * 38. the add flow on a catalog route with a typed baseURL merges the same
 *    way, and the written profile carries capacities only for the
 *    endpoint-only id.
 * 39. mixed-protocol catalogs skip the unsafe live probe and reject free-typed
 *    endpoint-only ids.
 * 40. catalog routes with custom headers explicitly fall back to the snapshot.
 * 41. a failed catalog lookup never lets live capacities enter the profile.
 * 42. the Anthropic catalog uses the anthropic-messages live probe protocol.
 * 43–52. Tab capability drafts: add/edit commits, cancellation, unchanged
 * selections, unchecked edits, whole-catalog overrides, override migration,
 * offline editing, inheritance resets, validation and no-op saves.
 * 63. managing official models: the vendor's extra ids are the selectable
 *    rows (enabled ones pre-checked), nothing is enabled that the user did not
 *    tick, and the derived route is written with exactly that set — enriched
 *    with the vendor catalog's name, capacities, modalities and thinking tiers.
 * 43b. without the vendor catalog (models.dev unreachable) the same pass still
 *    works: rows say so, entries stay bare, and the user is told.
 * 64. un-checking an enabled model removes it while a kept id re-enters its
 *    stored entry, hand-tuned fields beating the catalog.
 * 65. a selection that already matches writes nothing, while a bare stored
 *    entry gains the catalog fields exactly once.
 * 45b. an enabled vendor-only id that joins the installed catalog stays
 *    selectable and is retired only if the vendor actually drops it; boot
 *    reporting and the wizard agree, and keeping the selection writes nothing.
 * 66. no resolvable key refuses by name and never probes.
 * 67. a failed vendor listing changes nothing.
 * 68. clearing every row retires the derived route; with no derived route it
 *    is a plain no-op.
 * 69. a derived route repointed at another endpoint/protocol is refused,
 *    never overwritten.
 * 49b. a catalog parent with explicit/inherited connection overrides never
 *    offers official sync, reads its key, probes the vendor or repairs routes;
 *    ordinary edits against an explicitly configured relay still work.
 * 49c. adding over an overridden/unknown existing catalog route cannot send
 *    a typed draft key to the default vendor endpoint before confirmation,
 *    including when the route changes while the catalog lookup is pending.
 * 70. boot reports un-enabled and retired ids, repairs only the routing of
 *    enabled models, and neither throws nor writes when the listing is down.
 * 50b. stateful migration preserves unknown model fields, writes the target
 *    before source cleanup, checks concurrent edits and all-layer existence,
 *    and stops later repairs/logging when the owner unloads during a write.
 * 71. the action question gains the management option only while a configured
 *    catalog route has a vendor listing.
 * 72. connecting a catalog route reports the vendor's extras (and their
 *    derived route) in the model question and enables nothing by itself.
 * 73. an unreachable vendor listing while connecting keeps the snapshot note
 *    and surfaces the live-probe failure once.
 * 74. editing that route's model list shows the same note and keeps
 *    vendor-only ids unselectable.
 *
 * The route picker (several eligible routes) cannot be exercised yet: exactly
 * one route in `CATALOG_LIVE_TARGETS` has a vendor listing, so every pass has
 * a single candidate. The branch stays for the next registered target.
 *
 * Run with plain node against the compiled lib (after `pnpm build`):
 * `node scripts/verify-provider-wizard.mjs`
 */
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import {
  deriveKeyRef,
  runProviderWizard,
} from '../lib/types/dsh-adapter/providerWizard.js'
import { inspectCatalogRoutes, reportCatalogRoutesQuietly, syncableCatalogRoutes, writeCatalogModels } from '../lib/types/dsh-adapter/catalogSync.js'
import { getLang, setLang, t } from '../lib/types/i18n.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const CANCEL = new UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED')

/**
 * Build the wizard deps. `script` maps question id → answer spec:
 *   { selected: [...] }        option answer
 *   { custom: '...' }          free-text answer
 *   'cancel'                   throw the panel's cancel error
 *   [spec, spec, ...]          successive answers for a question asked more
 *                              than once in a run; the last spec repeats if
 *                              the list runs out
 * Discovery is stubbed via `options.discovered` (array),
 * `options.discoverThrows`, or `options.discover` (a per-request responder
 * receiving the request and returning rows or throwing — use it to answer
 * the catalog and live probes differently); env shadow via `options.shadow`.
 */
function makeDeps(script, options = {}) {
  const calls = {
    credentials: [],
    removed: [],
    removedProfiles: [],
    profiles: [],
    mutations: [],
    notifications: [],
    pushed: [],
    switches: [],
    asks: [],
    /** every discoverModels request, in order (shape regressions). */
    discoverRequests: [],
    /** the per-request options bag (signal forwarding). */
    discoverSignals: [],
    /** question id → hideCustomInput flag as submitted (panel contract). */
    hideFlags: {},
    /** question id → option descriptions, for catalog row-shape regressions. */
    optionDescriptions: {},
    /** question id → detail string, for confirm-summary regressions. */
    details: {},
    /** question id → defaultSelected labels, for pre-check regressions. */
    defaults: {},
  }
  const specCounters = {}
  const specFor = id => {
    const raw = script[id]
    if (!Array.isArray(raw)) return raw
    const index = Math.min(specCounters[id] ?? 0, raw.length - 1)
    specCounters[id] = (specCounters[id] ?? 0) + 1
    return raw[index]
  }
  const host = {
    listCatalogProviders: () => options.catalogProviders ?? [
      { provider: 'deepseek', displayName: 'DeepSeek' },
      { provider: 'openai', displayName: 'OpenAI' },
      { provider: 'same-name', displayName: 'same-name' },
    ],
    listConfiguredProviders: () => options.configured ?? [],
    // All-layer ref census. The stub derives it from `configured` by default,
    // dropping routes whose profile unset already landed (stateful like the
    // real merged section); `options.refUsers` overrides per ref to simulate
    // base-layer consumers invisible to the user layer.
    listRefUsers: (ref, exceptRoute) => {
      // Only the post-unset re-check (no exclusion arg) throws under the
      // flag; the pre-confirm census still runs the derived stub.
      if (options.refUsersThrows && exceptRoute === undefined) throw new Error('settings layer unavailable')
      if (options.refUsers) return options.refUsers[ref] ?? []
      return (options.configured ?? [])
        .filter(row => row.route !== exceptRoute
          && !calls.removedProfiles.includes(row.route)
          && row.ref === ref)
        .map(row => row.route)
    },
    routeExists: route => options.routeExists ?? (options.configured ?? []).some(row => row.route === route),
    discoverModels: async (request, discoverOptions) => {
      calls.discoverRequests.push(request)
      calls.discoverSignals.push(discoverOptions?.signal)
      if (options.discover) return options.discover(request)
      if (options.discoverThrows) throw new Error('connection refused')
      return options.discovered ?? []
    },
    envShadows: ref => options.shadow === ref,
    envValue: ref => options.shadow === ref ? (options.shadowValue ?? 'sk-from-env') : undefined,
    readCredential: async ref => options.storedCredentials?.[ref],
    writeCredential: (ref, value) => {
      if (options.credentialThrows) throw new Error('credential rejected')
      calls.credentials.push([ref, value])
    },
    removeCredential: ref => {
      if (options.credentialRemoveThrows) throw new Error('credentials store unwritable')
      calls.removed.push(ref)
    },
    removeProfile: route => {
      if (options.removeProfileThrows) throw new Error('settings-rejected: unset failed')
      calls.removedProfiles.push(route)
    },
    writeProfile: async (route, profile) => {
      if (options.profileThrows) throw new Error('settings-rejected: unserviceable')
      calls.profiles.push([route, profile])
    },
    mutateProfile: async (route, ops) => {
      // `mutateThrows` names ONE route (the derived route) so the connect-time
      // sync can fail while the catalog profile write still succeeds.
      if (options.profileThrows || options.mutateThrows === route) throw new Error('settings-rejected: unserviceable')
      calls.mutations.push([route, ops])
      if (options.statefulProfiles) {
        const provider = options.configured.find(row => row.route === route)
          ?? { route, ref: '', shadowed: false, isCatalog: false }
        for (const op of ops) {
          if (op.path[0] === 'models') {
            provider.modelEntries = structuredClone(op.value)
            provider.models = op.value.map(entry => entry.id)
          } else if (op.path[0] === 'apiKeyEnv') provider.ref = op.value
          else provider[op.path[0]] = structuredClone(op.value)
        }
        if (!options.configured.includes(provider)) options.configured.push(provider)
      }
    },
    ...(options.oauth ? { oauth: options.oauth } : {}),
  }
  // Vendor metadata source: the fixture by default, `null` to simulate an
  // offline/unreachable models.dev.
  const readVendorCatalog = options.vendorCatalog === null
    ? async () => undefined
    : async () => options.vendorCatalog ?? VENDOR_CATALOG
  const deps = {
    host,
    ask: async request => {
      const answers = []
      for (const question of request.questions) {
        calls.asks.push(question.id)
        calls.hideFlags[question.id] = question.hideCustomInput === true
        calls.optionDescriptions[question.id] = Object.fromEntries(
          (question.options ?? []).map(option => [option.label, option.description]),
        )
        calls.details[question.id] = question.detail
        calls.defaults[question.id] = question.defaultSelected ?? []
        const spec = question.id === 'action' && script['action'] === undefined
          ? ACTION_ADD
          : specFor(question.id)
        if (spec === undefined) throw new Error(`unscripted question: ${question.id}`)
        if (spec === 'cancel') throw CANCEL
        for (const [id, fields] of Object.entries(spec.edits ?? {})) {
          if (question.modelEditor === undefined) throw new Error('model capability editor missing')
          question.modelEditor.save(id, { ...question.modelEditor.read(id).values, ...fields })
        }
        if (spec.cancelAfterEdits) throw CANCEL
        answers.push({
          id: question.id,
          selected: spec.selected ?? [],
          ...(spec.custom !== undefined ? { custom: spec.custom } : {}),
        })
      }
      return { answers }
    },
    notify: (text, opts) => { calls.notifications.push({ text, color: opts?.color }) },
    pushLocal: (title, lines) => { calls.pushed.push({ title, lines }) },
    readVendorCatalog,
    working: () => options.working ?? false,
    switchModel: async (provider, model) => {
      calls.switches.push([provider, model])
      return true
    },
  }
  return { deps, calls }
}

const MODE_CATALOG = { selected: [t('provider-opt-catalog')] }
const MODE_CUSTOM = { selected: [t('provider-opt-custom')] }
const SKIP_BASEURL = { selected: [t('provider-opt-baseurl-skip')] }
const CONFIRM_WRITE = { selected: [t('provider-opt-confirm-write')] }
const KEEP_MODEL = { selected: [t('provider-opt-switch-keep')] }
const ACTION_ADD = { selected: [t('provider-opt-action-add')] }
const ACTION_EDIT = { selected: [t('provider-opt-action-edit')] }
const ACTION_SYNC = { selected: [t('provider-opt-action-sync')] }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** The vendor routing header op one derived-route write carries. */
const sessionHeaderOp = ops => ops.find(op => eq(op.path, ['headers']))
// models.dev-shaped fixture: the fields the wizard maps onto a model entry.
const VENDOR_CATALOG = {
  'opencode-go': {
    models: {
      'grok-4.5': {
        name: 'Grok 4.5',
        limit: { context: 500000, output: 500000 },
        modalities: { input: ['text', 'image'] },
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
      },
      'longcat-2.5-preview-free': {
        name: 'LongCat 2.5 Preview Free',
        limit: { context: 1000000, output: 131072 },
        modalities: { input: ['text', 'image'] },
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }],
      },
      'claude-haiku-5-5': {
        name: 'Claude Haiku 5.5',
        limit: { context: 1000000, output: 128000 },
        modalities: { input: ['text', 'image'] },
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }],
      },
    },
  },
  'opencode': {
    models: {
      'glm-5': {
        name: 'GLM-5',
        limit: { context: 204800, output: 131072 },
        modalities: { input: ['text'] },
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }],
      },
    },
  },
}
// Edit-menu picks (asked exactly once per edit session).
const MENU_KEY = { selected: [t('provider-opt-edit-key')] }
const MENU_BASEURL = { selected: [t('provider-opt-edit-baseurl')] }
const MENU_PROTOCOL = { selected: [t('provider-opt-edit-protocol')] }
const MENU_MODELS = { selected: [t('provider-opt-edit-models')] }
const MENU_DELETE = { selected: [t('provider-opt-edit-delete')] }

// 1. catalog happy path: discovery + narrowed models + switch declined.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': { selected: ['deepseek'] },
    'apikey': { custom: 'sk-test-key' },
    'baseurl-choice': SKIP_BASEURL,
    'models': { selected: ['deepseek-chat'], custom: 'deepseek-extra' },
    'confirm': CONFIRM_WRITE,
    'switch': KEEP_MODEL,
  }, {
    discovered: [
      { id: 'deepseek-chat', contextWindow: 128000 },
      { id: 'deepseek-reasoner', contextWindow: 128000 },
    ],
  })
  const outcome = await runProviderWizard(deps)
  check('1 catalog: outcome added', outcome === 'added', outcome)
  check('1 catalog: credential under derived ref',
    eq(calls.credentials, [['DEEPSEEK_API_KEY', 'sk-test-key']]),
    JSON.stringify(calls.credentials))
  check('1 catalog: profile shape (no api/baseURL, id-only models)',
    eq(calls.profiles, [['deepseek', {
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      models: [{ id: 'deepseek-chat' }, { id: 'deepseek-extra' }],
    }]]),
    JSON.stringify(calls.profiles))
  check('1 catalog: keep → no switch', eq(calls.switches, []))
  check('1 catalog: transcript summary pushed without the key',
    calls.pushed.length === 1
      && calls.pushed[0].lines.every(line => !line.includes('sk-test-key')))
  check('1 catalog: confirm detail is a preview, not a success line',
    (calls.details.confirm ?? '').includes(t('provider-line-route', { route: 'deepseek' }))
      && !(calls.details.confirm ?? '').includes(t('provider-line-action-added', { route: 'deepseek' }))
      && (calls.details.confirm ?? '').includes(t('provider-line-keyref-preview', { ref: 'DEEPSEEK_API_KEY' })),
    calls.details.confirm)
}

// 2. catalog, no models picked: models omitted, switch question skipped.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': { selected: ['openai'] },
    'apikey': { custom: 'sk-openai' },
    'baseurl-choice': SKIP_BASEURL,
    'models': { selected: [] },
    'confirm': CONFIRM_WRITE,
  }, {
    discovered: [{ id: 'gpt-5' }],
  })
  const outcome = await runProviderWizard(deps)
  check('2 catalog bare: outcome added', outcome === 'added', outcome)
  check('2 catalog bare: profile omits models',
    eq(calls.profiles, [['openai', { apiKeyEnv: 'OPENAI_API_KEY' }]]),
    JSON.stringify(calls.profiles))
  check('2 catalog bare: switch never asked', !calls.asks.includes('switch'))
}

// 3. custom path, discovery fails: manual model fallback question.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CUSTOM,
    'route-id': { custom: 'acme-gateway' },
    'apikey': { custom: 'acme-key' },
    'baseurl': { custom: 'https://gw.example/v1' },
    'protocol': { selected: ['openai-completions'] },
    'models-fallback': { custom: 'acme-large, acme-think' },
    'confirm': CONFIRM_WRITE,
    'switch': { selected: [t('provider-opt-switch-now', { model: 'acme-large' })] },
  }, { discoverThrows: true })
  const outcome = await runProviderWizard(deps)
  check('3 custom fallback: outcome added', outcome === 'added', outcome)
  check('3 custom fallback: profile carries api + baseURL + id models',
    eq(calls.profiles, [['acme-gateway', {
      apiKeyEnv: 'ACME_GATEWAY_API_KEY',
      baseURL: 'https://gw.example/v1',
      api: 'openai-completions',
      models: [{ id: 'acme-large' }, { id: 'acme-think' }],
    }]]),
    JSON.stringify(calls.profiles))
  check('3 custom fallback: discovery-failure warning notified',
    calls.notifications.some(n => n.color === 'warning'))
  check('3 custom fallback: accepted switch to first model',
    eq(calls.switches, [['acme-gateway', 'acme-large']]),
    JSON.stringify(calls.switches))
}

// 3b. several enabled models: the switch question offers each one (the
// default is picked explicitly, not forced to the first) plus keep, and the
// keep row names the live model.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CUSTOM,
    'route-id': { custom: 'acme-gateway' },
    'apikey': { custom: 'acme-key' },
    'baseurl': { custom: 'https://gw.example/v1' },
    'protocol': { selected: ['openai-completions'] },
    'models-fallback': { custom: 'acme-large, acme-think' },
    'confirm': CONFIRM_WRITE,
    'switch': { selected: [t('provider-opt-switch-now', { model: 'acme-think' })] },
  }, { discoverThrows: true })
  const outcome = await runProviderWizard({ ...deps, currentModel: () => 'deepseek-chat' })
  check('3b several models: outcome added', outcome === 'added', outcome)
  check('3b several models: every enabled model offered, keep last',
    eq(Object.keys(calls.optionDescriptions.switch ?? {}), [
      t('provider-opt-switch-now', { model: 'acme-large' }),
      t('provider-opt-switch-now', { model: 'acme-think' }),
      t('provider-opt-switch-keep'),
    ]),
    JSON.stringify(calls.optionDescriptions.switch))
  check('3b several models: keep names the live model',
    calls.optionDescriptions.switch?.[t('provider-opt-switch-keep')]
      === t('provider-opt-switch-keep-desc', { model: 'deepseek-chat' }),
    JSON.stringify(calls.optionDescriptions.switch))
  check('3b several models: switched to the picked (second) model',
    eq(calls.switches, [['acme-gateway', 'acme-think']]),
    JSON.stringify(calls.switches))
}

// 4. custom path, discovery supplies capacities.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CUSTOM,
    'route-id': { custom: 'local-llm' },
    'apikey': { custom: 'no-key-needed-but-required' },
    'baseurl': { custom: 'http://127.0.0.1:11434/v1' },
    'protocol': { selected: ['openai-completions'] },
    'models': { selected: ['qwen3-32b'] },
    'confirm': CONFIRM_WRITE,
    'switch': KEEP_MODEL,
  }, {
    discovered: [{ id: 'qwen3-32b', contextWindow: 131072, maxTokens: 8192 }],
  })
  const outcome = await runProviderWizard(deps)
  check('4 custom discovered: outcome added', outcome === 'added', outcome)
  check('4 custom discovered: capacities adopted',
    eq(calls.profiles[0]?.[1]?.models, [{ id: 'qwen3-32b', contextWindow: 131072, maxTokens: 8192 }]),
    JSON.stringify(calls.profiles[0]?.[1]?.models))
}

// 5. writeProfile failure with no prior credential unsets the new one.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': { selected: ['deepseek'] },
    'apikey': { custom: 'sk-rollback' },
    'baseurl-choice': SKIP_BASEURL,
    'models': { selected: ['deepseek-chat'] },
    'confirm': CONFIRM_WRITE,
  }, {
    discovered: [{ id: 'deepseek-chat' }],
    profileThrows: true,
  })
  const outcome = await runProviderWizard(deps)
  check('5 rollback: outcome failed', outcome === 'failed', outcome)
  check('5 rollback: credential unset after profile failure',
    eq(calls.removed, ['DEEPSEEK_API_KEY']), JSON.stringify(calls.removed))
  check('5 rollback: error notified',
    calls.notifications.some(n => n.color === 'error'))
}

// 10. overwrite rollback restores the previous credential, never unsets it.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': { selected: ['deepseek'] },
    'apikey': { custom: 'sk-new' },
    'baseurl-choice': SKIP_BASEURL,
    'models': { selected: ['deepseek-chat'] },
    'confirm': CONFIRM_WRITE,
  }, {
    discovered: [{ id: 'deepseek-chat' }],
    profileThrows: true,
    storedCredentials: { DEEPSEEK_API_KEY: 'sk-old' },
  })
  const outcome = await runProviderWizard(deps)
  check('10 overwrite rollback: outcome failed', outcome === 'failed', outcome)
  check('10 overwrite rollback: old key restored, never unset',
    eq(calls.removed, [])
      && eq(calls.credentials, [
        ['DEEPSEEK_API_KEY', 'sk-new'],
        ['DEEPSEEK_API_KEY', 'sk-old'],
      ]),
    JSON.stringify({ removed: calls.removed, credentials: calls.credentials }))
}

// 11. the compiled channel must not reference APIs absent from dsh-llm rc.6.
{
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(
    new URL('../lib/types/dsh-adapter/channel/settings-host.js', import.meta.url), 'utf8')
  check('11 channel: no listModelDiscoveryNamespaces call (absent in rc.6)',
    !source.includes('.listModelDiscoveryNamespaces('))
  check('11 channel: availability guard uses the settings descriptor',
    source.includes("descriptor.ns === 'llm-pi-ai'"))
}

// 6. env shadow: credential write skipped, profile still references the ref.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': { selected: ['deepseek'] },
    'apikey': { custom: 'sk-shadowed' },
    'baseurl-choice': SKIP_BASEURL,
    'models': { selected: ['deepseek-chat'] },
    'confirm': CONFIRM_WRITE,
    'switch': KEEP_MODEL,
  }, {
    discovered: [{ id: 'deepseek-chat' }],
    shadow: 'DEEPSEEK_API_KEY',
  })
  const outcome = await runProviderWizard(deps)
  check('6 shadow: outcome added', outcome === 'added', outcome)
  check('6 shadow: credential write skipped', eq(calls.credentials, []))
  check('6 shadow: profile still references the ref',
    calls.profiles[0]?.[1]?.apiKeyEnv === 'DEEPSEEK_API_KEY')
}

// 7. cancel mid-wizard: zero side effects.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': 'cancel',
  })
  const outcome = await runProviderWizard(deps)
  check('7 cancel: outcome cancelled', outcome === 'cancelled', outcome)
  check('7 cancel: nothing written',
    eq(calls.credentials, []) && eq(calls.profiles, []) && eq(calls.removed, []))
}

// 8. invalid route id is rejected, then re-asked (scripted via ask wrapper).
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CUSTOM,
    'route-id': { custom: 'BAD ROUTE' },
    'apikey': { custom: 'k' },
    'baseurl': { custom: 'https://gw.example/v1' },
    'protocol': { selected: ['openai-completions'] },
    'models-fallback': { custom: 'm1' },
    'confirm': CONFIRM_WRITE,
    'switch': KEEP_MODEL,
  }, { discoverThrows: true })
  let routeIdAsks = 0
  const innerAsk = deps.ask
  deps.ask = async request => {
    if (request.questions.some(q => q.id === 'route-id')) {
      routeIdAsks += 1
      if (routeIdAsks === 2) {
        return { answers: [{ id: 'route-id', selected: [], custom: 'good-route' }] }
      }
    }
    return innerAsk(request)
  }
  const outcome = await runProviderWizard(deps)
  check('8 invalid route: re-asked then proceeded',
    routeIdAsks === 2 && outcome === 'added', `asks=${routeIdAsks} outcome=${outcome}`)
  check('8 invalid route: warning notified',
    calls.notifications.some(n => n.color === 'warning'))
  check('8 invalid route: written under the corrected route',
    calls.profiles[0]?.[0] === 'good-route', JSON.stringify(calls.profiles[0]?.[0]))
}

// 9. deriveKeyRef matches the web UI convention.
{
  check('9 deriveKeyRef', deriveKeyRef('acme-gateway') === 'ACME_GATEWAY_API_KEY'
    && deriveKeyRef('openai') === 'OPENAI_API_KEY')
}

// 12. hideCustomInput contract: pure option questions carry the flag, text
// questions and the models multi-select keep the input row.
{
  const catalog = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': { selected: ['deepseek'] },
    'apikey': { custom: 'sk-flags' },
    'baseurl-choice': SKIP_BASEURL,
    'models': { selected: ['deepseek-chat'] },
    'confirm': CONFIRM_WRITE,
    'switch': KEEP_MODEL,
  }, { discovered: [{ id: 'deepseek-chat' }] })
  await runProviderWizard(catalog.deps)
  check('12 hide flags (catalog path)',
    eq(catalog.calls.hideFlags, {
      'action': true,
      'mode': true,
      'catalog': true,
      'apikey': false,
      'baseurl-choice': true,
      'models': false,
      'confirm': true,
      'switch': true,
    }),
    JSON.stringify(catalog.calls.hideFlags))
  check('12 catalog omits a duplicate display name',
    catalog.calls.optionDescriptions.catalog?.['same-name'] === undefined,
    JSON.stringify(catalog.calls.optionDescriptions.catalog))

  const custom = makeDeps({
    'mode': MODE_CUSTOM,
    'route-id': { custom: 'flag-route' },
    'apikey': { custom: 'k' },
    'baseurl': { custom: 'https://gw.example/v1' },
    'protocol': { selected: ['openai-completions'] },
    'models-fallback': { custom: 'm1' },
    'confirm': CONFIRM_WRITE,
    'switch': KEEP_MODEL,
  }, { discoverThrows: true })
  await runProviderWizard(custom.deps)
  check('12 hide flags (custom path)',
    eq(custom.calls.hideFlags, {
      'action': true,
      'mode': true,
      'route-id': false,
      'apikey': false,
      'baseurl': false,
      'protocol': true,
      'models-fallback': false,
      'confirm': true,
      'switch': true,
    }),
    JSON.stringify(custom.calls.hideFlags))
}

/**
 * Build a dsh-auth-style OAuth host stub. `behavior.providers` overrides the
 * status list; `behavior.loginThrows` makes login reject with that message.
 */
function oauthStub(behavior = {}) {
  const calls = { listed: 0, logins: [], logouts: [] }
  return {
    calls,
    providers: async () => {
      calls.listed += 1
      return behavior.providers ?? [
        { provider: 'openai-codex', label: 'OpenAI Codex', oauthLabel: 'OpenAI (ChatGPT Plus/Pro)', loginLabel: 'Sign in with ChatGPT', signedIn: false, expiresAt: undefined, expired: false },
        { provider: 'anthropic', label: 'Anthropic', oauthLabel: 'Anthropic (Claude Pro/Max)', loginLabel: undefined, signedIn: true, expiresAt: 1_787_000_000_000, expired: false },
      ]
    },
    login: async provider => {
      calls.logins.push(provider)
      if (behavior.loginThrows) throw new Error(behavior.loginThrows)
      return behavior.loginResult ?? { provider, oauthLabel: 'OpenAI (ChatGPT Plus/Pro)', expiresAt: 1_787_000_000_000 }
    },
    logout: async provider => {
      calls.logouts.push(provider)
      return true
    },
  }
}

// 13. OAuth branch: mode offers three options, picking an unsigned provider
// runs login, pushes a masked summary, and reports success.
{
  const oauth = oauthStub()
  const { deps, calls } = makeDeps({
    'mode': { selected: [t('provider-opt-oauth')] },
    'oauth-provider': { selected: ['openai-codex'] },
  }, { oauth })
  const outcome = await runProviderWizard(deps)
  check('13 oauth: outcome added', outcome === 'added', outcome)
  check('13 oauth: mode offered the OAuth option',
    Object.keys(calls.optionDescriptions.mode ?? {}).length === 3,
    JSON.stringify(Object.keys(calls.optionDescriptions.mode ?? {})))
  check('13 oauth: login ran for the chosen provider',
    eq(oauth.calls.logins, ['openai-codex']), JSON.stringify(oauth.calls.logins))
  check('13 oauth: masked summary pushed with the /model hint',
    calls.pushed.length === 1 && calls.pushed[0].lines.length === 4
      && calls.pushed[0].lines.some(line => line.includes('/model') || line.includes('模型')),
    JSON.stringify(calls.pushed))
  check('13 oauth: success notified',
    calls.notifications.some(n => n.color === 'success'))
}

// 13b. DeepSeek account grants have no token expiry; neither the picker nor
// the summary may render the Unix epoch as a fabricated expiry date.
{
  const deepSeekStatus = {
    provider: 'deepseek-account', label: 'DeepSeek Account', oauthLabel: 'DeepSeek',
    loginLabel: 'Sign in with DeepSeek', signedIn: false, expiresAt: undefined, expired: false,
  }
  const oauth = oauthStub({
    providers: [deepSeekStatus],
    loginResult: { provider: 'deepseek-account', oauthLabel: 'DeepSeek', expiresAt: undefined },
  })
  const { deps, calls } = makeDeps({
    mode: { selected: [t('provider-opt-oauth')] },
    'oauth-provider': { selected: ['deepseek-account'] },
  }, { oauth })
  const outcome = await runProviderWizard(deps)
  check('13b deepseek: delegated login succeeds', outcome === 'added' && eq(oauth.calls.logins, ['deepseek-account']))
  check('13b deepseek: summary has no fabricated expiry', calls.pushed.length === 1
    && calls.pushed[0].lines.length === 3
    && !JSON.stringify(calls.pushed).includes('1970')
    && calls.pushed[0].lines.some(line => line.includes('/model')))

  const signed = oauthStub({ providers: [{ ...deepSeekStatus, signedIn: true }] })
  const signedRun = makeDeps({
    mode: { selected: [t('provider-opt-oauth')] },
    'oauth-provider': { selected: ['deepseek-account'] },
    'oauth-signed-action': { selected: [t('provider-opt-confirm-cancel')] },
  }, { oauth: signed })
  await runProviderWizard(signedRun.deps)
  const description = signedRun.calls.optionDescriptions['oauth-provider']?.['deepseek-account'] ?? ''
  check('13b deepseek: signed-in picker state has no fabricated expiry',
    description.includes(t('provider-oauth-state-in-no-expiry')) && !description.includes('1970'), description)
}

// 14. OAuth branch, signed-in provider choosing sign-out: logout runs, no
// login attempt, outcome 'signed-out'.
{
  const oauth = oauthStub()
  const { deps, calls } = makeDeps({
    'mode': { selected: [t('provider-opt-oauth')] },
    'oauth-provider': { selected: ['anthropic'] },
    'oauth-signed-action': { selected: [t('provider-opt-oauth-logout')] },
  }, { oauth })
  const outcome = await runProviderWizard(deps)
  check('14 oauth sign-out: outcome signed-out', outcome === 'signed-out', outcome)
  check('14 oauth sign-out: logout ran, no login',
    eq(oauth.calls.logouts, ['anthropic']) && eq(oauth.calls.logins, []))
  check('14 oauth sign-out: summary notes the removed credential',
    calls.pushed.length === 1 && calls.pushed[0].lines.length === 2)
}

// 15. OAuth branch, login failure: error surfaced, outcome 'failed', nothing
// pushed.
{
  const oauth = oauthStub({ loginThrows: 'invalid_grant' })
  const { deps, calls } = makeDeps({
    'mode': { selected: [t('provider-opt-oauth')] },
    'oauth-provider': { selected: ['openai-codex'] },
  }, { oauth })
  const outcome = await runProviderWizard(deps)
  check('15 oauth failure: outcome failed', outcome === 'failed', outcome)
  check('15 oauth failure: error notified with the cause',
    calls.notifications.some(n => n.color === 'error' && n.text.includes('invalid_grant')),
    JSON.stringify(calls.notifications))
  check('15 oauth failure: nothing pushed', calls.pushed.length === 0)
}

// 16. without host.oauth the mode question stays exactly two options and the
// OAuth branch is unreachable (regression for the optional-plugin contract);
// the action layer now offers exactly add / edit — delete moved into the
// edit menu, so the delete option is absent at the top level.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': 'cancel',
  })
  const outcome = await runProviderWizard(deps)
  const actionLabels = Object.keys(calls.optionDescriptions.action ?? {})
  check('16 no oauth service: action offers add/edit (delete gone)',
    actionLabels.length === 2
      && actionLabels.includes(t('provider-opt-action-add'))
      && actionLabels.includes(t('provider-opt-action-edit')),
    JSON.stringify(actionLabels))
  check('16 no oauth service: mode stayed two options',
    Object.keys(calls.optionDescriptions.mode ?? {}).length === 2,
    JSON.stringify(Object.keys(calls.optionDescriptions.mode ?? {})))
  check('16 no oauth service: catalog cancel still cancels', outcome === 'cancelled', outcome)
}

// 17. edit a catalog route: only the model list changed. The models question
// pre-checks the enabled models (defaultSelected), the profile is PATCHED at
// `models` only (no whole-profile write, no confirm/switch), key untouched.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_MODELS,
    'models': { selected: ['deepseek-reasoner'] },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: false, isCatalog: true, models: ['deepseek-chat'], modelEntries: [{ id: 'deepseek-chat' }] }],
    discovered: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
  })
  const outcome = await runProviderWizard(deps)
  check('17 edit models: outcome updated', outcome === 'updated', outcome)
  check('17 edit models: no credential write', eq(calls.credentials, []))
  check('17 edit models: whole profile never rewritten',
    eq(calls.profiles, []), JSON.stringify(calls.profiles))
  check('17 edit models: only the models path is patched',
    eq(calls.mutations, [['deepseek', [{ op: 'set', path: ['models'], value: [{ id: 'deepseek-reasoner' }] }]]]),
    JSON.stringify(calls.mutations))
  check('17 edit models: mode/route/key questions never asked',
    !calls.asks.includes('mode') && !calls.asks.includes('catalog')
      && !calls.asks.includes('route-id') && !calls.asks.includes('apikey'))
  check('17 edit models: no confirm or switch after the targeted edit',
    !calls.asks.includes('confirm') && !calls.asks.includes('switch'))
  check('17 edit models: models question pre-checks the enabled models',
    eq(calls.defaults.models, ['deepseek-chat']), JSON.stringify(calls.defaults.models))
  check('17 edit models: menu asked exactly once',
    calls.asks.filter(id => id === 'edit-menu').length === 1, JSON.stringify(calls.asks))
  check('17 edit models: summary notes the kept key',
    calls.pushed[0]?.lines.includes(t('provider-line-key-kept', { ref: 'DEEPSEEK_API_KEY' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 18. edit a custom route, API key only: the credential is overwritten and
// the profile is left untouched; the transcript notes the updated key.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_KEY,
    'apikey': { custom: 'sk-new' },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
    storedCredentials: { ACME_GATEWAY_API_KEY: 'sk-old' },
  })
  const outcome = await runProviderWizard(deps)
  check('18 edit key: outcome updated', outcome === 'updated', outcome)
  check('18 edit key: credential overwritten',
    eq(calls.credentials, [['ACME_GATEWAY_API_KEY', 'sk-new']]),
    JSON.stringify(calls.credentials))
  check('18 edit key: profile untouched', eq(calls.profiles, []), JSON.stringify(calls.profiles))
  check('18 edit key: transcript notes the updated key',
    calls.pushed[0]?.lines.includes(t('provider-line-key-updated', { ref: 'ACME_GATEWAY_API_KEY' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 19. edit a custom route, base URL: a single-field path patch sets the new
// endpoint; the rest of the profile (models, unknown fields) never enters
// the write — there is no rebuild to drop them with.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_BASEURL,
    'baseurl': { custom: 'https://gw.example/v2' },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
    discovered: [{ id: 'acme-large', contextWindow: 131072, maxTokens: 8192 }],
    storedCredentials: { ACME_GATEWAY_API_KEY: 'sk-old' },
  })
  const outcome = await runProviderWizard(deps)
  check('19 edit baseURL: outcome updated', outcome === 'updated', outcome)
  check('19 edit baseURL: only the baseURL path is patched',
    eq(calls.mutations, [['acme-gateway', [{ op: 'set', path: ['baseURL'], value: 'https://gw.example/v2' }]]]),
    JSON.stringify(calls.mutations))
  check('19 edit baseURL: no whole-profile write, no discovery, no credential write',
    eq(calls.profiles, []) && eq(calls.credentials, []))
}

// 20. edit a custom route, wire protocol: the current protocol is
// default-focused (defaultSelected); the patch sets only `api`.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_PROTOCOL,
    'protocol': { selected: ['anthropic-messages'] },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
    discovered: [{ id: 'acme-large' }],
    storedCredentials: { ACME_GATEWAY_API_KEY: 'sk-old' },
  })
  const outcome = await runProviderWizard(deps)
  check('20 edit protocol: outcome updated', outcome === 'updated', outcome)
  check('20 edit protocol: current protocol is the default selection',
    eq(calls.defaults.protocol, ['openai-completions']), JSON.stringify(calls.defaults.protocol))
  check('20 edit protocol: only the api path is patched',
    eq(calls.mutations, [['acme-gateway', [{ op: 'set', path: ['api'], value: 'anthropic-messages' }]]]),
    JSON.stringify(calls.mutations))
}

// 21. edit a shadowed-key route: "Edit API Key" refuses (the env provides
// the key) → cancelled, nothing written.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_KEY,
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: true, isCatalog: true, models: ['deepseek-chat'] }],
    shadow: 'DEEPSEEK_API_KEY',
  })
  const outcome = await runProviderWizard(deps)
  check('21 edit shadow: outcome cancelled', outcome === 'cancelled', outcome)
  check('21 edit shadow: Edit API Key refused without asking for a key',
    !calls.asks.includes('apikey')
      && calls.notifications.some(n => n.color === 'warning' && n.text.includes('DEEPSEEK_API_KEY')),
    JSON.stringify(calls.notifications))
  check('21 edit shadow: nothing written',
    eq(calls.credentials, []) && eq(calls.profiles, []))
}

// 22. edit with no configured providers: warning, nothing asked, cancelled.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
  }, { configured: [] })
  const outcome = await runProviderWizard(deps)
  check('22 edit none: outcome cancelled', outcome === 'cancelled', outcome)
  check('22 edit none: warning notified',
    calls.notifications.some(n => n.color === 'warning' && n.text === t('provider-none-configured')),
    JSON.stringify(calls.notifications))
}

// 23. delete via the edit menu, stored key: profile removed, then the
// credential removed (after the post-unset reference re-check comes back
// empty), transcript notes both, outcome deleted. A non-reserved ref so the
// removal path is the one under test (33 covers the reserved namespace).
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [{ route: 'deepseek', ref: 'MY-ROUTE_KEY', shadowed: false, isCatalog: true, models: ['deepseek-chat'] }],
  })
  const outcome = await runProviderWizard(deps)
  check('23 delete: outcome deleted', outcome === 'deleted', outcome)
  check('23 delete: profile removed', eq(calls.removedProfiles, ['deepseek']), JSON.stringify(calls.removedProfiles))
  check('23 delete: credential removed', eq(calls.removed, ['MY-ROUTE_KEY']), JSON.stringify(calls.removed))
  check('23 delete: nothing written', eq(calls.profiles, []) && eq(calls.credentials, []))
  check('23 delete: success notified', calls.notifications.some(n => n.color === 'success'))
  check('23 delete: transcript notes the removed key',
    calls.pushed[0]?.lines.includes(t('provider-line-deleted-key', { ref: 'MY-ROUTE_KEY' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
  check('23 delete: confirm detail is a preview, not a success line',
    (calls.details['delete-confirm'] ?? '').includes(t('provider-line-route', { route: 'deepseek' }))
      && !(calls.details['delete-confirm'] ?? '').includes(t('provider-line-action-deleted', { route: 'deepseek' })),
    calls.details['delete-confirm'])
}

// 24. delete via the edit menu, env-shadowed key: profile removed, credential
// left alone, transcript says the key came from the environment.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: true, isCatalog: true, models: ['deepseek-chat'] }],
    shadow: 'DEEPSEEK_API_KEY',
  })
  const outcome = await runProviderWizard(deps)
  check('24 delete shadow: outcome deleted', outcome === 'deleted', outcome)
  check('24 delete shadow: profile removed', eq(calls.removedProfiles, ['deepseek']), JSON.stringify(calls.removedProfiles))
  check('24 delete shadow: credential NOT removed', eq(calls.removed, []), JSON.stringify(calls.removed))
  check('24 delete shadow: transcript notes the env keyref',
    calls.pushed[0]?.lines.includes(t('provider-line-deleted-key-shadowed', { ref: 'DEEPSEEK_API_KEY' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 25. delete cancelled at the confirm: nothing removed.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-confirm-cancel')] },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: false, isCatalog: true, models: ['deepseek-chat'] }],
  })
  const outcome = await runProviderWizard(deps)
  check('25 delete cancel: outcome cancelled', outcome === 'cancelled', outcome)
  check('25 delete cancel: nothing removed',
    eq(calls.removedProfiles, []) && eq(calls.removed, []))
}

// 26. a no-op base URL edit (empty input): nothing written, 'cancelled'.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_BASEURL,
    'baseurl': { custom: '' },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
  })
  const outcome = await runProviderWizard(deps)
  check('26 no-op baseURL: outcome cancelled', outcome === 'cancelled', outcome)
  check('26 no-op baseURL: no-changes notice notified',
    calls.notifications.some(n => n.text === t('provider-edit-no-changes')),
    JSON.stringify(calls.notifications))
  check('26 no-op baseURL: nothing written', eq(calls.profiles, []))
}

// 27. custom-route model-list edit that ends up empty is rejected — a manual
// route needs at least one model, nothing written.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_MODELS,
    'models': { selected: [] },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
    discovered: [{ id: 'acme-large' }],
  })
  const outcome = await runProviderWizard(deps)
  check('27 custom empty models: outcome cancelled', outcome === 'cancelled', outcome)
  check('27 custom empty models: required-models error notified',
    calls.notifications.some(n => n.color === 'error' && n.text === t('provider-models-required')),
    JSON.stringify(calls.notifications))
  check('27 custom empty models: nothing written',
    eq(calls.profiles, []) && eq(calls.credentials, []))
}

// 28. menu shape: built-in routes offer key/models/delete only; custom routes
// also offer base URL and wire protocol.
{
  const { deps: depsCatalog, calls: callsCatalog } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_KEY,
    'apikey': { custom: 'sk-x' },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: false, isCatalog: true, models: ['deepseek-chat'] }],
  })
  const outcomeCatalog = await runProviderWizard(depsCatalog)
  const catalogLabels = Object.keys(callsCatalog.optionDescriptions['edit-menu'] ?? {})
  check('28 menu shape: built-in route offers key/models/delete only',
    outcomeCatalog === 'updated'
      && eq(catalogLabels, [
        t('provider-opt-edit-key'),
        t('provider-opt-edit-models'),
        t('provider-opt-edit-delete'),
      ]),
    JSON.stringify(catalogLabels))

  const { deps: depsCustom, calls: callsCustom } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_KEY,
    'apikey': { custom: 'sk-x' },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
  })
  const outcomeCustom = await runProviderWizard(depsCustom)
  const customLabels = Object.keys(callsCustom.optionDescriptions['edit-menu'] ?? {})
  check('28 menu shape: custom route also offers base URL + wire protocol',
    outcomeCustom === 'updated'
      && eq(customLabels, [
        t('provider-opt-edit-key'),
        t('provider-opt-edit-baseurl'),
        t('provider-opt-edit-protocol'),
        t('provider-opt-edit-models'),
        t('provider-opt-edit-delete'),
      ]),
    JSON.stringify(customLabels))
}

// 29. a catalog route that explicitly overrides `api` stays catalog: the
// menu shape is membership-driven, not field-presence-driven (#3).
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['openai'] },
    'edit-menu': MENU_KEY,
    'apikey': { custom: 'sk-x' },
  }, {
    configured: [{ route: 'openai', ref: 'OPENAI_API_KEY', shadowed: false, isCatalog: true, api: 'openai-responses', models: ['gpt-1'] }],
  })
  const outcome = await runProviderWizard(deps)
  const labels = Object.keys(calls.optionDescriptions['edit-menu'] ?? {})
  check('29 catalog with api override: built-in menu shape kept',
    outcome === 'updated'
      && eq(labels, [
        t('provider-opt-edit-key'),
        t('provider-opt-edit-models'),
        t('provider-opt-edit-delete'),
      ]),
    JSON.stringify(labels))
}

// 30. delete with a failing credential cleanup: the profile unset landed,
// so the outcome is still 'deleted' (caller refreshes completions), the
// transcript says the key cleanup failed, and a warning names the ref (#2).
// Non-reserved ref: the removal path itself is under test here.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [{ route: 'deepseek', ref: 'MY-ROUTE_KEY', shadowed: false, isCatalog: true, models: ['deepseek-chat'] }],
    credentialRemoveThrows: true,
  })
  const outcome = await runProviderWizard(deps)
  check('30 delete key-cleanup failure: outcome deleted (catalog changed)',
    outcome === 'deleted', outcome)
  check('30 delete key-cleanup failure: profile removed', eq(calls.removedProfiles, ['deepseek']))
  check('30 delete key-cleanup failure: warning names the ref',
    calls.notifications.some(n => n.color === 'warning' && n.text.includes('MY-ROUTE_KEY')),
    JSON.stringify(calls.notifications))
  check('30 delete key-cleanup failure: transcript says the cleanup failed',
    calls.pushed[0]?.lines.includes(t('provider-line-deleted-key-cleanup-failed', { ref: 'MY-ROUTE_KEY' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
  check('30 delete key-cleanup failure: no error toast, catalog is consistent',
    !calls.notifications.some(n => n.color === 'error'))
}

// 30b. removeProfile itself failing: NOTHING changed → honest 'failed'.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: false, isCatalog: true, models: ['deepseek-chat'] }],
    removeProfileThrows: true,
  })
  const outcome = await runProviderWizard(deps)
  check('30b removeProfile failure: outcome failed', outcome === 'failed', outcome)
  check('30b removeProfile failure: credential untouched', eq(calls.removed, []))
  check('30b removeProfile failure: error notified',
    calls.notifications.some(n => n.color === 'error'))
}

// 31. delete of a route whose key ref is shared with another configured
// route: the key is kept (removing it would break the sibling), the confirm
// detail warns up front and the transcript records the decision (#5).
// Non-reserved ref: the shared branch is under test (33 covers reserved).
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [
      { route: 'acme-gateway', ref: 'ACME_SHARED_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] },
      { route: 'acme-clone', ref: 'ACME_SHARED_KEY', shadowed: false, isCatalog: false, baseURL: 'https://clone.example/v1', api: 'openai-completions', models: ['acme-large'] },
    ],
  })
  const outcome = await runProviderWizard(deps)
  check('31 delete shared key: outcome deleted', outcome === 'deleted', outcome)
  check('31 delete shared key: profile removed, credential kept',
    eq(calls.removedProfiles, ['acme-gateway']) && eq(calls.removed, []),
    JSON.stringify(calls.removed))
  check('31 delete shared key: confirm detail warns about the shared ref',
    (calls.details['delete-confirm'] ?? '').includes('acme-clone'),
    calls.details['delete-confirm'])
  check('31 delete shared key: transcript notes the kept key',
    calls.pushed[0]?.lines.includes(t('provider-line-deleted-key-shared', { ref: 'ACME_SHARED_KEY', routes: 'acme-clone' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 32. a model-list rewrite reuses stored entries verbatim for kept ids, so
// per-model fields the wizard does not model survive; new ids are built
// from the discovery rows (#1).
{
  const storedEntry = { id: 'acme-large', contextWindow: 4096, input: ['text'], compat: { tier: 'pro' } }
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_MODELS,
    'models': { selected: ['acme-large', 'acme-small'] },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'], modelEntries: [storedEntry] }],
    discovered: [
      { id: 'acme-large', contextWindow: 131072, maxTokens: 8192 },
      { id: 'acme-small', contextWindow: 2048 },
    ],
  })
  const outcome = await runProviderWizard(deps)
  check('32 edit models: outcome updated', outcome === 'updated', outcome)
  const mutations = calls.mutations
  check('32 edit models: one set op on models, nothing else',
    mutations.length === 1 && mutations[0][0] === 'acme-gateway'
      && mutations[0][1].length === 1 && mutations[0][1][0].op === 'set'
      && eq(mutations[0][1][0].path, ['models']),
    JSON.stringify(mutations))
  check('32 edit models: kept model reuses the stored entry verbatim (unknown fields survive)',
    eq(mutations[0][1][0].value[0], storedEntry), JSON.stringify(mutations[0][1][0].value))
  check('32 edit models: newly enabled model is built from the discovery row',
    eq(mutations[0][1][0].value[1], { id: 'acme-small', contextWindow: 2048 }),
    JSON.stringify(mutations[0][1][0].value[1]))
}

// 33. delete of a route whose ref is host-reserved (DEEPSEEK_API_KEY): the
// credential is NEVER removed even though the user layer shows no other
// user — the harness itself resolves this ref. Transcript says reserved.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: false, isCatalog: true, models: ['deepseek-chat'] }],
  })
  const outcome = await runProviderWizard(deps)
  check('33 delete reserved ref: outcome deleted', outcome === 'deleted', outcome)
  check('33 delete reserved ref: profile removed, credential kept',
    eq(calls.removedProfiles, ['deepseek']) && eq(calls.removed, []),
    JSON.stringify(calls.removed))
  check('33 delete reserved ref: transcript notes the reserved key',
    calls.pushed[0]?.lines.includes(t('provider-line-deleted-key-reserved', { ref: 'DEEPSEEK_API_KEY' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 33b. delete of a route whose ref is consumed by a BASE-layer profile the
// editable user-layer list never shows: the all-layer census keeps the key
// even though no OTHER CONFIGURED ROUTE names the ref.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['my-gateway'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [{ route: 'my-gateway', ref: 'GATEWAY_SHARED_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['m1'] }],
    // Base-inherited consumer, invisible to listConfiguredProviders.
    refUsers: { GATEWAY_SHARED_KEY: ['deepseek'] },
  })
  const outcome = await runProviderWizard(deps)
  check('33b delete with hidden base consumer: outcome deleted', outcome === 'deleted', outcome)
  check('33b delete with hidden base consumer: credential kept', eq(calls.removed, []),
    JSON.stringify(calls.removed))
  check('33b delete with hidden base consumer: transcript names the base route',
    calls.pushed[0]?.lines.includes(t('provider-line-deleted-key-shared', { ref: 'GATEWAY_SHARED_KEY', routes: 'deepseek' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 33c. the reference RE-CHECK runs after the profile unset: the pre-confirm
// census saw no sharer, but the merged section still names consumers when
// removal time comes (e.g. the unset re-inherited a base profile) — the key
// is kept.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['my-gateway'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [{ route: 'my-gateway', ref: 'GATEWAY_SHARED_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['m1'] }],
  })
  const base = deps.host.listRefUsers
  deps.host.listRefUsers = (ref, exceptRoute) => {
    // First call: pre-confirm census — empty. Second: post-unset re-check —
    // a consumer appeared in the merged section meanwhile.
    const users = exceptRoute === undefined ? ['deepseek'] : base(ref, exceptRoute)
    return users
  }
  const outcome = await runProviderWizard(deps)
  check('33c post-unset recheck finds a consumer: credential kept',
    outcome === 'deleted' && eq(calls.removed, []), JSON.stringify(calls.removed))
  check('33c post-unset recheck finds a consumer: transcript notes shared key',
    calls.pushed[0]?.lines.includes(t('provider-line-deleted-key-shared', { ref: 'GATEWAY_SHARED_KEY', routes: 'deepseek' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 33d. the post-unset re-check itself throws: fail closed — the key is kept
// with an unknown-users note (an unremovable key is recoverable, a
// destroyed one is not).
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['my-gateway'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [{ route: 'my-gateway', ref: 'GATEWAY_SHARED_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['m1'] }],
    refUsersThrows: true,
  })
  const outcome = await runProviderWizard(deps)
  check('33d ref query failure: outcome deleted, credential kept',
    outcome === 'deleted' && eq(calls.removed, []), JSON.stringify(calls.removed))
  check('33d ref query failure: transcript notes the kept key',
    calls.pushed[0]?.lines.includes(t('provider-line-deleted-key-shared',
      { ref: 'GATEWAY_SHARED_KEY', routes: t('provider-unknown-ref-users') })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 34. edit the API key of a route whose ref is shared: the write is gated
// by an explicit overwrite confirm naming the other users; cancelling the
// confirm writes nothing.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_KEY,
    'apikey': { custom: 'sk-new' },
    'key-overwrite-confirm': { selected: [t('provider-opt-confirm-cancel')] },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
    storedCredentials: { ACME_GATEWAY_API_KEY: 'sk-old' },
    refUsers: { ACME_GATEWAY_API_KEY: ['acme-clone'] },
  })
  const outcome = await runProviderWizard(deps)
  check('34 edit shared key declined: outcome cancelled', outcome === 'cancelled', outcome)
  check('34 edit shared key declined: credential untouched', eq(calls.credentials, []),
    JSON.stringify(calls.credentials))
  check('34 edit shared key declined: confirm names the other user',
    (calls.details['key-overwrite-confirm'] ?? '').includes('acme-clone'),
    calls.details['key-overwrite-confirm'])
}

// 34b. same, confirming the overwrite: the shared credential is written.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_KEY,
    'apikey': { custom: 'sk-new' },
    'key-overwrite-confirm': { selected: [t('provider-opt-key-overwrite-yes')] },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
    storedCredentials: { ACME_GATEWAY_API_KEY: 'sk-old' },
    refUsers: { ACME_GATEWAY_API_KEY: ['acme-clone'] },
  })
  const outcome = await runProviderWizard(deps)
  check('34b edit shared key confirmed: credential overwritten',
    outcome === 'updated' && eq(calls.credentials, [['ACME_GATEWAY_API_KEY', 'sk-new']]),
    JSON.stringify(calls.credentials))
}

// 34c. an unshared ref edits straight through: no confirm question at all.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_KEY,
    'apikey': { custom: 'sk-new' },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
    storedCredentials: { ACME_GATEWAY_API_KEY: 'sk-old' },
  })
  const outcome = await runProviderWizard(deps)
  check('34c edit unshared key: no overwrite confirm asked',
    outcome === 'updated' && !calls.asks.includes('key-overwrite-confirm'),
    JSON.stringify(calls.asks))
}

// 35. a model-list edit where discovery drops an existing model: the stored
// model still appears in the panel (marked not-found, pre-checked) so an
// Enter-through confirm cannot silently delete it; explicit un-check of the
// others keeps it.
{
  const storedMissing = { id: 'acme-legacy', contextWindow: 4096, compat: { tier: 'legacy' } }
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_MODELS,
    'models': { selected: ['acme-large', 'acme-legacy', 'acme-new'] },
  }, {
    configured: [{
      route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false,
      baseURL: 'https://gw.example/v1', api: 'openai-completions',
      models: ['acme-large', 'acme-legacy'], modelEntries: [{ id: 'acme-large' }, storedMissing],
    }],
    discovered: [{ id: 'acme-large' }, { id: 'acme-new' }],
    storedCredentials: { ACME_GATEWAY_API_KEY: 'sk-old' },
  })
  const outcome = await runProviderWizard(deps)
  check('35 edit models: undiscovered stored model stays in the option list',
    calls.optionDescriptions.models?.['acme-legacy'] === t('provider-row-model-missing'),
    JSON.stringify(calls.optionDescriptions.models))
  check('35 edit models: outcome updated', outcome === 'updated', outcome)
  const value = calls.mutations[0][1][0].value
  check('35 edit models: kept-but-undiscovered model is preserved verbatim',
    eq(value[1], storedMissing), JSON.stringify(value))
}

// 28b. single-field custom-route patch shape: editing baseURL addresses
// exactly one path — the rest of the stored object never enters the op list.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_BASEURL,
    'baseurl': { custom: 'https://gw.example/v9' },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
  })
  await runProviderWizard(deps)
  const op = calls.mutations[0][1][0]
  check('28b patch shape: single op, path is exactly [baseURL]',
    calls.mutations[0][1].length === 1 && eq(op.path, ['baseURL']) && op.op === 'set',
    JSON.stringify(calls.mutations))
}

// 34. a catalog route with a stored baseURL is discovered twice (catalog +
// live probe with no `provider` field), merged with live-only ids tagged,
// and the write gives endpoint-only ids their disclosed capacities.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_MODELS,
    'models': { selected: ['deepseek-chat', 'deepseek-v2-alpha'] },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: false, isCatalog: true, baseURL: 'https://relay.example/v1', models: ['deepseek-chat'], modelEntries: [{ id: 'deepseek-chat' }] }],
    storedCredentials: { DEEPSEEK_API_KEY: 'sk-old' },
    discover: request => request.provider !== undefined
      ? [{ id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 1000000 }]
      : [{ id: 'deepseek-chat' }, { id: 'deepseek-v2-alpha', contextWindow: 2000000, maxTokens: 65536 }],
  })
  const outcome = await runProviderWizard(deps)
  check('34 catalog+baseURL: outcome updated', outcome === 'updated', outcome)
  check('34 catalog+baseURL: catalog request then live request (no provider field)',
    eq(calls.discoverRequests, [
      { provider: 'deepseek' },
      { baseURL: 'https://relay.example/v1', api: 'openai-completions', apiKey: 'sk-old' },
    ]), JSON.stringify(calls.discoverRequests))
  check('34 catalog+baseURL: merged rows, catalog first, live-only appended',
    eq(Object.keys(calls.optionDescriptions.models ?? {}), ['deepseek-chat', 'deepseek-v2-alpha']),
    JSON.stringify(Object.keys(calls.optionDescriptions.models ?? {})))
  check('34 catalog+baseURL: live-only row tagged new on endpoint',
    (calls.optionDescriptions.models?.['deepseek-v2-alpha'] ?? '').includes(t('provider-row-model-new')),
    JSON.stringify(calls.optionDescriptions.models))
  check('34 catalog+baseURL: catalog row keeps catalog metadata with compact capacity',
    calls.optionDescriptions.models?.['deepseek-chat'] === 'DeepSeek Chat · 1M',
    JSON.stringify(calls.optionDescriptions.models))
  check('34 catalog+baseURL: endpoint-only id carries disclosed capacities, catalog id stays plain',
    eq(calls.mutations, [['deepseek', [{ op: 'set', path: ['models'], value: [
      { id: 'deepseek-chat' },
      { id: 'deepseek-v2-alpha', contextWindow: 2000000, maxTokens: 65536 },
    ] }]]]),
    JSON.stringify(calls.mutations))
  check('34 catalog+baseURL: summary leads with the models-updated action line',
    calls.pushed[0]?.lines[0] === t('provider-line-action-updated-models', { route: 'deepseek' }),
    JSON.stringify(calls.pushed[0]?.lines))
  check('34 catalog+baseURL: models line carries the added delta',
    calls.pushed[0]?.lines.some(line => line.includes(t('provider-models-delta-added', { n: 1 }))),
    JSON.stringify(calls.pushed[0]?.lines))
}

// 35. a catalog route without a baseURL stays on the installed catalog:
// one discovery request, no credential resolution, snapshot note in detail.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_MODELS,
    'models': { selected: ['deepseek-chat', 'deepseek-reasoner'] },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: false, isCatalog: true, models: ['deepseek-chat'], modelEntries: [{ id: 'deepseek-chat' }] }],
    storedCredentials: { DEEPSEEK_API_KEY: 'sk-old' },
    discover: request => request.provider !== undefined
      ? [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }]
      : [],
  })
  const outcome = await runProviderWizard(deps)
  check('35 catalog no baseURL: outcome updated', outcome === 'updated', outcome)
  check('35 catalog no baseURL: exactly one catalog discovery request, no live probe',
    eq(calls.discoverRequests, [{ provider: 'deepseek' }]),
    JSON.stringify(calls.discoverRequests))
  check('35 catalog no baseURL: credential never resolved for a catalog-only listing',
    !calls.asks.includes('apikey')
      && calls.discoverRequests.every(request => request.apiKey === undefined),
    JSON.stringify(calls.discoverRequests))
  check('35 catalog no baseURL: models question notes the catalog snapshot origin',
    calls.details.models === t('provider-catalog-snapshot-note', { n: 2 }),
    JSON.stringify(calls.details.models))
}

// 36. a failing live probe on a catalog+baseURL route degrades to the
// catalog rows with a warning — the manual-id fallback stays reserved for
// a total discovery failure.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_MODELS,
    'models': { selected: ['deepseek-chat'] },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: false, isCatalog: true, baseURL: 'https://relay.example/v1', models: [] }],
    storedCredentials: { DEEPSEEK_API_KEY: 'sk-old' },
    discover: request => {
      if (request.provider !== undefined) return [{ id: 'deepseek-chat' }]
      throw new Error('connection refused')
    },
  })
  const outcome = await runProviderWizard(deps)
  check('36 live probe failure: outcome updated from catalog rows', outcome === 'updated', outcome)
  check('36 live probe failure: warning says the live fetch failed',
    calls.notifications.some(n => n.color === 'warning' && n.text === t('provider-live-fetch-failed')),
    JSON.stringify(calls.notifications))
  check('36 live probe failure: no manual-id fallback asked',
    !calls.asks.includes('models-fallback'), JSON.stringify(calls.asks))
  check('36 live probe failure: catalog rows still selectable',
    Object.keys(calls.optionDescriptions.models ?? {}).includes('deepseek-chat'),
    JSON.stringify(calls.optionDescriptions.models))
}

// 37. a custom route whose key cannot be resolved probes anonymously: the
// request OMITS apiKey (an empty string is a hard invalid-credential
// upstream, an absent field is an unauthenticated probe).
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_MODELS,
    'models': { selected: ['acme-large'] },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: [] }],
    discover: () => [{ id: 'acme-large' }],
  })
  const outcome = await runProviderWizard(deps)
  check('37 no resolvable key: outcome updated', outcome === 'updated', outcome)
  check('37 no resolvable key: single live request omits apiKey entirely',
    eq(calls.discoverRequests, [{ baseURL: 'https://gw.example/v1', api: 'openai-completions' }]),
    JSON.stringify(calls.discoverRequests))
}

// 38. the add flow on a catalog route with a typed baseURL merges catalog
// and live listings; the written profile carries capacities only for the
// endpoint-only id.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': { selected: ['deepseek'] },
    'baseurl-choice': { selected: [t('provider-opt-baseurl-input')] },
    'baseurl': { custom: 'https://relay.example/v1' },
    'apikey': { custom: 'sk-new' },
    'models': { selected: ['deepseek-chat', 'deepseek-v2-alpha'] },
    'confirm': CONFIRM_WRITE,
    'switch': KEEP_MODEL,
  }, {
    discover: request => request.provider !== undefined
      ? [{ id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 1000000 }]
      : [{ id: 'deepseek-chat' }, { id: 'deepseek-v2-alpha', contextWindow: 2000000 }],
  })
  const outcome = await runProviderWizard(deps)
  check('38 add catalog+baseURL: outcome added', outcome === 'added', outcome)
  check('38 add catalog+baseURL: catalog request then live request carrying the typed key',
    eq(calls.discoverRequests, [
      { provider: 'deepseek' },
      { baseURL: 'https://relay.example/v1', api: 'openai-completions', apiKey: 'sk-new' },
    ]), JSON.stringify(calls.discoverRequests))
  check('38 add catalog+baseURL: profile narrows models, endpoint-only id carries capacities',
    eq(calls.profiles, [['deepseek', {
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseURL: 'https://relay.example/v1',
      models: [
        { id: 'deepseek-chat' },
        { id: 'deepseek-v2-alpha', contextWindow: 2000000 },
      ],
    }]]),
    JSON.stringify(calls.profiles))
  check('38 add catalog+baseURL: live-only row tagged new on endpoint',
    (calls.optionDescriptions.models?.['deepseek-v2-alpha'] ?? '').includes(t('provider-row-model-new')),
    JSON.stringify(calls.optionDescriptions.models))
}

// 39. A mixed-protocol catalog (for example openrouter) has no safe protocol
// for an unnamed live probe. Keep the installed catalog, do not accept a
// free-typed endpoint-only id, and do not attach endpoint capacities.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['openrouter'] },
    'edit-menu': MENU_MODELS,
    'models': { selected: ['or-known'], custom: 'or-online-only' },
  }, {
    configured: [{ route: 'openrouter', ref: 'OPENROUTER_API_KEY', shadowed: false, isCatalog: true, baseURL: 'https://openrouter.example/v1', models: [] }],
    storedCredentials: { OPENROUTER_API_KEY: 'sk-old' },
    discover: request => request.provider !== undefined
      ? [{ id: 'or-known', contextWindow: 1000000 }]
      : [{ id: 'or-online-only', contextWindow: 2000000 }],
  })
  const outcome = await runProviderWizard(deps)
  check('39 mixed catalog: outcome updated from snapshot', outcome === 'updated', outcome)
  check('39 mixed catalog: live probe is skipped without a known protocol',
    eq(calls.discoverRequests, [{ provider: 'openrouter' }]),
    JSON.stringify(calls.discoverRequests))
  check('39 mixed catalog: explicit warning explains the fallback',
    calls.notifications.some(n => n.color === 'warning' && n.text === t('provider-live-fetch-unavailable')),
    JSON.stringify(calls.notifications))
  check('39 mixed catalog: endpoint-only custom id is not written',
    eq(calls.mutations, [['openrouter', [{ op: 'set', path: ['models'], value: [{ id: 'or-known' }] }]]]),
    JSON.stringify(calls.mutations))
}

// 40. A catalog route with custom headers cannot safely use the anonymous
// live-discovery request because the upstream seam cannot carry those headers.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_MODELS,
    'models': { selected: ['deepseek-chat'] },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: false, isCatalog: true, baseURL: 'https://relay.example/v1', hasCustomHeaders: true, models: [] }],
    storedCredentials: { DEEPSEEK_API_KEY: 'sk-old' },
    discover: request => request.provider !== undefined
      ? [{ id: 'deepseek-chat' }]
      : [{ id: 'deepseek-v2-alpha', contextWindow: 2000000 }],
  })
  const outcome = await runProviderWizard(deps)
  check('40 custom headers: outcome updated from snapshot', outcome === 'updated', outcome)
  check('40 custom headers: live probe is skipped',
    eq(calls.discoverRequests, [{ provider: 'deepseek' }]),
    JSON.stringify(calls.discoverRequests))
  check('40 custom headers: warning explains the fallback',
    calls.notifications.some(n => n.color === 'warning' && n.text === t('provider-live-fetch-unavailable')),
    JSON.stringify(calls.notifications))
}

// 41. If the installed catalog lookup fails but the endpoint responds, keep
// the live rows selectable while treating catalog membership as unknown:
// no "new" badge and no endpoint capacities are persisted.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['openai'] },
    'edit-menu': MENU_MODELS,
    'models': { selected: ['gpt-live-only'] },
  }, {
    configured: [{ route: 'openai', ref: 'OPENAI_API_KEY', shadowed: false, isCatalog: true, baseURL: 'https://relay.example/v1', models: [] }],
    storedCredentials: { OPENAI_API_KEY: 'sk-old' },
    discover: request => request.provider !== undefined
      ? Promise.reject(new Error('catalog unavailable'))
      : [{ id: 'gpt-live-only', contextWindow: 2000000, maxTokens: 65536 }],
  })
  const outcome = await runProviderWizard(deps)
  check('41 catalog lookup failure: outcome updated from live rows', outcome === 'updated', outcome)
  check('41 catalog lookup failure: live probe carries explicit known protocol',
    eq(calls.discoverRequests, [
      { provider: 'openai' },
      { baseURL: 'https://relay.example/v1', api: 'openai-responses', apiKey: 'sk-old' },
    ]), JSON.stringify(calls.discoverRequests))
  check('41 catalog lookup failure: warning and no false snapshot detail',
    calls.notifications.some(n => n.color === 'warning' && n.text === t('provider-catalog-fetch-failed'))
      && calls.details.models === undefined,
    JSON.stringify({ notifications: calls.notifications, detail: calls.details.models }))
  check('41 catalog lookup failure: unknown membership does not persist capacities',
    eq(calls.mutations, [['openai', [{ op: 'set', path: ['models'], value: [{ id: 'gpt-live-only' }] }]]]),
    JSON.stringify(calls.mutations))
}

// 42. Anthropic is one of the explicitly verified catalog protocols: the
// live probe must carry anthropic-messages so the upstream adapter uses
// x-api-key/anthropic-version rather than the OpenAI bearer default.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['anthropic'] },
    'edit-menu': MENU_MODELS,
    'models': { selected: ['claude-live-only'] },
  }, {
    configured: [{ route: 'anthropic', ref: 'ANTHROPIC_API_KEY', shadowed: false, isCatalog: true, baseURL: 'https://relay.example', models: [] }],
    storedCredentials: { ANTHROPIC_API_KEY: 'sk-ant' },
    discover: request => request.provider !== undefined
      ? [{ id: 'claude-known' }]
      : [{ id: 'claude-live-only', contextWindow: 2000000 }],
  })
  const outcome = await runProviderWizard(deps)
  check('42 anthropic catalog: outcome updated', outcome === 'updated', outcome)
  check('42 anthropic catalog: live probe carries anthropic-messages',
    eq(calls.discoverRequests, [
      { provider: 'anthropic' },
      { baseURL: 'https://relay.example', api: 'anthropic-messages', apiKey: 'sk-ant' },
    ]), JSON.stringify(calls.discoverRequests))
}

// 43. Add adopts explicit capability edits, but not edits to unchecked models.
const CAPABILITIES = {
  contextWindow: 200000,
  maxTokens: 8192,
  reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'ultra' },
  input: ['text', 'image'],
}
const CUSTOM_ADD = {
  mode: MODE_CUSTOM,
  'route-id': { custom: 'capability-gateway' },
  apikey: { custom: 'probe-key' },
  baseurl: { custom: 'https://gateway.example/v1' },
  protocol: { selected: ['openai-completions'] },
  confirm: CONFIRM_WRITE,
  switch: KEEP_MODEL,
}
{
  const { deps, calls } = makeDeps({
    ...CUSTOM_ADD,
    models: { selected: ['chosen'], edits: { chosen: CAPABILITIES, unchecked: { contextWindow: 1000 } } },
  }, { discovered: [{ id: 'chosen', contextWindow: 4000 }, { id: 'unchecked' }] })
  check('43 add capabilities: outcome added', await runProviderWizard(deps) === 'added')
  check('43 add capabilities: only enabled model adopts the four fields',
    eq(calls.profiles[0]?.[1]?.models, [{ id: 'chosen', ...CAPABILITIES }]), JSON.stringify(calls.profiles))
  check('43 add capabilities: confirm names capability overrides',
    calls.details.confirm.includes(t('provider-line-model-capabilities', { models: 'chosen' })))
}

const STORED_CAPABILITY_MODEL = {
  id: 'chosen', contextWindow: 4000, maxTokens: 1000,
  reasoningEfforts: { high: 'gateway-high' }, input: ['text'],
  name: 'My model', compat: { supportsDeveloperRole: false }, customNote: 'preserve',
}
const CAPABILITY_PROVIDER = {
  route: 'capability-gateway', ref: '', shadowed: false, isCatalog: false,
  api: 'openai-completions', baseURL: 'https://gateway.example/v1',
  models: ['chosen'], modelEntries: [STORED_CAPABILITY_MODEL],
}
const CUSTOM_EDIT = {
  action: ACTION_EDIT,
  'edit-provider': { selected: ['capability-gateway'] },
  'edit-menu': MENU_MODELS,
}

// 44. Same enabled ids no longer hide a real capability edit.
{
  const { deps, calls } = makeDeps({
    ...CUSTOM_EDIT,
    models: { selected: ['chosen'], edits: { chosen: CAPABILITIES } },
  }, { configured: [CAPABILITY_PROVIDER], discovered: [{ id: 'chosen', contextWindow: 800000 }] })
  check('44 edit capabilities: outcome updated despite identical ids', await runProviderWizard(deps) === 'updated')
  check('44 edit capabilities: unknown fields survive, only models path is patched', eq(calls.mutations, [[
    'capability-gateway', [{ op: 'set', path: ['models'], value: [{ ...STORED_CAPABILITY_MODEL, ...CAPABILITIES }] }],
  ]]), JSON.stringify(calls.mutations))
  check('44 edit capabilities: stored entry was not mutated', STORED_CAPABILITY_MODEL.contextWindow === 4000)
}

// 45. Editor saves are drafts, so Esc or cancelling add confirmation writes nothing.
for (const cancelAfterEdits of [true, false]) {
  const { deps, calls } = makeDeps({
    ...CUSTOM_ADD,
    models: { selected: ['chosen'], edits: { chosen: CAPABILITIES }, cancelAfterEdits },
    confirm: { selected: [t('provider-opt-confirm-cancel')] },
  }, { discovered: [{ id: 'chosen' }] })
  check(`45 cancel capability draft (${cancelAfterEdits}): cancelled`, await runProviderWizard(deps) === 'cancelled')
  check(`45 cancel capability draft (${cancelAfterEdits}): zero writes`,
    calls.profiles.length === 0 && calls.mutations.length === 0 && calls.credentials.length === 0)
}

// 46. Editing an unchecked row must neither enable it nor rewrite kept rows.
{
  const { deps, calls } = makeDeps({
    ...CUSTOM_EDIT,
    models: { selected: ['chosen'], edits: { unchecked: CAPABILITIES } },
  }, { configured: [CAPABILITY_PROVIDER], discovered: [{ id: 'chosen' }, { id: 'unchecked' }] })
  check('46 unchecked edit: unchanged provider', await runProviderWizard(deps) === 'cancelled' && calls.mutations.length === 0)
}

// 47. Editing a whole-catalog route uses modelOverrides, never a one-model list.
{
  const { deps, calls } = makeDeps({
    action: ACTION_EDIT,
    'edit-provider': { selected: ['openai'] },
    'edit-menu': MENU_MODELS,
    models: { selected: [], edits: { known: { contextWindow: 200000 } } },
  }, {
    configured: [{ route: 'openai', ref: '', shadowed: false, isCatalog: true,
      modelOverrides: { known: { contextWindow: 4000, compat: { supportsDeveloperRole: false } } } }],
    discovered: [{ id: 'known', contextWindow: 1000000 }, { id: 'other' }],
  })
  check('47 whole-catalog capability edit: updated', await runProviderWizard(deps) === 'updated')
  check('47 whole-catalog capability edit: exact field patch, no catalog narrowing', eq(calls.mutations, [[
    'openai', [{ op: 'set', path: ['modelOverrides', 'known', 'contextWindow'], value: 200000 }],
  ]]), JSON.stringify(calls.mutations))
}

// 48. Explicit model lists absorb existing overrides before clearing their alternate shape.
{
  const override = { contextWindow: 4000, reasoningEfforts: { high: 'high' }, compat: { supportsDeveloperRole: false } }
  const { deps, calls } = makeDeps({
    action: ACTION_EDIT,
    'edit-provider': { selected: ['openai'] },
    'edit-menu': MENU_MODELS,
    models: { selected: ['known', 'other'], edits: { known: { maxTokens: 8192 } } },
  }, {
    configured: [{ route: 'openai', ref: '', shadowed: false, isCatalog: true, modelOverrides: { known: override } }],
    discovered: [{ id: 'known' }, { id: 'other' }],
  })
  check('48 modelOverrides migration: updated', await runProviderWizard(deps) === 'updated')
  check('48 modelOverrides migration: preserves fields and avoids upstream conflict', eq(calls.mutations, [[
    'openai', [
      { op: 'set', path: ['models'], value: [{ id: 'known', ...override, maxTokens: 8192 }, { id: 'other' }] },
      { op: 'unset', path: ['modelOverrides'] },
    ],
  ]]), JSON.stringify(calls.mutations))
}

// 49. Stored model rows remain editable when the endpoint is down.
{
  const { deps, calls } = makeDeps({
    ...CUSTOM_EDIT,
    models: { selected: ['chosen'], edits: { chosen: { contextWindow: 200000 } } },
  }, { configured: [CAPABILITY_PROVIDER], discoverThrows: true })
  check('49 offline capability edit: updated', await runProviderWizard(deps) === 'updated')
  check('49 offline capability edit: no manual fallback, original other fields retained',
    !calls.asks.includes('models-fallback') && eq(calls.mutations[0]?.[1]?.[0]?.value,
      [{ ...STORED_CAPABILITY_MODEL, contextWindow: 200000 }]))
}

// 50. Clearing overrides restores inheritance without touching unrelated fields.
{
  const { deps, calls } = makeDeps({
    ...CUSTOM_EDIT,
    models: { selected: ['chosen'], edits: { chosen: {
      contextWindow: undefined, maxTokens: undefined, reasoningEfforts: undefined, input: undefined,
    } } },
  }, { configured: [CAPABILITY_PROVIDER], discovered: [{ id: 'chosen' }] })
  check('50 inheritance reset: updated', await runProviderWizard(deps) === 'updated')
  check('50 inheritance reset: removes only the four overrides', eq(calls.mutations[0]?.[1]?.[0]?.value,
    [{ id: 'chosen', name: 'My model', compat: { supportsDeveloperRole: false }, customNote: 'preserve' }]))
}

// 51. Invalid capability values never get through the draft save to persistence.
for (const invalid of [
  { contextWindow: 0 }, { maxTokens: 1.5 }, { maxTokens: Number.MAX_SAFE_INTEGER + 1 },
  { reasoningEfforts: { off: null } }, { reasoningEfforts: { high: null } }, { input: [] },
]) {
  const { deps, calls } = makeDeps({
    ...CUSTOM_EDIT, models: { selected: ['chosen'], edits: { chosen: invalid } },
  }, { configured: [CAPABILITY_PROVIDER], discovered: [{ id: 'chosen' }] })
  check(`51 invalid capability ${JSON.stringify(invalid)}: no write`,
    await runProviderWizard(deps) === 'failed' && calls.mutations.length === 0)
}

// 52. Opening and saving unchanged values does not rewrite a provider.
{
  const { deps, calls } = makeDeps({
    ...CUSTOM_EDIT, models: { selected: ['chosen'], edits: { chosen: {} } },
  }, { configured: [CAPABILITY_PROVIDER], discovered: [{ id: 'chosen', contextWindow: 800000 }] })
  check('52 no-op capability save: zero writes', await runProviderWizard(deps) === 'cancelled' && calls.mutations.length === 0)
}

// 43. Managing official models: only the vendor's extra ids are selectable
// (the catalog route cannot carry them), nothing is pre-checked on a first
// pass, and the write carries exactly what the user ticked — enriched with the
// vendor catalog's name, capacities, modalities and thinking tiers.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_SYNC,
    'sync-models': { selected: ['longcat-2.5-preview-free'] },
  }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [{ route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] }],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : [{ id: 'glm-5.3' }, { id: 'grok-4.5' }, { id: 'longcat-2.5-preview-free' }],
  })
  const outcome = await runProviderWizard(deps)
  check('43 manage: outcome synced', outcome === 'synced', outcome)
  check('43 manage: one candidate skips the route question', !calls.asks.includes('sync-route'), JSON.stringify(calls.asks))
  check('43 manage: probes the installed catalog, then the vendor listing',
    eq(calls.discoverRequests, [
      { provider: 'opencode-go' },
      { baseURL: 'https://opencode.ai/zen/go/v1', api: 'openai-completions', apiKey: 'sk-zen' },
    ]), JSON.stringify(calls.discoverRequests))
  check('43 manage: only vendor-only ids are rows, nothing pre-checked',
    eq(Object.keys(calls.optionDescriptions['sync-models'] ?? {}).sort(), ['grok-4.5', 'longcat-2.5-preview-free'])
      && eq(calls.defaults['sync-models'], []),
    JSON.stringify({ rows: Object.keys(calls.optionDescriptions['sync-models'] ?? {}), defaults: calls.defaults['sync-models'] }))
  check('43 manage: rows describe the catalog metadata (name, capacities, modalities, tiers)',
    calls.optionDescriptions['sync-models']?.['longcat-2.5-preview-free']
      === [
        'LongCat 2.5 Preview Free',
        t('provider-row-meta-ctx', { value: '1M' }),
        t('provider-row-meta-out', { value: '128k' }),
        t('provider-row-meta-input', { value: 'text+image' }),
        t('provider-row-meta-effort', { value: 'off/high' }),
      ].join(' · ')
      && calls.optionDescriptions['sync-models']?.['grok-4.5']
        === [
          'Grok 4.5',
          t('provider-row-meta-ctx', { value: '500k' }),
          t('provider-row-meta-out', { value: '500k' }),
          t('provider-row-meta-input', { value: 'text+image' }),
          t('provider-row-meta-effort', { value: 'low/medium/high' }),
        ].join(' · '),
    JSON.stringify(calls.optionDescriptions['sync-models']))
  check('43 manage: the detail counts enabled versus un-enabled',
    calls.details['sync-models'] === t('provider-sync-detail', {
      total: 2,
      enabled: 0,
      unenabled: 2,
      derived: 'opencode-go-live, opencode-go-live-anthropic',
    }), JSON.stringify(calls.details['sync-models']))
  const written = calls.mutations[0]?.[1]?.[0]?.value ?? []
  check('43 manage: the derived route enables exactly the ticked id, enriched',
    calls.mutations.length === 1 && calls.mutations[0]?.[0] === 'opencode-go-live'
      && written.length === 1 && written[0].id === 'longcat-2.5-preview-free'
      && written[0].name === 'LongCat 2.5 Preview Free'
      && written[0].contextWindow === 1000000
      && written[0].maxTokens === 131072
      && eq(written[0].input, ['text', 'image'])
      && eq(written[0].reasoningEfforts, { off: 'none', high: 'high' }),
    JSON.stringify(calls.mutations))
  check('43 manage: the route identity rides the same write',
    eq(calls.mutations[0]?.[1]?.slice(1, 5), [
      { op: 'set', path: ['api'], value: 'openai-completions' },
      { op: 'set', path: ['baseURL'], value: 'https://opencode.ai/zen/go/v1' },
      { op: 'set', path: ['apiKeyEnv'], value: 'OPENCODE_GO_API_KEY' },
      { op: 'set', path: ['displayName'], value: 'OpenCode Go (live)' },
    ]), JSON.stringify(calls.mutations[0]?.[1]))
  check('43 manage: the vendor routing header is generated for the declared route',
    UUID.test(sessionHeaderOp(calls.mutations[0]?.[1])?.value?.['x-opencode-session'] ?? ''),
    JSON.stringify(sessionHeaderOp(calls.mutations[0]?.[1])))
  check('43 manage: the catalog route profile is untouched',
    calls.profiles.length === 0 && calls.credentials.length === 0,
    JSON.stringify({ profiles: calls.profiles, credentials: calls.credentials }))
  check('43 manage: transcript reports the enabled set',
    calls.pushed.some(entry => entry.title === '/provider'
      && entry.lines[0] === t('provider-sync-transcript-route', { route: 'opencode-go', derived: 'opencode-go-live, opencode-go-live-anthropic' })
      && entry.lines[1].includes('longcat-2.5-preview-free')),
    JSON.stringify(calls.pushed))
  check('43 manage: success toast counts the enabled set',
    calls.notifications.some(n => n.color === 'success'
      && n.text === t('provider-sync-success', {
        route: 'opencode-go',
        derived: 'opencode-go-live, opencode-go-live-anthropic',
        n: 1,
        added: 1,
        removed: 0,
      })),
    JSON.stringify(calls.notifications))
}

// 43b. Without the vendor catalog (models.dev unreachable) the same pass still
// works: rows say so, entries stay bare, and the user is told.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_SYNC,
    'sync-models': { selected: ['longcat-2.5-preview-free'] },
  }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [{ route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] }],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    vendorCatalog: null,
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : [{ id: 'glm-5.3' }, { id: 'longcat-2.5-preview-free' }],
  })
  const outcome = await runProviderWizard(deps)
  const written = calls.mutations[0]?.[1]?.[0]?.value ?? []
  check('43b manage without metadata: outcome synced with a bare entry',
    outcome === 'synced' && eq(written, [{ id: 'longcat-2.5-preview-free' }]),
    JSON.stringify({ outcome, mutations: calls.mutations }))
  check('43b manage without metadata: the routing header still lands',
    UUID.test(sessionHeaderOp(calls.mutations[0]?.[1])?.value?.['x-opencode-session'] ?? ''),
    JSON.stringify(sessionHeaderOp(calls.mutations[0]?.[1])))
  check('43b manage without metadata: the row and the toast say so',
    calls.optionDescriptions['sync-models']?.['longcat-2.5-preview-free'] === t('provider-sync-row-no-meta')
      && calls.notifications.some(n => n.color === 'warning' && n.text === t('provider-sync-meta-unavailable')),
    JSON.stringify({ rows: calls.optionDescriptions['sync-models'], notifications: calls.notifications }))
}

// 43c. A Claude id splits to the anthropic derived route: the vendor serves
// `claude-*` over anthropic-messages only, and an openai-completions request
// for it fails the first turn with 400 ModelProtocolUnsupported.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_SYNC,
    'sync-models': { selected: ['claude-haiku-5-5'] },
  }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [{ route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] }],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : [{ id: 'glm-5.3' }, { id: 'claude-haiku-5-5' }],
  })
  const outcome = await runProviderWizard(deps)
  check('43c claude split: outcome synced', outcome === 'synced', outcome)
  check('43c claude split: the row notes its anthropic-only routing',
    (calls.optionDescriptions['sync-models']?.['claude-haiku-5-5'] ?? '').includes(t('provider-sync-row-anthropic')),
    JSON.stringify(calls.optionDescriptions['sync-models']))
  const anthropicMutation = calls.mutations.find(([route]) => route === 'opencode-go-live-anthropic')
  check('43c claude split: the anthropic derived route carries the Claude id',
    calls.mutations.length === 1 && anthropicMutation !== undefined
      && anthropicMutation[1].find(op => op.path.join('.') === 'models')?.value?.[0]?.id === 'claude-haiku-5-5',
    JSON.stringify(calls.mutations))
  check('43c claude split: the anthropic route declares its protocol and endpoint',
    eq(anthropicMutation?.[1]?.slice(1, 5), [
      { op: 'set', path: ['api'], value: 'anthropic-messages' },
      { op: 'set', path: ['baseURL'], value: 'https://opencode.ai/zen/go' },
      { op: 'set', path: ['apiKeyEnv'], value: 'OPENCODE_GO_API_KEY' },
      { op: 'set', path: ['displayName'], value: 'OpenCode Go (live-anthropic)' },
    ]), JSON.stringify(anthropicMutation?.[1]))
  check('43c claude split: the primary derived route is untouched',
    !calls.mutations.some(([route]) => route === 'opencode-go-live')
      && !calls.removedProfiles.includes('opencode-go-live'),
    JSON.stringify({ mutations: calls.mutations, removed: calls.removedProfiles }))
}

// 43d. A mixed selection splits across both derived routes, with one
// transcript line per active route.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_SYNC,
    'sync-models': { selected: ['longcat-2.5-preview-free', 'claude-haiku-5-5'] },
  }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [{ route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] }],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : [{ id: 'glm-5.3' }, { id: 'longcat-2.5-preview-free' }, { id: 'claude-haiku-5-5' }],
  })
  const outcome = await runProviderWizard(deps)
  const byRoute = new Map(calls.mutations.map(([route, ops]) => [route, ops]))
  check('43d mixed split: outcome synced', outcome === 'synced', outcome)
  check('43d mixed split: each protocol lands on its own derived route',
    calls.mutations.length === 2
      && byRoute.get('opencode-go-live')?.find(op => op.path.join('.') === 'models')?.value?.[0]?.id === 'longcat-2.5-preview-free'
      && byRoute.get('opencode-go-live-anthropic')?.find(op => op.path.join('.') === 'models')?.value?.[0]?.id === 'claude-haiku-5-5',
    JSON.stringify(calls.mutations))
  check('43d mixed split: transcript names both derived routes',
    calls.pushed.some(entry => entry.title === '/provider'
      && entry.lines.some(line => /^opencode-go-live[:：]\s*longcat-2\.5-preview-free$/u.test(line))
      && entry.lines.some(line => /^opencode-go-live-anthropic[:：]\s*claude-haiku-5-5$/u.test(line))),
    JSON.stringify(calls.pushed))
}

// 43e. A Claude id stranded on the primary route by an older build migrates
// on the next write: the primary route drops it, the anthropic route gains it.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_SYNC,
    'sync-models': { selected: ['claude-haiku-5-5'] },
  }, {
    statefulProfiles: true,
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [
      { route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] },
      { route: 'opencode-go-live', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: false, api: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1', models: ['claude-haiku-5-5'], modelEntries: [{ id: 'claude-haiku-5-5' }], headers: { 'x-opencode-session': 'session-abc' } },
    ],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : [{ id: 'glm-5.3' }, { id: 'claude-haiku-5-5' }],
  })
  const outcome = await runProviderWizard(deps)
  check('43e stranded migration: outcome synced', outcome === 'synced', outcome)
  check('43e stranded migration: the primary route is removed, the anthropic route gains the id',
    calls.removedProfiles.includes('opencode-go-live')
      && calls.mutations.some(([route, ops]) => route === 'opencode-go-live-anthropic'
        && ops.find(op => op.path.join('.') === 'models')?.value?.[0]?.id === 'claude-haiku-5-5'),
    JSON.stringify({ removed: calls.removedProfiles, mutations: calls.mutations }))
}

// 44. Un-checking an enabled model disables it, while a kept id keeps the
// fields its stored entry states (hand-tuned values beat the catalog).
{
  const { deps, calls } = makeDeps({
    'action': ACTION_SYNC,
    'sync-models': { selected: ['grok-4.5'] },
  }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [
      { route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] },
      {
        route: 'opencode-go-live',
        ref: 'OPENCODE_GO_API_KEY',
        shadowed: false,
        isCatalog: false,
        api: 'openai-completions',
        baseURL: 'https://opencode.ai/zen/go/v1',
        models: ['grok-4.5', 'longcat-2.5-preview-free'],
        modelEntries: [{ id: 'grok-4.5', contextWindow: 1000000, compat: { supportsStore: false } }, { id: 'longcat-2.5-preview-free' }],
      },
    ],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : [{ id: 'glm-5.3' }, { id: 'grok-4.5' }, { id: 'longcat-2.5-preview-free' }],
  })
  const outcome = await runProviderWizard(deps)
  const written = calls.mutations[0]?.[1]?.[0]?.value ?? []
  check('44 manage disable: outcome synced', outcome === 'synced', outcome)
  check('44 manage disable: the enabled ids arrive pre-checked',
    eq(calls.defaults['sync-models'], ['grok-4.5', 'longcat-2.5-preview-free']),
    JSON.stringify(calls.defaults['sync-models']))
  check('44 manage disable: the disabled id leaves, the kept entry keeps its hand-tuned field',
    written.length === 1 && written[0].id === 'grok-4.5'
      && written[0].contextWindow === 1000000
      && eq(written[0].compat, { supportsStore: false })
      && written[0].name === 'Grok 4.5'
      && written[0].maxTokens === 500000
      && eq(written[0].reasoningEfforts, { low: 'low', medium: 'medium', high: 'high' }),
    JSON.stringify(written))
  check('44 manage disable: the toast counts the change',
    calls.notifications.some(n => n.color === 'success'
      && n.text === t('provider-sync-success', {
        route: 'opencode-go',
        derived: 'opencode-go-live, opencode-go-live-anthropic',
        n: 1,
        added: 0,
        removed: 1,
      })),
    JSON.stringify(calls.notifications))
}

// 45. Re-applying the current enabled set writes nothing — but a stored entry
// that predates the metadata (a bare id) is enriched exactly once.
{
  const ENRICHED_GROK = {
    name: 'Grok 4.5',
    contextWindow: 500000,
    maxTokens: 500000,
    input: ['text', 'image'],
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
    id: 'grok-4.5',
  }
  const { deps, calls } = makeDeps({
    'action': ACTION_SYNC,
    'sync-models': { selected: ['grok-4.5'] },
  }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [
      { route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] },
      { route: 'opencode-go-live', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: false, api: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1', models: ['grok-4.5'], modelEntries: [ENRICHED_GROK], headers: { 'x-opencode-session': 'session-abc' } },
    ],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : [{ id: 'glm-5.3' }, { id: 'grok-4.5' }],
  })
  const outcome = await runProviderWizard(deps)
  check('45 manage no-op: outcome cancelled (nothing written)', outcome === 'cancelled', outcome)
  check('45 manage no-op: no profile mutation', eq(calls.mutations, []), JSON.stringify(calls.mutations))
  check('45 manage no-op: toast says it already matches',
    calls.notifications.some(n => n.text === t('provider-sync-unchanged', { route: 'opencode-go', derived: 'opencode-go-live, opencode-go-live-anthropic' })),
    JSON.stringify(calls.notifications))

  // Same selection over a bare stored entry: the catalog fields are added once.
  const bare = makeDeps({
    'action': ACTION_SYNC,
    'sync-models': { selected: ['grok-4.5'] },
  }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [
      { route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] },
      { route: 'opencode-go-live', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: false, api: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1', models: ['grok-4.5'], modelEntries: [{ id: 'grok-4.5' }] },
    ],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : [{ id: 'glm-5.3' }, { id: 'grok-4.5' }],
  })
  const bareOutcome = await runProviderWizard(bare.deps)
  const enriched = bare.calls.mutations[0]?.[1]?.[0]?.value ?? []
  check('45 manage enrichment: a bare entry gains the catalog fields once',
    bareOutcome === 'synced' && enriched.length === 1 && enriched[0].id === 'grok-4.5'
      && enriched[0].name === 'Grok 4.5' && enriched[0].contextWindow === 500000
      && eq(enriched[0].reasoningEfforts, { low: 'low', medium: 'medium', high: 'high' }),
    JSON.stringify({ outcome: bareOutcome, mutations: bare.calls.mutations }))

  // A route written before the header existed is repaired by the next submit,
  // and an existing routing id is never replaced.
  const legacy = makeDeps({
    'action': ACTION_SYNC,
    'sync-models': { selected: ['grok-4.5'] },
  }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [
      { route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] },
      { route: 'opencode-go-live', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: false, api: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1', models: ['grok-4.5'], modelEntries: [ENRICHED_GROK] },
    ],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : [{ id: 'glm-5.3' }, { id: 'grok-4.5' }],
  })
  const legacyOutcome = await runProviderWizard(legacy.deps)
  check('45 header repair: a missing routing header is added without touching the models',
    legacyOutcome === 'synced'
      && eq(legacy.calls.mutations[0]?.[1]?.[0]?.value, [ENRICHED_GROK])
      && UUID.test(sessionHeaderOp(legacy.calls.mutations[0]?.[1])?.value?.['x-opencode-session'] ?? ''),
    JSON.stringify({ outcome: legacyOutcome, mutations: legacy.calls.mutations }))

  const kept = makeDeps({
    'action': ACTION_SYNC,
    'sync-models': { selected: ['grok-4.5'] },
  }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [
      { route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] },
      { route: 'opencode-go-live', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: false, api: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1', models: ['grok-4.5'], modelEntries: [ENRICHED_GROK], headers: { 'x-opencode-session': 'session-abc' } },
    ],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : [{ id: 'glm-5.3' }, { id: 'grok-4.5' }],
  })
  const keptOutcome = await runProviderWizard(kept.deps)
  check('45 header repair: an existing routing id is reused, not regenerated',
    keptOutcome === 'cancelled' && eq(kept.calls.mutations, []),
    JSON.stringify({ outcome: keptOutcome, mutations: kept.calls.mutations }))
}

// 45b. A newly installed catalog may now cover an enabled vendor-only id.
// Its vendor presence, not catalog membership, decides retirement everywhere.
for (const advertised of [true, false]) {
  const label = `45b catalog upgrade (${advertised ? 'still advertised' : 'vendor removed'})`
  const { deps, calls } = makeDeps({
    'action': ACTION_SYNC,
    'sync-models': { selected: ['grok-4.5'] },
  }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [
      { route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] },
      {
        route: 'opencode-go-live', ref: 'OPENCODE_GO_API_KEY', shadowed: false,
        isCatalog: false, api: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1',
        models: ['grok-4.5'], modelEntries: [{ id: 'grok-4.5' }],
        headers: { 'x-opencode-session': 'session-abc' },
      },
    ],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    vendorCatalog: {},
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }, { id: 'grok-4.5' }]
      : [{ id: 'glm-5.3' }, ...(advertised ? [{ id: 'grok-4.5' }] : []), { id: 'longcat-2.5-preview-free' }],
  })
  const [status] = await inspectCatalogRoutes(deps.host)
  check(`${label}: only vendor-only ids remain available to enable`,
    eq(status?.vendorOnly?.map(row => row.id), ['longcat-2.5-preview-free'])
      && eq(status?.unenabled, ['longcat-2.5-preview-free']), JSON.stringify(status))
  check(`${label}: retirement follows the full vendor listing`,
    eq(status?.enabled, ['grok-4.5']) && eq(status?.retired, advertised ? [] : ['grok-4.5']),
    JSON.stringify(status))

  const lines = []
  await reportCatalogRoutesQuietly(deps.host, (message, level) => lines.push([level, message]))
  check(`${label}: boot reports a retired id only after vendor removal`,
    eq(lines, [
      ['debug', 'opencode-go: 1 official model(s) not enabled (longcat-2.5-preview-free) — enable them from /provider'],
      ...(!advertised ? [['debug', 'opencode-go: 1 enabled model(s) the endpoint no longer advertises (grok-4.5)']] : []),
    ]), JSON.stringify(lines))

  const outcome = await runProviderWizard(deps)
  const rows = calls.optionDescriptions['sync-models'] ?? {}
  check(`${label}: the enabled row remains selectable and pre-checked`,
    eq(Object.keys(rows), ['longcat-2.5-preview-free', 'grok-4.5'])
      && eq(calls.defaults['sync-models'], ['grok-4.5']),
    JSON.stringify({ rows, defaults: calls.defaults['sync-models'] }))
  check(`${label}: the wizard uses the inspection's retirement result`,
    rows['grok-4.5'] === t(advertised ? 'provider-sync-row-no-meta' : 'provider-sync-row-retired'),
    JSON.stringify(rows))
  check(`${label}: keeping the selection never rewrites or removes it`,
    outcome === 'cancelled' && eq(calls.mutations, []) && eq(calls.removedProfiles, [])
      && eq(calls.profiles, []) && eq(calls.credentials, []),
    JSON.stringify({ outcome, mutations: calls.mutations, removed: calls.removedProfiles }))
}

// 46. No resolvable key: refused by name, and no probe is attempted.
{
  const { deps, calls } = makeDeps({ 'action': ACTION_SYNC }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [{ route: 'opencode-go', ref: '', shadowed: false, isCatalog: true, models: ['glm-5.3'] }],
    discover: () => { throw new Error('must not probe without a key') },
  })
  const outcome = await runProviderWizard(deps)
  check('46 manage without key: outcome cancelled', outcome === 'cancelled', outcome)
  check('46 manage without key: no discovery request at all',
    eq(calls.discoverRequests, []), JSON.stringify(calls.discoverRequests))
  check('46 manage without key: refusal names the route',
    calls.notifications.some(n => n.color === 'warning'
      && n.text === t('provider-sync-no-credential', { route: 'opencode-go', derived: 'opencode-go-live' })),
    JSON.stringify(calls.notifications))
}

// 47. The vendor listing fails: reported as failed, nothing written.
{
  const { deps, calls } = makeDeps({ 'action': ACTION_SYNC }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [
      { route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] },
      { route: 'opencode-go-live', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: false, api: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1', models: ['grok-4.5'] },
    ],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : Promise.reject(new Error('connection refused')),
  })
  const outcome = await runProviderWizard(deps)
  check('47 manage offline: outcome failed', outcome === 'failed', outcome)
  check('47 manage offline: nothing written and nothing removed',
    eq(calls.mutations, []) && eq(calls.removedProfiles, []),
    JSON.stringify({ mutations: calls.mutations, removed: calls.removedProfiles }))
  check('47 manage offline: the warning names the fetch failure',
    calls.notifications.some(n => n.color === 'warning'
      && n.text === t('provider-sync-listing-failed', { route: 'opencode-go', derived: 'opencode-go-live' })),
    JSON.stringify(calls.notifications))
}

// 48. Clearing every row disables everything: the derived route is retired.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_SYNC,
    'sync-models': { selected: [] },
  }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [
      { route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] },
      { route: 'opencode-go-live', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: false, api: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1', models: ['grok-4.5', 'longcat-2.5-preview-free'] },
    ],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : [{ id: 'glm-5.3' }, { id: 'grok-4.5' }, { id: 'longcat-2.5-preview-free' }],
  })
  const outcome = await runProviderWizard(deps)
  check('48 manage disable-all: outcome synced', outcome === 'synced', outcome)
  check('48 manage disable-all: the derived profile is removed',
    eq(calls.removedProfiles, ['opencode-go-live']) && eq(calls.mutations, []),
    JSON.stringify({ removed: calls.removedProfiles, mutations: calls.mutations }))
  check('48 manage disable-all: transcript reports the pruned route',
    calls.pushed.some(entry => entry.title === '/provider'
      && entry.lines[1] === t('provider-sync-line-pruned', { n: 2 })),
    JSON.stringify(calls.pushed))

  const second = makeDeps({ 'action': ACTION_SYNC, 'sync-models': { selected: [] } }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [{ route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] }],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    discover: request => request.provider !== undefined ? [{ id: 'glm-5.3' }] : [{ id: 'glm-5.3' }],
  })
  const secondOutcome = await runProviderWizard(second.deps)
  check('48 manage disable-all: nothing enabled and no derived route means no write',
    secondOutcome === 'cancelled'
      && eq(second.calls.mutations, []) && eq(second.calls.removedProfiles, []),
    JSON.stringify({ outcome: secondOutcome, mutations: second.calls.mutations }))
}

// 49. A derived route pointing at another endpoint/protocol is a human's
// route: refused, never overwritten.
{
  const { deps, calls } = makeDeps({ 'action': ACTION_SYNC }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [
      { route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] },
      { route: 'opencode-go-live', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: false, api: 'anthropic-messages', baseURL: 'https://relay.example/v1', models: ['my-model'] },
    ],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : [{ id: 'glm-5.3' }, { id: 'grok-4.5' }],
  })
  const outcome = await runProviderWizard(deps)
  check('49 manage repurposed route: outcome cancelled', outcome === 'cancelled', outcome)
  check('49 manage repurposed route: nothing written',
    eq(calls.mutations, []) && eq(calls.removedProfiles, []),
    JSON.stringify({ mutations: calls.mutations, removed: calls.removedProfiles }))
  check('49 manage repurposed route: refusal names the derived route',
    calls.notifications.some(n => n.color === 'warning'
      && n.text === t('provider-sync-derived-conflict', { route: 'opencode-go', derived: 'opencode-go-live' })),
    JSON.stringify(calls.notifications))
}

// 49b. Catalog membership does not authorize forwarding a relay-only key to
// the vendor. The effective flag includes overrides from composition bases;
// raw fields also protect structural callers that do not expose that flag.
for (const [label, override] of [
  ['explicit endpoint', { baseURL: 'https://relay.example/v1' }],
  ['explicit protocol', { api: 'openai-responses' }],
  ['inherited connection', { hasRoutingOverrides: true }],
  ['custom headers', { hasCustomHeaders: true }],
  ['resolved headers', { headers: { 'x-relay-account': 'regression' } }],
]) {
  for (const credentialSource of ['store', 'environment']) {
    const parent = {
      route: 'opencode-go', ref: 'RELAY_API_KEY', shadowed: credentialSource === 'environment',
      isCatalog: true, models: ['glm-5.3'], ...override,
    }
    const derived = {
      route: 'opencode-go-live', ref: 'RELAY_API_KEY', shadowed: false, isCatalog: false,
      api: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1',
      models: ['grok-4.5'], modelEntries: [{ id: 'grok-4.5', customField: 'keep' }],
    }
    const { deps, calls } = makeDeps({ action: ACTION_SYNC }, {
      catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
      configured: [parent, derived],
    })
    let credentialReads = 0
    deps.host.envShadows = () => credentialSource === 'environment'
    deps.host.envValue = () => { credentialReads++; return 'regression-relay-key' }
    deps.host.readCredential = async () => { credentialReads++; return 'regression-relay-key' }
    const before = JSON.stringify([parent, derived])
    check(`49b ${label}/${credentialSource}: no official-sync candidate`,
      syncableCatalogRoutes(deps.host).length === 0)
    const [status] = await inspectCatalogRoutes(deps.host)
    const logs = []
    await reportCatalogRoutesQuietly(deps.host, message => logs.push(message))
    let writeRefused = false
    try {
      await writeCatalogModels(deps.host, { route: parent.route, ref: parent.ref }, ['grok-4.5'])
    } catch { writeRefused = true }
    const outcome = await runProviderWizard(deps)
    check(`49b ${label}/${credentialSource}: fail closed before credentials and discovery`,
      status?.reason === 'connection-overridden' && credentialReads === 0
        && calls.discoverRequests.length === 0 && logs.length === 0,
      JSON.stringify({ status, credentialReads, requests: calls.discoverRequests, logs }))
    check(`49b ${label}/${credentialSource}: no hidden sync option or profile changes`,
      writeRefused && outcome === 'cancelled'
        && !Object.hasOwn(calls.optionDescriptions.action ?? {}, t('provider-opt-action-sync'))
        && !calls.asks.includes('sync-models') && calls.mutations.length === 0
        && calls.profiles.length === 0 && calls.removedProfiles.length === 0
        && calls.credentials.length === 0 && calls.removed.length === 0
        && JSON.stringify([parent, derived]) === before,
      JSON.stringify({ writeRefused, outcome, asks: calls.asks, mutations: calls.mutations }))
  }
}

// Recheck after asynchronous catalog/credential work, before the network probe.
{
  const previousLang = getLang()
  try {
    for (const lang of ['zh', 'en']) {
      setLang(lang)
      const parent = { route: 'opencode-go', ref: 'RELAY_API_KEY', shadowed: false, isCatalog: true }
      const { deps, calls } = makeDeps({ action: { selected: [t('provider-opt-action-sync')] } }, {
        configured: [parent], storedCredentials: { RELAY_API_KEY: 'regression-key' },
        discover: () => {
          parent.hasRoutingOverrides = true
          return [{ id: 'glm-5.3' }]
        },
      })
      const outcome = await runProviderWizard(deps)
      const warning = t('provider-sync-connection-overridden', { route: parent.route })
      check(`49b ${lang} connection changes during discovery: no vendor request follows`,
        outcome === 'cancelled' && eq(calls.discoverRequests, [{ provider: 'opencode-go' }])
          && calls.mutations.length === 0 && calls.profiles.length === 0
          && calls.removedProfiles.length === 0,
        JSON.stringify({ outcome, requests: calls.discoverRequests, mutations: calls.mutations }))
      check(`49b ${lang} connection override warning is localized, not a listing failure`,
        warning.includes(parent.route)
          && calls.notifications.some(row => row.color === 'warning' && row.text === warning)
          && !calls.notifications.some(row => row.text === t('provider-sync-listing-failed', { route: parent.route })),
        JSON.stringify(calls.notifications))
    }
  } finally {
    setLang(previousLang)
  }
}

// The whole-row snapshot includes inherited connection provenance, so a
// metadata fetch cannot turn an older inspection into permission to write.
{
  const parent = { route: 'opencode-go', ref: 'RELAY_API_KEY', shadowed: false, isCatalog: true }
  const { deps, calls } = makeDeps({
    action: ACTION_SYNC, 'sync-models': { selected: ['grok-4.5'] },
  }, {
    configured: [parent], storedCredentials: { RELAY_API_KEY: 'regression-key' },
    discover: request => request.provider === undefined ? [{ id: 'grok-4.5' }] : [{ id: 'glm-5.3' }],
  })
  deps.readVendorCatalog = async () => { parent.hasRoutingOverrides = true; return {} }
  check('49b inherited override after inspection: stale selection is refused',
    await runProviderWizard(deps) === 'failed' && calls.mutations.length === 0
      && calls.profiles.length === 0 && calls.removedProfiles.length === 0,
    JSON.stringify({ mutations: calls.mutations, profiles: calls.profiles, removed: calls.removedProfiles }))
}

// Blocking vendor sync does not disable normal model editing on a relay.
{
  const { deps, calls } = makeDeps({
    action: ACTION_EDIT,
    'edit-provider': { selected: ['opencode-go'] },
    'edit-menu': { selected: [t('provider-opt-edit-models')] },
    models: { selected: ['relay-model'] },
  }, {
    configured: [{
      route: 'opencode-go', ref: 'RELAY_API_KEY', shadowed: false, isCatalog: true,
      baseURL: 'https://relay.example/v1', api: 'openai-completions',
      hasRoutingOverrides: true, models: ['glm-5.3'], modelEntries: [{ id: 'glm-5.3' }],
    }],
    storedCredentials: { RELAY_API_KEY: 'regression-relay-key' },
    discover: request => request.provider === undefined ? [{ id: 'relay-model' }] : [{ id: 'glm-5.3' }],
  })
  check('49b relay model editing remains available', await runProviderWizard(deps) === 'updated')
  check('49b relay model editing sends its key only to the configured relay',
    eq(calls.discoverRequests, [
      { provider: 'opencode-go' },
      { baseURL: 'https://relay.example/v1', api: 'openai-completions', apiKey: 'regression-relay-key' },
    ]) && calls.mutations.length === 1 && calls.mutations[0][0] === 'opencode-go',
    JSON.stringify({ requests: calls.discoverRequests, mutations: calls.mutations }))
}

// 49c. Add accepts an existing catalog route and only asks about replacement
// after discovery. Skipping the endpoint must not send its typed relay key
// to the official URL, even if the user later cancels before saving anything.
for (const [label, override] of [
  ['explicit endpoint', { baseURL: 'https://relay.example/v1' }],
  ['explicit protocol', { api: 'openai-responses' }],
  ['inherited connection', { hasRoutingOverrides: true }],
  ['custom headers', { hasCustomHeaders: true }],
  ['resolved headers', { headers: { 'x-relay-account': 'regression' } }],
  ['repurposed route', { isCatalog: false }],
  ['inherited-only route', undefined],
]) {
  const configured = override === undefined ? [] : [{
    route: 'opencode-go', ref: 'RELAY_API_KEY', shadowed: false, isCatalog: true, ...override,
  }]
  const before = JSON.stringify(configured)
  const { deps, calls } = makeDeps({
    action: ACTION_ADD, mode: MODE_CATALOG, catalog: { selected: ['opencode-go'] },
    apikey: { custom: 'regression-relay-draft-key' }, 'baseurl-choice': SKIP_BASEURL,
    models: { selected: ['glm-5.3'] }, confirm: 'cancel',
  }, {
    configured, ...(override === undefined ? { routeExists: true } : {}),
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    discovered: [{ id: 'glm-5.3' }],
  })
  const outcome = await runProviderWizard(deps)
  check(`49c ${label}: cancelled add never sends a draft key to the vendor`,
    outcome === 'cancelled' && eq(calls.discoverRequests, [{ provider: 'opencode-go' }])
      && calls.asks.includes('confirm')
      && calls.notifications.some(row => row.color === 'warning' && row.text === t('provider-live-fetch-unavailable')),
    JSON.stringify({ outcome, requests: calls.discoverRequests, notifications: calls.notifications }))
  check(`49c ${label}: cancelled add leaves profiles and credentials untouched`,
    calls.credentials.length === 0 && calls.removed.length === 0
      && calls.profiles.length === 0 && calls.mutations.length === 0 && calls.removedProfiles.length === 0
      && JSON.stringify(configured) === before,
    JSON.stringify({ profiles: calls.profiles, mutations: calls.mutations }))
}

for (const change of [
  'existing override', 'new override', 'inherited-only',
  'cleared override', 'removed override route', 'removed inherited-only',
]) {
  const configured = ['existing override', 'cleared override', 'removed override route'].includes(change) ? [{
    route: 'opencode-go', ref: 'RELAY_API_KEY', shadowed: false, isCatalog: true,
    ...(change === 'existing override' ? {} : { hasRoutingOverrides: true }),
  }] : []
  let inheritedExists = change === 'removed inherited-only'
  const { deps, calls } = makeDeps({
    action: ACTION_ADD, mode: MODE_CATALOG, catalog: { selected: ['opencode-go'] },
    apikey: { custom: 'regression-relay-draft-key' }, 'baseurl-choice': SKIP_BASEURL,
    models: 'cancel',
  }, {
    configured,
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    discover: () => {
      if (change === 'inherited-only') inheritedExists = true
      else if (change === 'removed inherited-only') inheritedExists = false
      else if (change === 'cleared override') delete configured[0].hasRoutingOverrides
      else if (change === 'removed override route') configured.splice(0)
      else if (change === 'existing override') configured[0].hasRoutingOverrides = true
      else configured.push({
        route: 'opencode-go', ref: 'RELAY_API_KEY', shadowed: false, isCatalog: true,
        baseURL: 'https://relay.example/v1',
      })
      return [{ id: 'glm-5.3' }]
    },
  })
  deps.host.routeExists = route => inheritedExists || configured.some(row => row.route === route)
  const outcome = await runProviderWizard(deps)
  check(`49c ${change} during catalog lookup: draft key stays local`,
    outcome === 'cancelled' && eq(calls.discoverRequests, [{ provider: 'opencode-go' }])
      && calls.credentials.length === 0 && calls.profiles.length === 0 && calls.mutations.length === 0,
    JSON.stringify({ outcome, requests: calls.discoverRequests, mutations: calls.mutations }))
}

// The selected connection is also captured before the credential/endpoint
// prompts, not just after they return and discovery begins. Adding an override
// during either prompt must also fail the later current-connection check.
for (const prompt of ['apikey', 'baseurl-choice']) {
  for (const change of ['added', 'removed']) {
    const configured = [{
      route: 'opencode-go', ref: 'RELAY_API_KEY', shadowed: false, isCatalog: true,
      ...(change === 'removed' ? { hasRoutingOverrides: true } : {}),
    }]
    const { deps, calls } = makeDeps({
      action: ACTION_ADD, mode: MODE_CATALOG, catalog: { selected: ['opencode-go'] },
      apikey: { custom: 'regression-relay-draft-key' }, 'baseurl-choice': SKIP_BASEURL,
      models: 'cancel',
    }, {
      configured,
      catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
      discovered: [{ id: 'glm-5.3' }],
    })
    const ask = deps.ask
    deps.ask = async (request, options) => {
      const answer = await ask(request, options)
      if (request.questions.some(question => question.id === prompt)) {
        if (change === 'added') configured[0].hasRoutingOverrides = true
        else delete configured[0].hasRoutingOverrides
      }
      return answer
    }
    check(`49c override ${change} during ${prompt}: selected route's draft key stays local`,
      await runProviderWizard(deps) === 'cancelled'
        && eq(calls.discoverRequests, [{ provider: 'opencode-go' }])
        && calls.credentials.length === 0 && calls.profiles.length === 0 && calls.mutations.length === 0,
      JSON.stringify({ requests: calls.discoverRequests, mutations: calls.mutations }))
  }
}

// Connection eligibility does not freeze unrelated configuration: changing
// enabled models or the stored ref during the catalog await must not suppress
// a normal vendor probe with the independently supplied draft credential.
for (const change of ['models', 'ref']) {
  const configured = [{
    route: 'opencode-go', ref: 'OLD_API_KEY', shadowed: false, isCatalog: true,
    models: ['old-model'],
  }]
  const { deps, calls } = makeDeps({
    action: ACTION_ADD, mode: MODE_CATALOG, catalog: { selected: ['opencode-go'] },
    apikey: { custom: 'regression-vendor-draft-key' }, 'baseurl-choice': SKIP_BASEURL,
    models: 'cancel',
  }, {
    configured,
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    discover: request => {
      if (request.provider !== undefined) {
        if (change === 'models') configured[0].models = ['new-model']
        else configured[0].ref = 'NEW_API_KEY'
      }
      return [{ id: 'glm-5.3' }]
    },
  })
  check(`49c ${change}-only change during catalog lookup: default vendor probe remains available`,
    await runProviderWizard(deps) === 'cancelled'
      && eq(calls.discoverRequests, [
        { provider: 'opencode-go' },
        { baseURL: 'https://opencode.ai/zen/go/v1', api: 'openai-completions', apiKey: 'regression-vendor-draft-key' },
      ])
      && calls.credentials.length === 0 && calls.profiles.length === 0 && calls.mutations.length === 0,
    JSON.stringify({ requests: calls.discoverRequests, mutations: calls.mutations }))
}

// Ordinary model editing still works from the installed snapshot without an
// explicit endpoint, but an overridden connection gets no anonymous vendor probe.
for (const [label, override] of [
  ['explicit protocol', { api: 'openai-responses' }],
  ['inherited connection', { hasRoutingOverrides: true }],
]) {
  const { deps, calls } = makeDeps({
    action: ACTION_EDIT, 'edit-provider': { selected: ['opencode-go'] },
    'edit-menu': { selected: [t('provider-opt-edit-models')] },
    models: { selected: ['glm-5.3'] },
  }, {
    configured: [{
      route: 'opencode-go', ref: 'RELAY_API_KEY', shadowed: false, isCatalog: true,
      models: ['old-model'], modelEntries: [{ id: 'old-model' }], ...override,
    }],
    discovered: [{ id: 'glm-5.3' }],
  })
  let credentialReads = 0
  deps.host.readCredential = async () => { credentialReads++; return 'regression-relay-key' }
  check(`49c ${label}: snapshot model editing remains available without a vendor probe`,
    await runProviderWizard(deps) === 'updated' && credentialReads === 0
      && eq(calls.discoverRequests, [{ provider: 'opencode-go' }])
      && calls.mutations.length === 1 && calls.mutations[0][0] === 'opencode-go',
    JSON.stringify({ credentialReads, requests: calls.discoverRequests, mutations: calls.mutations }))
}

// 50. The boot pass only reports: one debug line per un-enabled and retired
// group, never a write, silence on a no-op, and no throw when offline.
{
  const BOOT = options => makeDeps({}, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [{ route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] }],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    ...options,
  })
  const pending = BOOT({
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : [{ id: 'glm-5.3' }, { id: 'grok-4.5' }, { id: 'longcat-2.5-preview-free' }],
  })
  const lines = []
  await reportCatalogRoutesQuietly(pending.deps.host, (message, level) => lines.push([level, message]))
  check('50 boot report: one debug line names the un-enabled models',
    eq(lines, [[
      'debug',
      'opencode-go: 2 official model(s) not enabled (grok-4.5, longcat-2.5-preview-free) — enable them from /provider',
    ]]), JSON.stringify(lines))
  check('50 boot report: nothing is written',
    eq(pending.calls.mutations, []) && eq(pending.calls.removedProfiles, []),
    JSON.stringify({ mutations: pending.calls.mutations, removed: pending.calls.removedProfiles }))

  const retired = BOOT({
    configured: [
      { route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] },
      { route: 'opencode-go-live', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: false, api: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1', models: ['grok-4.5', 'longcat-2.5-preview-free'], headers: { 'x-opencode-session': 'session-abc' } },
    ],
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : [{ id: 'glm-5.3' }, { id: 'grok-4.5' }],
  })
  const retiredLines = []
  await reportCatalogRoutesQuietly(retired.deps.host, (message, level) => retiredLines.push([level, message]))
  check('50 boot report: an enabled id the vendor dropped is reported',
    eq(retiredLines, [['debug', 'opencode-go: 1 enabled model(s) the endpoint no longer advertises (longcat-2.5-preview-free)']]),
    JSON.stringify(retiredLines))

  const clean = BOOT({
    configured: [
      { route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] },
      { route: 'opencode-go-live', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: false, api: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1', models: ['grok-4.5'], headers: { 'x-opencode-session': 'session-abc' } },
    ],
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : [{ id: 'glm-5.3' }, { id: 'grok-4.5' }],
  })
  const cleanLines = []
  await reportCatalogRoutesQuietly(clean.deps.host, (message, level) => cleanLines.push([level, message]))
  check('50 boot report: an in-sync route is silent', eq(cleanLines, []), JSON.stringify(cleanLines))

  const offline = BOOT({
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : Promise.reject(new Error('connection refused')),
  })
  const offlineLines = []
  let threw = false
  try {
    await reportCatalogRoutesQuietly(
      offline.deps.host,
      (message, level) => offlineLines.push([level, message]),
      { signal: AbortSignal.timeout(5000) },
    )
  } catch {
    threw = true
  }
  check('50 boot report: an offline listing neither throws nor writes',
    threw === false && eq(offline.calls.mutations, [])
      && eq(offlineLines, [['debug', 'opencode-go: listing-failed']])
      && offline.calls.discoverSignals.every(signal => signal instanceof AbortSignal),
    JSON.stringify({ threw, lines: offlineLines, mutations: offline.calls.mutations }))

  const aborted = new AbortController()
  const late = BOOT({
    configured: [
      { route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false,
        isCatalog: true, models: ['glm-5.3'] },
      { route: 'opencode-go-live', ref: 'OPENCODE_GO_API_KEY', shadowed: false,
        isCatalog: false, api: 'openai-completions',
        baseURL: 'https://opencode.ai/zen/go/v1', models: ['grok-4.5'] },
    ],
    discover: request => {
      if (request.provider !== undefined) return [{ id: 'glm-5.3' }]
      aborted.abort()
      return [{ id: 'glm-5.3' }, { id: 'grok-4.5' }, { id: 'new-model' }]
    },
  })
  const lateLines = []
  await reportCatalogRoutesQuietly(late.deps.host,
    (message, level) => lateLines.push([level, message]), { signal: aborted.signal })
  check('50 boot report: owner unload discards late discovery and skips repairs',
    eq(late.calls.mutations, []) && eq(late.calls.removedProfiles, []) && eq(lateLines, []),
    JSON.stringify({ mutations: late.calls.mutations,
      removed: late.calls.removedProfiles, lines: lateLines }))

  // The one write the boot pass owns: a route enabled before the vendor's
  // routing-header requirement cannot serve a request, so the header is added
  // — without enabling or disabling a single model.
  const legacy = BOOT({
    configured: [
      { route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] },
      { route: 'opencode-go-live', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: false, api: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1', models: ['grok-4.5'], modelEntries: [{ id: 'grok-4.5' }] },
    ],
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : [{ id: 'glm-5.3' }, { id: 'grok-4.5' }],
  })
  const legacyLines = []
  await reportCatalogRoutesQuietly(legacy.deps.host, (message, level) => legacyLines.push([level, message]))
  check('50 boot repair: a missing routing header is added and reported',
    legacyLines.some(([, message]) => message === 'opencode-go: added the x-opencode-session routing header to opencode-go-live')
      && UUID.test(sessionHeaderOp(legacy.calls.mutations[0]?.[1])?.value?.['x-opencode-session'] ?? '')
      && eq(legacy.calls.mutations[0]?.[1]?.[0]?.value, [{ id: 'grok-4.5' }]),
    JSON.stringify({ lines: legacyLines, mutations: legacy.calls.mutations }))

  const healthy = BOOT({
    configured: [
      { route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] },
      { route: 'opencode-go-live', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: false, api: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1', models: ['grok-4.5'], headers: { 'x-opencode-session': 'session-abc' } },
    ],
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : [{ id: 'glm-5.3' }, { id: 'grok-4.5' }],
  })
  const healthyLines = []
  await reportCatalogRoutesQuietly(healthy.deps.host, (message, level) => healthyLines.push([level, message]))
  check('50 boot repair: a route that already has the header is left alone',
    eq(healthyLines, []) && eq(healthy.calls.mutations, []),
    JSON.stringify({ lines: healthyLines, mutations: healthy.calls.mutations }))
}

// 50b. Stateful settings exercise migration failure and concurrent edit windows.
{
  const parentRoute = 'opencode-go'
  const primaryRoute = 'opencode-go-live'
  const targetRoute = 'opencode-go-live-anthropic'
  const ref = 'OPENCODE_GO_API_KEY'
  const customEntry = {
    id: 'claude-fixture',
    contextWindow: 123456,
    maxTokens: 4567,
    reasoningEfforts: { high: 'custom-high' },
    input: ['text', 'image'],
    customField: { keep: true },
  }
  function migrationFixture(options = {}) {
    const primaryEntries = [
      customEntry,
      ...(options.mixed ? [{ id: 'grok-fixture', customField: 'also-keep' }] : []),
    ]
    const profiles = new Map([
      [parentRoute, {
        route: parentRoute, ref, shadowed: false, isCatalog: true,
        models: ['catalog-model'],
      }],
      [primaryRoute, {
        route: primaryRoute, ref, shadowed: false, isCatalog: false,
        api: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1',
        models: primaryEntries.map(entry => entry.id),
        modelEntries: structuredClone(primaryEntries),
        headers: { 'x-opencode-session': 'source-session' },
      }],
      ...(options.destination === undefined ? [] : [[targetRoute, {
        route: targetRoute, ref, shadowed: false, isCatalog: false,
        api: 'anthropic-messages', baseURL: 'https://opencode.ai/zen/go',
        models: [customEntry.id],
        modelEntries: [structuredClone(options.destination)],
        headers: {
          'X-OpenCode-Session': 'destination-session',
          'x-user-header': 'keep',
        },
      }]]),
    ])
    const calls = []
    const host = {
      listCatalogProviders: () => [{ provider: parentRoute, displayName: 'OpenCode Go' }],
      listConfiguredProviders: () => [...profiles.values()],
      routeExists: route => profiles.has(route),
      envShadows: () => false,
      readCredential: async () => 'synthetic-key',
      discoverModels: async request => {
        if (request.provider !== undefined) return [{ id: 'catalog-model' }]
        await options.duringDiscovery?.(profiles)
        return [{ id: 'catalog-model' }, { id: customEntry.id }, { id: 'grok-fixture' }]
      },
      mutateProfile: async (route, ops) => {
        calls.push(['set', route])
        if (options.failWrite === route) throw new Error('synthetic write refused')
        const provider = { route, ref, shadowed: false, isCatalog: false, ...profiles.get(route) }
        for (const op of ops) {
          if (op.path[0] === 'models') {
            provider.models = op.value.map(entry => entry.id)
            provider.modelEntries = structuredClone(op.value)
          } else if (op.path[0] === 'apiKeyEnv') provider.ref = op.value
          else provider[op.path[0]] = structuredClone(op.value)
        }
        profiles.set(route, provider)
        if (route === targetRoute) await options.afterDestination?.(profiles)
        if (route === primaryRoute) await options.afterPrimary?.(profiles)
      },
      removeProfile: async route => {
        calls.push(['remove', route])
        if (options.failRemove === route) throw new Error('synthetic removal refused')
        profiles.delete(route)
      },
    }
    return { host, profiles, calls }
  }
  const boot = fixture => reportCatalogRoutesQuietly(fixture.host, () => {})
  const rejected = async action => {
    try { await action(); return false } catch { return true }
  }
  const profileState = fixture => structuredClone([...fixture.profiles])

  // No metadata supplied at boot: preserve all fields, target first.
  {
    const fixture = migrationFixture()
    await boot(fixture)
    check('50b boot migration preserves all source model fields and writes target first',
      eq(fixture.profiles.get(targetRoute)?.modelEntries, [customEntry])
        && !fixture.profiles.has(primaryRoute)
        && eq(fixture.calls, [['set', targetRoute], ['remove', primaryRoute]]),
      JSON.stringify({ profiles: [...fixture.profiles], calls: fixture.calls }))
  }

  // Existing destination fields win; mixed-case session header stays single.
  {
    const destinationEntry = { id: customEntry.id, maxTokens: 999, name: 'Destination choice' }
    const fixture = migrationFixture({ destination: destinationEntry })
    await boot(fixture)
    const expectedHeaders = {
      'X-OpenCode-Session': 'destination-session',
      'x-user-header': 'keep',
    }
    check('50b destination fields win, enabled IDs deduplicate, and mixed-case header survives',
      eq(fixture.profiles.get(targetRoute)?.modelEntries, [{ ...customEntry, ...destinationEntry }])
        && eq(fixture.profiles.get(targetRoute)?.models, [customEntry.id])
        && eq(fixture.profiles.get(targetRoute)?.headers, expectedHeaders),
      JSON.stringify([...fixture.profiles]))
    fixture.calls.length = 0
    await boot(fixture)
    check('50b mixed-case existing session header does not cause another settings write',
      eq(fixture.calls, [])
        && eq(fixture.profiles.get(targetRoute)?.headers, expectedHeaders),
      JSON.stringify({ profiles: [...fixture.profiles], calls: fixture.calls }))
  }

  // Failure at either write/remove preserves the original source.
  for (const options of [
    { failWrite: targetRoute },
    { failRemove: primaryRoute },
    { mixed: true, failWrite: primaryRoute },
  ]) {
    const fixture = migrationFixture(options)
    const sourceBefore = structuredClone(fixture.profiles.get(primaryRoute))
    const failed = await rejected(() => boot(fixture))
    const destinationSafe = options.failWrite === targetRoute
      ? !fixture.profiles.has(targetRoute) && eq(fixture.calls, [['set', targetRoute]])
      : eq(fixture.profiles.get(targetRoute)?.modelEntries, [customEntry])
    check(`50b migration refusal preserves source: ${JSON.stringify(options)}`,
      failed && eq(fixture.profiles.get(primaryRoute), sourceBefore) && destinationSafe,
      JSON.stringify({ profiles: [...fixture.profiles], calls: fixture.calls }))
  }

  // Changes during discovery invalidate the boot plan, with zero writes.
  for (const [label, edit] of [
    ['delete primary', profiles => profiles.delete(primaryRoute)],
    ['replace selected models', profiles => {
      const primary = profiles.get(primaryRoute)
      primary.models = ['user-added']
      primary.modelEntries = [{ id: 'user-added', customField: 'new-selection' }]
    }],
    ['add selected model', profiles => {
      const primary = profiles.get(primaryRoute)
      primary.models.push('user-added')
      primary.modelEntries.push({ id: 'user-added', customField: 'new-selection' })
    }],
    ['repurpose primary endpoint', profiles => {
      profiles.get(primaryRoute).baseURL = 'https://other.example/v1'
    }],
    ['change parent credential reference', profiles => {
      profiles.get(parentRoute).ref = 'OTHER_API_KEY'
    }],
    ['create repurposed target', profiles => {
      profiles.set(targetRoute, {
        route: targetRoute, ref, shadowed: false, isCatalog: false,
        api: 'openai-completions', baseURL: 'https://other.example/v1',
        models: ['user-model'], modelEntries: [{ id: 'user-model', customField: 'keep-user-edit' }],
        headers: { 'X-OpenCode-Session': 'user-session' },
      })
    }],
  ]) {
    let stateAfterEdit
    const fixture = migrationFixture({
      duringDiscovery: async profiles => {
        await Promise.resolve()
        edit(profiles)
        stateAfterEdit = structuredClone([...profiles])
      },
    })
    await boot(fixture)
    check(`50b boot leaves concurrent discovery edit untouched: ${label}`,
      eq(profileState(fixture), stateAfterEdit) && eq(fixture.calls, []),
      JSON.stringify({ profiles: [...fixture.profiles], calls: fixture.calls }))
  }

  // Destination changed while its write awaited: never clean the source.
  for (const [label, edit] of [
    ['delete target', profiles => profiles.delete(targetRoute)],
    ['replace target models', profiles => {
      const target = profiles.get(targetRoute)
      target.models = ['user-replacement']
      target.modelEntries = [{ id: 'user-replacement', customField: 'keep-user-edit' }]
    }],
    ['change target protocol', profiles => {
      profiles.get(targetRoute).api = 'openai-completions'
    }],
    ['repurpose target endpoint', profiles => {
      profiles.get(targetRoute).baseURL = 'https://other.example/v1'
    }],
    ['change target credential reference', profiles => {
      profiles.get(targetRoute).ref = 'OTHER_API_KEY'
    }],
    ['change target routing header', profiles => {
      profiles.get(targetRoute).headers = { 'x-opencode-session': 'user-replacement' }
    }],
    ['edit copied target metadata', profiles => {
      profiles.get(targetRoute).modelEntries[0].customField = { user: 'changed-after-write' }
    }],
  ]) {
    let stateAfterEdit
    const fixture = migrationFixture({
      afterDestination: async profiles => {
        await Promise.resolve()
        edit(profiles)
        stateAfterEdit = structuredClone([...profiles])
      },
    })
    const sourceBefore = structuredClone(fixture.profiles.get(primaryRoute))
    const failed = await rejected(() => boot(fixture))
    check(`50b target readback detects concurrent edit without deleting source: ${label}`,
      failed
        && eq(fixture.profiles.get(primaryRoute), sourceBefore)
        && eq(profileState(fixture), stateAfterEdit)
        && eq(fixture.calls, [['set', targetRoute]]),
      JSON.stringify({ profiles: [...fixture.profiles], calls: fixture.calls }))
  }

  // Nonmigrating primary repair cannot overwrite a changed pending target.
  for (const [label, edit] of [
    ['delete pending target', profiles => profiles.delete(targetRoute)],
    ['replace pending target models', profiles => {
      const target = profiles.get(targetRoute)
      target.models = ['user-replacement']
      target.modelEntries = [{ id: 'user-replacement', customField: 'keep-user-edit' }]
    }],
    ['change parent reference', profiles => {
      profiles.get(parentRoute).ref = 'OTHER_API_KEY'
    }],
  ]) {
    let stateAfterEdit
    const fixture = migrationFixture({
      destination: { id: customEntry.id },
      afterPrimary: async profiles => {
        await Promise.resolve()
        edit(profiles)
        stateAfterEdit = structuredClone([...profiles])
      },
    })
    const primary = fixture.profiles.get(primaryRoute)
    primary.models = ['grok-fixture']
    primary.modelEntries = [{ id: 'grok-fixture' }]
    primary.headers = {}
    const failed = await rejected(() => boot(fixture))
    check(`50b nonmigration second write respects concurrent edit: ${label}`,
      failed
        && eq(profileState(fixture), stateAfterEdit)
        && eq(fixture.calls, [['set', primaryRoute]]),
      JSON.stringify({ profiles: [...fixture.profiles], calls: fixture.calls }))
  }

  // Source changes during direct write: leave both routes intact.
  {
    let stateAfterEdit
    const fixture = migrationFixture({
      afterDestination: async profiles => {
        await Promise.resolve()
        const source = profiles.get(primaryRoute)
        source.models.push('late-user-model')
        source.modelEntries.push({ id: 'late-user-model', customField: 'keep-late-edit' })
        stateAfterEdit = structuredClone([...profiles])
      },
    })
    const failed = await rejected(() => writeCatalogModels(
      fixture.host, { route: parentRoute, ref }, [customEntry.id],
    ))
    check('50b direct migration stops cleanup when source changes during target write',
      failed
        && fixture.profiles.get(primaryRoute)?.models.includes('late-user-model')
        && eq(fixture.profiles.get(targetRoute)?.modelEntries, [customEntry])
        && eq(profileState(fixture), stateAfterEdit)
        && eq(fixture.calls, [['set', targetRoute]]),
      JSON.stringify({ profiles: [...fixture.profiles], calls: fixture.calls }))
  }
  // Inspection, metadata fetch, and picker are all separate async edit windows.
  for (const stage of ['discovery', 'metadata', 'picker']) {
    for (const [label, edit] of [
      ['delete parent', profiles => profiles.delete(parentRoute)],
      ['change parent credential reference', profiles => {
        profiles.get(parentRoute).ref = 'USER_SELECTED_REF'
      }],
      ['delete source', profiles => profiles.delete(primaryRoute)],
      ['add source model', profiles => {
        const source = profiles.get(primaryRoute)
        source.models.push('user-added')
        source.modelEntries.push({ id: 'user-added', customField: 'keep-user-edit' })
      }],
      ['repurpose source endpoint', profiles => {
        profiles.get(primaryRoute).baseURL = 'https://other.example/v1'
      }],
      ['delete target', profiles => profiles.delete(targetRoute)],
      ['add target model', profiles => {
        const target = profiles.get(targetRoute)
        target.models.push('claude-user-added')
        target.modelEntries.push({ id: 'claude-user-added', customField: 'keep-user-edit' })
      }],
      ['repurpose target endpoint', profiles => {
        profiles.get(targetRoute).baseURL = 'https://other.example/anthropic'
      }],
    ]) {
      let stateAfterEdit
      const editAndSnapshot = async profiles => {
        await Promise.resolve()
        edit(profiles)
        stateAfterEdit = structuredClone([...profiles])
      }
      const fixture = migrationFixture({
        destination: customEntry,
        ...(stage === 'discovery' ? { duringDiscovery: editAndSnapshot } : {}),
      })
      const { deps, calls } = makeDeps({
        action: ACTION_SYNC,
        'sync-models': { selected: [customEntry.id] },
      })
      const outcome = await runProviderWizard({
        ...deps,
        host: fixture.host,
        readVendorCatalog: async () => {
          if (stage === 'metadata') await editAndSnapshot(fixture.profiles)
          return {}
        },
        ask: async request => {
          if (stage === 'picker' && request.questions.some(question => question.id === 'sync-models')) {
            await editAndSnapshot(fixture.profiles)
          }
          return deps.ask(request)
        },
      })
      check(`50b stale interactive ${stage} inspection preserves user edit: ${label}`,
        outcome === 'failed' && eq(profileState(fixture), stateAfterEdit)
          && eq(fixture.calls, []) && eq(calls.pushed, []),
        JSON.stringify({ outcome, profiles: [...fixture.profiles], mutations: fixture.calls }))
    }
  }

  // A newly inherited route also invalidates the interactive inspection.
  {
    const fixture = migrationFixture()
    let inheritedAppeared = false
    fixture.host.routeExists = route => fixture.profiles.has(route)
      || (inheritedAppeared && route === targetRoute)
    const before = profileState(fixture)
    const { deps } = makeDeps({ action: ACTION_SYNC, 'sync-models': { selected: [customEntry.id] } })
    const outcome = await runProviderWizard({
      ...deps,
      host: fixture.host,
      readVendorCatalog: async () => {
        inheritedAppeared = true
        return {}
      },
    })
    check('50b interactive inspection detects an inherited route appearing during metadata fetch',
      outcome === 'failed' && eq(profileState(fixture), before) && eq(fixture.calls, []),
      JSON.stringify({ outcome, profiles: [...fixture.profiles], calls: fixture.calls }))
  }

  // Editable rows exclude composition-base routes. Never shadow such a route,
  // including when an empty selection would otherwise attempt to remove it.
  for (const inheritedRoute of [primaryRoute, targetRoute]) {
    for (const selected of [[customEntry.id], []]) {
      const fixture = migrationFixture()
      fixture.profiles.delete(inheritedRoute)
      const inherited = {
        route: inheritedRoute, api: 'openai-responses',
        baseURL: 'https://base.example/v1', apiKeyEnv: 'BASE_ONLY_REF',
        models: [{ id: 'base-model', customField: 'keep-base-entry' }],
      }
      const inheritedBefore = structuredClone(inherited)
      fixture.host.routeExists = route => fixture.profiles.has(route) || route === inheritedRoute
      const before = profileState(fixture)
      const [status] = await inspectCatalogRoutes(fixture.host)
      const directRejected = await rejected(() => writeCatalogModels(
        fixture.host, { route: parentRoute, ref }, selected,
      ))
      await boot(fixture)
      const { deps, calls } = makeDeps({ action: ACTION_SYNC, 'sync-models': { selected } })
      const outcome = await runProviderWizard({ ...deps, host: fixture.host })
      check(`50b inherited-only ${inheritedRoute} refuses selection ${JSON.stringify(selected)}`,
        status.reason === 'derived-conflict' && status.conflictedDerived === inheritedRoute
          && directRejected && outcome === 'cancelled'
          && !calls.asks.includes('sync-models')
          && eq(profileState(fixture), before) && eq(inherited, inheritedBefore)
          && eq(fixture.calls, []),
        JSON.stringify({ outcome, status, profiles: [...fixture.profiles], calls: fixture.calls }))
    }
  }

  // A user-layer models overlay must not hide a repurposed inherited endpoint.
  for (const route of [primaryRoute, targetRoute]) {
    for (const omitted of [['api'], ['baseURL'], ['api', 'baseURL']]) {
      const fixture = migrationFixture({ destination: customEntry })
      const provider = fixture.profiles.get(route)
      for (const field of omitted) delete provider[field]
      const before = profileState(fixture)
      const [status] = await inspectCatalogRoutes(fixture.host)
      const directRejected = await rejected(() => writeCatalogModels(
        fixture.host, { route: parentRoute, ref }, [customEntry.id],
      ))
      await boot(fixture)
      check(`50b partial inherited overlay refuses ${route} missing ${omitted.join('/')}`,
        status.reason === 'derived-conflict' && status.conflictedDerived === route
          && directRejected && eq(profileState(fixture), before) && eq(fixture.calls, []),
        JSON.stringify({ status, profiles: [...fixture.profiles], calls: fixture.calls }))
    }
  }

  // A stopped owner cannot continue a multi-write repair or announce it.
  for (const stage of ['destination', 'primary']) {
    const controller = new AbortController()
    const fixture = migrationFixture({
      mixed: true,
      ...(stage === 'primary' ? { destination: { id: customEntry.id } } : {}),
      ...(stage === 'destination'
        ? { afterDestination: async () => { controller.abort() } }
        : { afterPrimary: async () => { controller.abort() } }),
    })
    if (stage === 'primary') {
      const primary = fixture.profiles.get(primaryRoute)
      primary.models = ['grok-fixture']
      primary.modelEntries = [{ id: 'grok-fixture' }]
      primary.headers = {}
    }
    const sourceBefore = structuredClone(fixture.profiles.get(primaryRoute))
    const targetBefore = structuredClone(fixture.profiles.get(targetRoute))
    const lines = []
    await reportCatalogRoutesQuietly(fixture.host,
      (message, level) => lines.push([level, message]), { signal: controller.signal })
    check(`50b owner unload during ${stage} write stops remaining repair and logs`,
      eq(lines, [])
        && eq(fixture.calls, [['set', stage === 'destination' ? targetRoute : primaryRoute]])
        && (stage === 'destination'
          ? eq(fixture.profiles.get(primaryRoute), sourceBefore)
            && eq(fixture.profiles.get(targetRoute)?.modelEntries, [customEntry])
          : eq(fixture.profiles.get(targetRoute), targetBefore)),
      JSON.stringify({ profiles: [...fixture.profiles], calls: fixture.calls, lines }))
  }

  // Existence can change at an inherited layer without a user-layer row changing.
  for (const stage of ['discovery', 'destination', 'primary']) {
    const existenceOverrides = new Map()
    const options = stage === 'discovery'
      ? { duringDiscovery: async () => { existenceOverrides.set(primaryRoute, false) } }
      : stage === 'destination'
        ? { afterDestination: async () => { existenceOverrides.set(targetRoute, false) } }
        : { destination: { id: customEntry.id },
          afterPrimary: async () => { existenceOverrides.set(targetRoute, false) } }
    const fixture = migrationFixture(options)
    fixture.host.routeExists = route => existenceOverrides.get(route) ?? fixture.profiles.has(route)
    if (stage === 'primary') {
      const primary = fixture.profiles.get(primaryRoute)
      primary.models = ['grok-fixture']
      primary.modelEntries = [{ id: 'grok-fixture' }]
      primary.headers = {}
    }
    const sourceBefore = structuredClone(fixture.profiles.get(primaryRoute))
    const targetBefore = structuredClone(fixture.profiles.get(targetRoute))
    const failed = await rejected(() => boot(fixture))
    check(`50b ${stage} window observes all-layer route existence`,
      failed === (stage !== 'discovery')
        && eq(fixture.calls, stage === 'discovery' ? []
          : [['set', stage === 'destination' ? targetRoute : primaryRoute]])
        && (stage === 'primary'
          ? eq(fixture.profiles.get(targetRoute), targetBefore)
          : eq(fixture.profiles.get(primaryRoute), sourceBefore)),
      JSON.stringify({ profiles: [...fixture.profiles], calls: fixture.calls }))
  }

  // A failed source cleanup leaves a complete destination and is safe to retry.
  {
    const options = { failRemove: primaryRoute }
    const fixture = migrationFixture(options)
    await rejected(() => boot(fixture))
    options.failRemove = undefined
    fixture.calls.length = 0
    await boot(fixture)
    check('50b retry after cleanup failure keeps metadata without rewriting destination',
      !fixture.profiles.has(primaryRoute)
        && eq(fixture.profiles.get(targetRoute)?.modelEntries, [customEntry])
        && eq(fixture.calls, [['remove', primaryRoute]]),
      JSON.stringify({ profiles: [...fixture.profiles], calls: fixture.calls }))
  }

  // Removing a duplicate source does not mean the enabled target was removed.
  {
    const fixture = migrationFixture({ destination: customEntry })
    const result = await writeCatalogModels(fixture.host, { route: parentRoute, ref }, [customEntry.id])
    const noChange = await writeCatalogModels(fixture.host, { route: parentRoute, ref }, [customEntry.id])
    check('50b partial route cleanup reports enabled models rather than all removed',
      result.status === 'written' && eq(result.models, [customEntry.id])
        && noChange.status === 'unchanged' && eq(noChange.models, [customEntry.id]),
      JSON.stringify({ result, noChange }))
  }

  // Selection deduplication and target > source > metadata apply to direct writes.
  {
    const destination = { id: customEntry.id, maxTokens: 999, name: 'Destination choice' }
    const fixture = migrationFixture({ destination })
    const result = await writeCatalogModels(fixture.host, { route: parentRoute, ref },
      [customEntry.id, customEntry.id], new Map([[customEntry.id, {
        name: 'Vendor name', maxTokens: 1, contextWindow: 1,
      }]]))
    check('50b direct migration deduplicates and preserves target then source precedence',
      eq(result.models, [customEntry.id])
        && eq(fixture.profiles.get(targetRoute)?.modelEntries, [{
          name: destination.name, maxTokens: destination.maxTokens,
          contextWindow: customEntry.contextWindow,
          ...customEntry, ...destination,
        }]),
      JSON.stringify({ result, profiles: [...fixture.profiles] }))
  }
}

// 51. Without a configured catalog route that has a vendor listing, the
// action question stays exactly two options (the optional-branch contract).
{
  const { deps, calls } = makeDeps({ 'action': ACTION_ADD, 'mode': MODE_CATALOG, 'catalog': { selected: ['deepseek'] } }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: false, isCatalog: true }],
  })
  await runProviderWizard(deps)
  check('51 action menu: no management option without a live target route',
    !calls.optionDescriptions.action?.[t('provider-opt-action-sync')]
      && Boolean(calls.optionDescriptions.action?.[t('provider-opt-action-add')]),
    JSON.stringify(calls.optionDescriptions.action))

  const syncable = makeDeps({ 'action': ACTION_SYNC, 'sync-models': { selected: [] } }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [{ route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] }],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    discover: request => request.provider !== undefined ? [{ id: 'glm-5.3' }] : [{ id: 'glm-5.3' }],
  })
  await runProviderWizard(syncable.deps)
  check('51 action menu: a live-target catalog route adds the management option',
    syncable.calls.optionDescriptions.action?.[t('provider-opt-action-sync')] === t('provider-opt-action-sync-desc'),
    JSON.stringify(syncable.calls.optionDescriptions.action))
}

// 52. Connecting a catalog route reports the vendor's extras (and their
// derived route) in the model question, and enables nothing by itself.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': { selected: ['opencode-go'] },
    'apikey': { custom: 'sk-zen' },
    'baseurl-choice': SKIP_BASEURL,
    'models': { selected: ['glm-5.3'] },
    'confirm': CONFIRM_WRITE,
    'switch': KEEP_MODEL,
  }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : [{ id: 'glm-5.3' }, { id: 'longcat-2.5-preview-free' }],
  })
  const outcome = await runProviderWizard(deps)
  check('52 connect: outcome added', outcome === 'added', outcome)
  check('52 connect: the catalog route probes its vendor listing without a stored baseURL',
    eq(calls.discoverRequests, [
      { provider: 'opencode-go' },
      { baseURL: 'https://opencode.ai/zen/go/v1', api: 'openai-completions', apiKey: 'sk-zen' },
    ]), JSON.stringify(calls.discoverRequests))
  check('52 connect: the vendor-only ids are reported as a question detail, never as options',
    calls.details.models === t('provider-catalog-vendor-note', {
      n: 1,
      models: 'longcat-2.5-preview-free',
      derived: 'opencode-go-live, opencode-go-live-anthropic',
    }) && calls.optionDescriptions.models?.['longcat-2.5-preview-free'] === undefined,
    JSON.stringify({ detail: calls.details.models, options: Object.keys(calls.optionDescriptions.models ?? {}) }))
  check('52 connect: the catalog profile pins only the selected snapshot model',
    eq(calls.profiles, [['opencode-go', { apiKeyEnv: 'OPENCODE_GO_API_KEY', models: [{ id: 'glm-5.3' }] }]]),
    JSON.stringify(calls.profiles))
  check('52 connect: nothing is enabled on the derived route behind the user\'s back',
    eq(calls.mutations, []), JSON.stringify(calls.mutations))
}

// 53. The vendor listing is unreachable while connecting: the snapshot note
// stays, the live-probe failure is surfaced once, and the connect succeeds.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': { selected: ['opencode-go'] },
    'apikey': { custom: 'sk-zen' },
    'baseurl-choice': SKIP_BASEURL,
    'models': { selected: ['glm-5.3'] },
    'confirm': CONFIRM_WRITE,
    'switch': KEEP_MODEL,
  }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }]
      : Promise.reject(new Error('connection refused')),
  })
  const outcome = await runProviderWizard(deps)
  check('53 connect offline: outcome added', outcome === 'added', outcome)
  check('53 connect offline: the question falls back to the snapshot note',
    calls.details.models === t('provider-catalog-snapshot-note', { n: 1 }),
    JSON.stringify(calls.details.models))
  check('53 connect offline: the live-probe failure is surfaced',
    calls.notifications.some(n => n.color === 'warning' && n.text === t('provider-live-fetch-failed'))
      && eq(calls.mutations, []),
    JSON.stringify({ notifications: calls.notifications, mutations: calls.mutations }))
}

// 54. Editing such a route's model list shows the same vendor note, and the
// vendor-only ids stay unselectable (the catalog route cannot carry them).
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['opencode-go'] },
    'edit-menu': MENU_MODELS,
    'models': { selected: ['glm-5.3', 'glm-5.2'] },
  }, {
    catalogProviders: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
    configured: [{ route: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', shadowed: false, isCatalog: true, models: ['glm-5.3'] }],
    storedCredentials: { OPENCODE_GO_API_KEY: 'sk-zen' },
    discover: request => request.provider !== undefined
      ? [{ id: 'glm-5.3' }, { id: 'glm-5.2' }]
      : [{ id: 'glm-5.3' }, { id: 'glm-5.2' }, { id: 'longcat-2.5-preview-free' }],
  })
  const outcome = await runProviderWizard(deps)
  check('54 edit with vendor extras: outcome updated', outcome === 'updated', outcome)
  check('54 edit with vendor extras: the note names the derived route',
    calls.details.models === t('provider-catalog-vendor-note', {
      n: 1,
      models: 'longcat-2.5-preview-free',
      derived: 'opencode-go-live, opencode-go-live-anthropic',
    }), JSON.stringify(calls.details.models))
  check('54 edit with vendor extras: only catalog-covered ids are selectable',
    eq(Object.keys(calls.optionDescriptions.models ?? {}).sort(), ['glm-5.2', 'glm-5.3']),
    JSON.stringify(Object.keys(calls.optionDescriptions.models ?? {})))
  check('54 edit with vendor extras: the catalog route keeps its own shape',
    eq(calls.mutations, [['opencode-go', [{ op: 'set', path: ['models'], value: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }] }]]]),
    JSON.stringify(calls.mutations))
}

console.log(failed === 0 ? '\nAll provider-wizard checks passed' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)

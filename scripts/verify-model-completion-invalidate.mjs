/**
 * Headless regression for `/model <provider/id>` completion cache invalidation.
 *
 * The completion list is a session-lifetime channel cache (modelNodeCache):
 * `commandCompletions('/model …')` warms it once and serves the snapshot
 * synchronously until something invalidates it. A `/provider` catalog change
 * (add / edit / delete / OAuth sign-in-out) must invalidate it — otherwise a
 * deleted provider keeps showing up in `/model` completion until a model
 * switch or a restart (the reported bug), and an added one stays invisible.
 *
 * Pins the contract:
 *   1. the cache warms across every registered provider;
 *   2. without invalidation the snapshot is stale after the catalog shrinks
 *      (the buggy behavior this regression exists to catch);
 *   3. `channel.invalidateModelCompletion()` drops the cache synchronously;
 *   4. the next `/model ` keystroke refetches the fresh catalog — the
 *      deleted provider is gone, the survivor is listed;
 *   5. model-ID prefixes match without a provider prefix and insert the
 *      canonical provider/model route (including on collisions);
 *   6. fuzzy subsequence queries match (`dsv4.1` → `volceapi/deepseek-v4.1-flash`)
 *      and prefix hits rank above fuzzy hits, in catalog order within a tier.
 *   7. the real boot catalog pass invalidates prewarmed routes after a repair
 *      or a partial write failure, but leaves an unloaded owner's cache alone.
 *
 * Run with plain node against the compiled lib (after `pnpm build`):
 * `node scripts/verify-model-completion-invalidate.mjs`
 */
import { createChannel } from '../lib/types/dsh-adapter/channel.js'
import { reportCatalogModelsAtBoot } from '../lib/types/dsh-adapter/plugin.js'
import { completeCommands } from '../lib/types/commands.js'
import { settled } from './lib/term-test.mjs'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The `llm` service seam the channel reads: the provider set is a live
// variable so the test can "delete" a provider by shrinking the catalog —
// the same observable the dsh-llm-pi-ai adapter produces when a profile is
// unset from the `llm-pi-ai` settings section.
let providerCatalog = [
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'my-gateway', name: 'My Gateway' },
  { id: 'volceapi', name: 'Volce API' },
]
const llmStub = {
  listProviders() {
    return providerCatalog.map(entry => ({ id: entry.id, name: entry.name }))
  },
  listModels(provider) {
    if (provider === 'deepseek') return Promise.resolve([{ provider, id: 'ds-1', name: 'DeepSeek 1' }])
    if (provider === 'my-gateway') return Promise.resolve([{ provider, id: 'gw-1', name: 'Gateway 1' }])
    if (provider === 'volceapi') return Promise.resolve([{ provider, id: 'glm-5.3', name: 'GLM 5.3' }, { provider, id: 'ds-2', name: 'DeepSeek 2' }, { provider, id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }])
    return Promise.resolve([])
  },
}

const handlers = new Map()
const ctx = {
  on(event, handler) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  get(service) {
    return service === 'llm' ? llmStub : undefined
  },
  logger: { warn() {} },
}

const stubAgentCtx = { on: () => () => {} }
const agent = {
  id: 'a1',
  status: 'idle',
  session: { id: 's1', seq: 0, events: [] },
  ctx: stubAgentCtx,
  followup() {},
  steer() {},
  inbox: { remove() { return true } },
}

const channel = createChannel(ctx, agent, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
})

const completionNames = input => channel.commandCompletions(input).map(node => node.name)
const has = (names, spec) => names.some(name => name.endsWith(` ${spec}`))

// 1. Warm the session-lifetime cache across every registered provider.
check('completion warms all providers', await settled(() => {
  const names = completionNames('/model ')
  return names.length === 5 && has(names, 'my-gateway/gw-1') && has(names, 'deepseek/ds-1') && has(names, 'volceapi/glm-5.3') && has(names, 'volceapi/deepseek-v4.1-flash')
}, { timeoutMs: 4000 }), JSON.stringify(completionNames('/model ')))

const completions = input => channel.commandCompletions(input)
check('model ID prefix finds full route without provider',
  completions('/model GLM-5').length === 1
  && completions('/model GLM-5')[0].replacement === '/model volceapi/glm-5.3 ')
check('prefix hits rank above fuzzy hits in catalog order',
  JSON.stringify(completions('/model ds-').map(node => node.replacement))
    === JSON.stringify(['/model deepseek/ds-1 ', '/model volceapi/ds-2 ', '/model volceapi/deepseek-v4.1-flash ']))
check('fuzzy subsequence matches across provider and model segments',
  JSON.stringify(completions('/model dsv4.1').map(node => node.replacement))
    === JSON.stringify(['/model volceapi/deepseek-v4.1-flash ']))
check('fuzzy subsequence matches provider initials',
  JSON.stringify(completions('/model vd4').map(node => node.replacement))
    === JSON.stringify(['/model volceapi/deepseek-v4.1-flash ']))
check('fuzzy subsequence matches non-contiguous suffix text',
  JSON.stringify(completions('/model 5.3').map(node => node.replacement))
    === JSON.stringify(['/model volceapi/glm-5.3 ']))
check('full provider prefix still works',
  completionNames('/model volceapi/glm-').join(',') === 'model volceapi/glm-5.3')
check('text absent from every route does not match',
  completions('/model zz9').length === 0)
check('model ID matching stays scoped to /model',
  completeCommands('/preset ds-', [{ name: 'preset', description: '' }], () => [
    { name: 'volceapi/ds-2', description: '' },
  ]).length === 0)

// 2. The catalog shrinks: `/provider` deleted my-gateway. The cache is
//    session-lifetime, so without invalidation the stale snapshot lingers —
//    exactly the reported bug (deleted provider still visible in /model).
providerCatalog = providerCatalog.filter(entry => entry.id !== 'my-gateway')
check('stale snapshot still lists the deleted provider until invalidated',
  has(completionNames('/model '), 'my-gateway/gw-1'))

// 3. The fix: the catalog-changing path calls invalidateModelCompletion().
//    The cache is dropped synchronously — the next keystroke refetches.
channel.invalidateModelCompletion()
check('invalidateModelCompletion drops the cache synchronously',
  completionNames('/model ').length === 0, JSON.stringify(completionNames('/model ')))

// 4. The next `/model ` keystroke refetches the fresh catalog: the deleted
//    provider is gone, the survivor is listed.
check('completion refetches without the deleted provider', await settled(() => {
  const names = completionNames('/model ')
  return names.length === 4 && has(names, 'deepseek/ds-1') && has(names, 'volceapi/deepseek-v4.1-flash') && !has(names, 'my-gateway/gw-1')
}, { timeoutMs: 4000 }), JSON.stringify(completionNames('/model ')))

// rc.2 marks only the two official Flash labels; catalog names and route IDs
// stay untouched, including aliases and third-party providers with the same ID.
const { installedMeetsVersion } = await import('../lib/types/dsh-adapter/contract.js')
if (installedMeetsVersion('@deepseek-ai/dsh-web-app', '0.2.1-rc.2')) {
  providerCatalog = ['deepseek-official', 'deepseek-account', 'custom'].map(id => ({ id, name: id }))
  const catalog = providerCatalog.flatMap(({ id: provider }) => [
    Object.freeze({ provider, id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }),
    Object.freeze({ provider, id: 'deepseek-pro', name: 'DeepSeek-V4.1-Pro' }),
    Object.freeze({ provider, id: 'flash-alias', name: 'DeepSeek-V4.1-Flash' }),
  ])
  llmStub.listModels = async provider => catalog.filter(model => model.provider === provider)
  const models = await channel.listModels()
  const markedRoutes = models.filter(model => model.name.endsWith(' 1017')).map(model => `${model.provider}/${model.id}`).sort()
  check('1017 labels only mark the two official Flash routes', JSON.stringify(markedRoutes) === JSON.stringify([
    'deepseek-account/deepseek-flash', 'deepseek-official/deepseek-flash',
  ]), JSON.stringify(markedRoutes))
  check('display marking preserves model route identities', models.every((model, index) => model.id === catalog[index].id && model.provider === catalog[index].provider))
  check('display marking never modifies the shared catalog', catalog.every(model => !model.name.includes('1017')))
  channel.invalidateModelCompletion()
  check('model completion shows the same release label', await settled(() => channel.commandCompletions('/model ')
    .some(node => node.name.endsWith('deepseek-account/deepseek-flash') && node.description === 'DeepSeek-V4.1-Flash 1017')))
}

// Boot can migrate an enabled model to another provider route while the user
// has already warmed /model. Exercise the real orchestration helper against a
// live settings map and the channel's actual completion cache, not a copied fix.
{
  const parent = 'opencode-go'
  const source = 'opencode-go-live'
  const target = 'opencode-go-live-anthropic'
  const model = 'claude-cache-fixture'
  const ref = 'OPENCODE_GO_API_KEY'
  function bootFixture(options = {}) {
    const profiles = new Map([
      [parent, { route: parent, ref, shadowed: false, isCatalog: true,
        models: ['catalog-model'], modelEntries: [{ id: 'catalog-model' }] }],
      [source, { route: source, ref, shadowed: false, isCatalog: false,
        api: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1',
        models: [model], modelEntries: [{ id: model, customField: { keep: true } }],
        headers: { 'x-opencode-session': 'cache-source-session' } }],
    ])
    const discovery = Promise.withResolvers()
    const controller = new AbortController()
    const observed = { discoveryStarted: false, invalidations: 0, writes: [], logs: [] }
    const llm = {
      listProviders: () => [...profiles.keys()].map(id => ({ id, name: id })),
      listModels: async provider => (profiles.get(provider)?.modelEntries ?? [])
        .map(entry => ({ ...entry, provider, name: entry.id })),
    }
    const ctx = {
      on: () => () => {},
      get: service => service === 'llm' ? llm : undefined,
      logger: { warn() {} },
    }
    const channel = createChannel(ctx, { ...agent, id: `boot-${options.mode}` }, {
      model: 'catalog-model', cwd: '/tmp', provider: parent, activity: false,
    })
    const host = {
      listCatalogProviders: () => [{ provider: parent, displayName: 'OpenCode Go' }],
      listConfiguredProviders: () => [...profiles.values()],
      routeExists: route => profiles.has(route),
      envShadows: () => false,
      readCredential: async () => 'synthetic-key',
      discoverModels: async request => {
        if (request.provider !== undefined) return [{ id: 'catalog-model' }]
        observed.discoveryStarted = true
        await discovery.promise
        return [{ id: 'catalog-model' }, { id: model }]
      },
      mutateProfile: async (route, ops) => {
        observed.writes.push(['set', route])
        const provider = { route, ref, shadowed: false, isCatalog: false, ...profiles.get(route) }
        for (const op of ops) {
          if (op.path[0] === 'models') {
            provider.models = op.value.map(entry => entry.id)
            provider.modelEntries = structuredClone(op.value)
          } else if (op.path[0] === 'apiKeyEnv') provider.ref = op.value
          else provider[op.path[0]] = structuredClone(op.value)
        }
        profiles.set(route, provider)
        if (options.mode === 'abort-during-write') controller.abort()
      },
      removeProfile: async route => {
        observed.writes.push(['remove', route])
        if (options.mode === 'cleanup-failure') throw new Error('synthetic cleanup failure')
        profiles.delete(route)
      },
    }
    const run = () => reportCatalogModelsAtBoot({
      providerSetup: () => host,
      invalidateModelCompletion: () => {
        observed.invalidations += 1
        channel.invalidateModelCompletion()
      },
    }, (message, level) => observed.logs.push([level, message]), controller.signal)
    return { channel, profiles, discovery, controller, observed, run }
  }

  {
    const owner = new AbortController()
    owner.abort()
    let accesses = 0
    let invalidations = 0
    await reportCatalogModelsAtBoot({
      providerSetup: () => { accesses += 1; return undefined },
      invalidateModelCompletion: () => { invalidations += 1 },
    }, () => {}, owner.signal)
    check('boot skips an already unloaded channel without touching its provider seam',
      accesses === 0 && invalidations === 0)
    await reportCatalogModelsAtBoot({
      providerSetup: () => undefined,
      invalidateModelCompletion: () => { invalidations += 1 },
    }, () => {}, new AbortController().signal)
    check('boot without a provider host does not invalidate the cache', invalidations === 0)
  }

  for (const mode of ['success', 'cleanup-failure', 'abort-during-discovery', 'abort-during-write']) {
    const fixture = bootFixture({ mode })
    const names = () => fixture.channel.commandCompletions('/model ').map(node => node.name)
    check(`boot ${mode}: warm the original route before discovery`, await settled(() =>
      has(names(), `${source}/${model}`) && !has(names(), `${target}/${model}`)))
    const selectedBefore = [fixture.channel.provider, fixture.channel.model]
    // Attach the rejection handler immediately: cleanup failure is intentional.
    const pending = fixture.run().then(() => undefined, error => error)
    check(`boot ${mode}: discovery really waits while completion remains warm`, await settled(() =>
      fixture.observed.discoveryStarted && has(names(), `${source}/${model}`)))
    if (mode === 'abort-during-discovery') fixture.controller.abort()
    fixture.discovery.resolve()
    const error = await pending
    const isAborted = mode.startsWith('abort-')
    check(`boot ${mode}: completion invalidation follows owner lifetime`,
      fixture.observed.invalidations === (isAborted ? 0 : 1),
      JSON.stringify(fixture.observed))
    check(`boot ${mode}: no automatic model switch`,
      JSON.stringify([fixture.channel.provider, fixture.channel.model]) === JSON.stringify(selectedBefore))
    if (isAborted) {
      check(`boot ${mode}: late result does not refresh or log for the unloaded owner`,
        error === undefined && has(names(), `${source}/${model}`) && !has(names(), `${target}/${model}`)
          && fixture.observed.logs.length === 0
          && JSON.stringify(fixture.observed.writes) === JSON.stringify(mode === 'abort-during-write'
            ? [['set', target]] : []),
        JSON.stringify(fixture.observed))
    } else {
      check(`boot ${mode}: expected completion or partial failure`,
        mode === 'cleanup-failure' ? error?.message === 'synthetic cleanup failure' : error === undefined,
        String(error ?? 'completed'))
      check(`boot ${mode}: cache is dropped synchronously`, names().length === 0)
      check(`boot ${mode}: next completion reflects the actual repaired profiles`, await settled(() =>
        has(names(), `${target}/${model}`)
          && has(names(), `${source}/${model}`) === (mode === 'cleanup-failure')),
        JSON.stringify(names()))
    }
  }
}

if (failed === 0) {
  console.log('verify-model-completion-invalidate: all checks passed')
} else {
  console.error(`verify-model-completion-invalidate: ${failed} FAILURE(S)`)
}
process.exit(failed === 0 ? 0 : 1)

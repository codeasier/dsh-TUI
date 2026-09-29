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
 *      canonical provider/model route (including on collisions).
 *
 * Run with plain node against the compiled lib (after `pnpm build`):
 * `node scripts/verify-model-completion-invalidate.mjs`
 */
import { createChannel } from '../lib/types/dsh-adapter/channel.js'
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
    if (provider === 'volceapi') return Promise.resolve([{ provider, id: 'glm-5.3', name: 'GLM 5.3' }, { provider, id: 'ds-2', name: 'DeepSeek 2' }])
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
  return names.length === 4 && has(names, 'my-gateway/gw-1') && has(names, 'deepseek/ds-1') && has(names, 'volceapi/glm-5.3')
}, { timeoutMs: 4000 }), JSON.stringify(completionNames('/model ')))

const completions = input => channel.commandCompletions(input)
check('model ID prefix finds full route without provider',
  completions('/model GLM-5').length === 1
  && completions('/model GLM-5')[0].replacement === '/model volceapi/glm-5.3 ')
check('shared model ID prefix keeps both provider routes',
  JSON.stringify(completions('/model ds-').map(node => node.replacement))
    === JSON.stringify(['/model deepseek/ds-1 ', '/model volceapi/ds-2 ']))
check('full provider prefix still works',
  completionNames('/model volceapi/glm-').join(',') === 'model volceapi/glm-5.3')
check('non-prefix model ID text does not match',
  completions('/model 5.3').length === 0)
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
  return names.length === 3 && has(names, 'deepseek/ds-1') && has(names, 'volceapi/glm-5.3') && !has(names, 'my-gateway/gw-1')
}, { timeoutMs: 4000 }), JSON.stringify(completionNames('/model ')))

if (failed === 0) {
  console.log('verify-model-completion-invalidate: all checks passed')
} else {
  console.error(`verify-model-completion-invalidate: ${failed} FAILURE(S)`)
}
process.exit(failed === 0 ? 0 : 1)

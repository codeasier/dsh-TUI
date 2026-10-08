/**
 * DSH session events and stream frames through the DSH translator
 * (`../backend/translate.ts`) into the shared projector
 * (`src/channel/projection.ts`), behind one `renderEvent` /
 * `renderStreamFrame` / `replayEvents` surface. The channel wires the two
 * halves itself; regression scripts that feed raw DSH events use this.
 */
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SelectionAttachment } from '../../adapter/ports/channel-view.js'
import { createChannelProjection as createSharedProjection, type ProjectionState } from '../../channel/projection.js'
import type { BackgroundJobStore } from '../jobs.js'
import type { TuiRendererHost } from '../renderers.js'
import { createDshTranslator, dshPricingWindow } from '../backend/translate.js'
import { parseJobOutputId, toolCommandOf, toolDescriptionOf, BACKGROUND_START_ACK, BACKGROUND_PROMOTED_ACK } from './projection-helpers.js'
import type { InputConvergence } from './input-actions.js'
import type { ChannelState, ToolsRegistryLike } from './types.js'

interface ProjectionDependencies {
 agent(): Agent
 rowIds: { value: number }
 resetContextWarning(): void
 jobs: Pick<BackgroundJobStore, 'onOutputSeen' | 'onStarted'>
 inputConvergence: Pick<InputConvergence, 'cancelInFlight'>
 checkContextWarning(): void
 notify: ChannelState['notify']
 tools?: ToolsRegistryLike
 renderer?: TuiRendererHost
 /** DSH attachment service, resolved at call time (a late-mounted provider
  *  must still serve images for rows projected earlier). */
 attachments(): unknown
 /** What a submitted message's IDE selection attached (keyed by the message
  *  id the durable event carries), for the user row's indicator line. */
 selectionAttached(messageId: string): SelectionAttachment | undefined
}

const LIVE = { replay: false } as const
const REPLAY = { replay: true } as const

/** One reducer for both durable replay and live session events. */
export function createChannelProjection(state: ProjectionState, deps: ProjectionDependencies) {
  const translator = createDshTranslator({
    tools: () => deps.tools,
    scope: () => deps.agent(),
    attachments: () => deps.attachments(),
  })

  /** Native and nested PTC calls share durable job hand-off/output semantics. */
  const projectJobResult = (name: string, argsFull: string | undefined, result: string, at: number): void => {
    if (name === 'job_output') {
      const id = parseJobOutputId(argsFull)
      if (id !== undefined) {
        deps.jobs.onStarted(id)
        deps.jobs.onOutputSeen(id, result, at)
      }
    }
    // Membership in the runtime registry includes foreground shell work;
    // only an explicit start or timeout hand-off exposes an independent job.
    const startAck = BACKGROUND_START_ACK.exec(result)
      ?? (name === 'bash' || name === 'pwsh' ? BACKGROUND_PROMOTED_ACK.exec(result) : null)
    if (startAck !== null) deps.jobs.onStarted(
      startAck[1],
      toolCommandOf(argsFull),
      name === 'bash' || name === 'pwsh' ? toolDescriptionOf(argsFull) : undefined,
    )
  }

  /** Nested PTC calls have no ordinary tool card. Consume their plugin-owned
   *  outcome structurally, keeping dsh-tools out of the runtime peer surface:
   *  the translator has no vocabulary for them, so the job-registry side
   *  effects are applied here, in stream order, beside the shared projector. */
  const applyPtcDispatch = (event: SessionEvent): void => {
    if ((event as { type: string }).type !== 'tool/ptc-dispatch') return
    const data = (event as unknown as { data: {
      name: string
      arguments: unknown
      content: readonly { type: string; text?: string }[]
      isError: boolean
      error?: unknown
    } }).data
    if (data.isError || data.error !== undefined) return
    const text = (data.content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('').trim()
    projectJobResult(data.name, JSON.stringify(data.arguments), text, event.time ?? Date.now())
  }

  const projector = createSharedProjection(state, {
    rowIds: deps.rowIds,
    resetContextWarning: () => deps.resetContextWarning(),
    checkContextWarning: () => deps.checkContextWarning(),
    notify: (...args) => deps.notify(...args),
    jobs: deps.jobs,
    inputConvergence: deps.inputConvergence,
    renderer: deps.renderer,
    selectionAttached: messageId => deps.selectionAttached(messageId),
    pricingWindow: dshPricingWindow,
  })
  return {
    /** Forget every per-session ledger on both halves. */
    reset(): void {
      translator.reset()
      projector.reset()
    },
    replayEvents(events: readonly SessionEvent[]): void {
      for (const event of events) applyPtcDispatch(event)
      projector.apply(translator.translateReplay(events), REPLAY)
    },
    renderEvent(event: SessionEvent): void {
      applyPtcDispatch(event)
      projector.apply(translator.translateEvent(event), LIVE)
    },
    renderStreamFrame(frame: AssistantStreamFrame): void {
      projector.apply(translator.translateFrame(frame), LIVE)
    },
    settleStreaming: projector.settleStreaming,
    updateSpinnerMode: projector.updateSpinnerMode,
  }
}

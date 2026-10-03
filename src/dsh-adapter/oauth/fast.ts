import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { t } from '../../i18n.js'

/** Process-local OAuth service tier; changes affect the next request, never effort or persisted configuration. */
export function createFastControl(initialTier: string | undefined, supportsFast: () => boolean): {
  getServiceTier(): string | undefined
  handler(invocation: CommandInvocation): Promise<CommandResult>
} {
  let tier = initialTier

  return {
    getServiceTier: () => tier,
    handler: async invocation => {
      if (invocation.signal?.aborted) return { kind: 'error', text: t('fast-cancelled') }
      const supported = supportsFast()
      if (invocation.signal?.aborted) return { kind: 'error', text: t('fast-cancelled') }
      if (!supported) return { kind: 'error', text: t('fast-unsupported') }

      const words = invocation.rawInput.trim().split(/\s+/u).filter(Boolean)
      const verb = words[0]?.toLowerCase() ?? 'toggle'
      if (words.length > 1 || !['toggle', 'on', 'off', 'status'].includes(verb)) {
        return { kind: 'error', text: t('fast-usage') }
      }

      if (verb === 'toggle') tier = tier === 'priority' ? 'default' : 'priority'
      else if (verb === 'on') tier = 'priority'
      else if (verb === 'off') tier = 'default'

      const actualTier = tier ?? t('fast-provider-default')
      const summary = verb === 'status'
        ? t('fast-status', { state: t(tier === 'priority' ? 'fast-enabled' : 'fast-disabled'), tier: actualTier })
        : t(tier === 'priority' ? 'fast-on' : 'fast-off', { tier: actualTier })
      return { kind: 'success', text: `${summary}\n${t('fast-scope')}` }
    },
  }
}

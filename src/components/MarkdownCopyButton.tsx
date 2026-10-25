import React from 'react'
import type { Tokens } from 'marked'
import { NoSelect, Text, useTerminalSize } from '../ui.js'
import { TerminalWriteContext } from '../ink/useTerminalNotification.js'
import { setClipboard } from '../ink/termio/osc.js'
import { stringWidth } from '../ink/stringWidth.js'
import { codeLanguageTag } from '../terminal-utils/markdown.js'
import { getLang, subscribeLang, t } from '../i18n.js'
import { isMouseClicksDisabled } from '../utils/fullscreen.js'

/** Only mouse-enabled transcript hosts expose block-copy actions. Inline
 * output keeps its native selection and does not show inert buttons. */
export const MarkdownCopyContext = React.createContext(false)

/** Copy token source, not painted cells: code keeps its whitespace and tables
 * keep their Markdown syntax, independently of wrapping or narrow layouts. */
export function MarkdownCopyButton({ token }: { token: Tokens.Code | Tokens.Table }): React.ReactNode {
  const enabled = React.useContext(MarkdownCopyContext)
  const writeRaw = React.useContext(TerminalWriteContext)
  const { columns } = useTerminalSize()
  React.useSyncExternalStore(subscribeLang, getLang)
  const code = token.type === 'code'
  const text = code ? token.text : token.raw
  const label = t(code ? 'markdown-copy-code' : 'markdown-copy-table')
  const copied = t('markdown-copy-done')
  const failed = t('markdown-copy-failed')
  const width = Math.max(...[label, copied, failed].map(stringWidth)) + 2
  const [feedback, setFeedback] = React.useState<{ text: string; ok: boolean } | null>(null)
  const request = React.useRef(0)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => {
    request.current++
    clearTimeout(timer.current)
  }, [])

  // Never cover the code caption or put a button over the ANSI fallback's
  // body. Tables get their own action row: their first row may be real data
  // in the narrow key/value layout, not a decorative border.
  const captionWidth = code ? stringWidth('┌─ ' + (codeLanguageTag(token) || 'code')) : 0
  if (!enabled || isMouseClicksDisabled() || writeRaw === null || text === '' ||
      columns < width + captionWidth + 2 || (code && columns < 14)) return null

  const result = feedback?.text === text ? feedback : null
  const caption = '[' + (result === null ? label : result.ok ? copied : failed) + ']'
  return (
    <NoSelect
      position={code ? 'absolute' : undefined}
      top={code ? 0 : undefined}
      right={code ? 1 : undefined}
      marginRight={code ? undefined : 1}
      alignSelf="flex-end"
      width={width}
      height={1}
      flexShrink={0}
      // Capture gestures only on the chip: multi-click must not select and
      // auto-copy its feedback label. A drag cancels the click instead.
      onDragStart={event => { event.stopImmediatePropagation() }}
      onClick={event => {
        event.stopImmediatePropagation()
        if (event.shift || event.alt || event.ctrl) return
        const id = ++request.current
        clearTimeout(timer.current)
        const finish = (ok: boolean): void => {
          if (request.current !== id) return
          setFeedback({ text, ok })
          timer.current = setTimeout(() => { setFeedback(null) }, 1500)
        }
        void setClipboard(text).then(raw => {
          if (request.current !== id) return
          writeRaw(raw)
          finish(true)
        }).catch(() => { finish(false) })
      }}
    >
      <Text color={result === null ? 'subtle' : result.ok ? 'success' : 'error'} wrap="truncate-end">
        {caption + ' '.repeat(width - stringWidth(caption))}
      </Text>
    </NoSelect>
  )
}

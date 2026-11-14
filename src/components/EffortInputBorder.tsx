/**
 * Filled composer surface with a heavy accent rail. The permanent top and
 * bottom rows preserve the prompt's height and suggestion-overlay anchor.
 * Effort ignition pulses the rail while EffortTierBadge handles the tier name;
 * only colours change, and the shared clock is subscribed only while active.
 */
import React, { useContext, useEffect, useReducer, useState } from 'react'
import { Box, Text, useTheme } from '../ui.js'
import { ClockContext } from '../ink/components/ClockContext.js'
import type { Color } from '../ink/styles.js'
import type { Theme } from '../theme.js'
import { IGNITION_TIMELINE, ignitionColors, ignitionLineColors } from '../trajectory/effortIgnition.js'

type Overlay = { label: string; startedAtMs: number }

/** A static chip on the top padding row used for the session label. */
export interface InputBorderLabel {
  /** Visible text (already width-truncated by the caller). */
  text: string
  /** Chip background (theme token or raw color). */
  color: keyof Theme | Color
  /** Chip foreground (theme token or raw color). */
  ink: keyof Theme | Color
}

export function EffortInputBorder({
  effort,
  levels,
  columns,
  onLight: _onLight,
  idleColor,
  topRightLabel,
  children,
}: {
  /** 当前思考强度档 id；`undefined` 表示路线未声明。 */
  effort: string | undefined
  /** 当前路线的档位表（低→高，末位为最高档）；未知时传 `undefined`。 */
  levels: readonly string[] | undefined
  columns: number
  /** Ignition colours now follow the active palette (brand-aware); the
   *  historical light-surface hint is accepted and ignored. */
  onLight: boolean
  /** 静止边框色（主题 token 名，如 'promptBorder' / 'planMode'）。 */
  idleColor: keyof Theme | Color
  /** 顶部留白右侧的静态标签 chip（会话名标签）；undefined = 不显示。 */
  topRightLabel?: InputBorderLabel
  children: React.ReactNode
}): React.ReactNode {
  const clock = useContext(ClockContext)
  const [themeName] = useTheme()
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [prevEffort, setPrevEffort] = useState(effort)
  const [, forceRender] = useReducer((tick: number) => tick + 1, 0)

  // 渲染期触发：effort 变化的首帧就以新状态渲染（effect 会晚一帧）。
  if (effort !== prevEffort) {
    setPrevEffort(effort)
    if (
      clock !== null &&
      effort !== undefined &&
      levels !== undefined &&
      levels.length > 1 &&
      effort === levels[levels.length - 1]
    ) {
      setOverlay({ label: effort.toUpperCase(), startedAtMs: clock.now() })
    }
  }

  // 仅动画窗口订阅共享时钟；静止边框零定时器零重渲染。
  const elapsedMs =
    overlay === null ? Infinity : Math.max(0, (clock?.now() ?? Date.now()) - overlay.startedAtMs)
  useEffect(() => {
    if (overlay === null || clock === null) return
    return clock.subscribe(() => forceRender(), /* keepAlive */ true)
  }, [overlay, clock])
  useEffect(() => {
    if (overlay !== null && elapsedMs >= IGNITION_TIMELINE.fadeEndMs) setOverlay(null)
  }, [overlay, elapsedMs])

  // Sample the travelling wave at its midpoint: the same effort timeline now
  // lights the vertical rail rather than drawing a horizontal frame. The
  // sweep pair comes from the active palette (brand- and surface-aware).
  const sweepWidth = Math.max(1, columns - 2)
  const railColor = overlay !== null && elapsedMs < IGNITION_TIMELINE.sweepMs
    ? (ignitionLineColors({ elapsedMs, width: sweepWidth, colors: ignitionColors(themeName) })[Math.floor(sweepWidth / 2)] as Color | undefined) ?? idleColor
    : idleColor

  return (
    <Box
      flexDirection="column"
      width="100%"
      flexShrink={0}
      backgroundColor="userPromptBackground"
      borderStyle="bold"
      borderColor={railColor}
      borderTop={false}
      borderBottom={false}
      borderRight={false}
    >
      <Box height={1} flexShrink={0} justifyContent="flex-end" paddingRight={3} overflow="hidden">
        {topRightLabel !== undefined && (
          <Text backgroundColor={topRightLabel.color} color={topRightLabel.ink} wrap="truncate-end">
            {` ${topRightLabel.text} `}
          </Text>
        )}
      </Box>
      <Box flexDirection="column" flexShrink={0}>{children}</Box>
      <Box height={1} flexShrink={0} />
    </Box>
  )
}

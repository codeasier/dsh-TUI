export type TerminalImageProtocol = 'kitty' | 'sixel' | 'none'

/**
 * Pick the graphics protocol for this terminal.
 *
 * Kitty wins by default: it is the richer protocol, and the renderer's image
 * lifecycle is built on it (persistent placements, `d=i` dormancy that keeps
 * the raster, moves that replace a placement instead of stacking on top of
 * it). A cell-bound terminal (see `terminalImagesBindToCells`) has to go the
 * other way when it also speaks Sixel: its Kitty layer adds a placement per
 * `a=p` rather than replacing the one with the same id, and frees the raster
 * when a placement is deleted — so an image could neither move nor be parked,
 * which is exactly what a scrolling thumbnail needs. Sixel paints rasters into
 * the cell grid, the model those terminals implement and the one the Sixel
 * renderer manages.
 * @param kittyStatus - the Kitty graphics query reply status, if any.
 * @param attributes - the primary DA reply parameters, if any.
 * @param override - the `DSH_TUI_IMAGE_PROTOCOL` override, which always wins.
 * @param cellBoundImages - whether the terminal paints images as cell content.
 * @returns the protocol to render images with.
 */
export function selectTerminalImageProtocol(
  kittyStatus: string | undefined,
  attributes: readonly number[] | undefined,
  override: string | undefined,
  cellBoundImages = false,
): TerminalImageProtocol {
  if (override === 'none' || override === 'kitty' || override === 'sixel') return override
  const sixel = attributes?.slice(1).includes(4) === true
  if (cellBoundImages) {
    if (sixel) return 'sixel'
    return kittyStatus?.startsWith('OK') ? 'kitty' : 'none'
  }
  if (kittyStatus?.startsWith('OK')) return 'kitty'
  return sixel ? 'sixel' : 'none'
}

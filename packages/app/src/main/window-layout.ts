import type { PetWindowLayout } from "../shared/ipc"
import { clampWindowPosition, type DragPoint, type DragSize, type WorkArea } from "./drag-math"

export const PANEL_WINDOW_SIZE = { width: 380, height: 520 } as const

export interface WindowBounds extends DragPoint, DragSize {}

/** Leave one toolbar row above the scaled stage, rather than an empty panel-sized canvas. */
export function windowSizeForLayout(layout: PetWindowLayout): DragSize {
  if (layout.panelOpen) return { ...PANEL_WINDOW_SIZE }
  return {
    width: Math.max(280, Math.ceil(layout.stageWidth + 24)),
    height: Math.max(190, Math.ceil(layout.stageHeight + 54)),
  }
}

/** Keep the stage's bottom centre in place as the surrounding window changes size. */
export function positionForWindowSize(bounds: WindowBounds, size: DragSize): DragPoint {
  return {
    // Use the same integer anchor both ways so odd widths never accumulate half-pixel rounding.
    x: bounds.x + Math.floor(bounds.width / 2) - Math.floor(size.width / 2),
    y: Math.round(bounds.y + bounds.height - size.height),
  }
}

export function boundsForWindowLayout(
  bounds: WindowBounds,
  layout: PetWindowLayout,
  workAreas: readonly WorkArea[],
): WindowBounds {
  const desiredSize = windowSizeForLayout(layout)
  const anchor = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height - 10 }
  const initial = clampWindowPosition(positionForWindowSize(bounds, desiredSize), desiredSize, workAreas, anchor)
  const size = {
    width: Math.min(desiredSize.width, initial.workArea.width),
    height: Math.min(desiredSize.height, initial.workArea.height),
  }
  const clamped = clampWindowPosition(positionForWindowSize(bounds, size), size, [initial.workArea], anchor)
  return { x: Math.round(clamped.position.x), y: Math.round(clamped.position.y), ...size }
}

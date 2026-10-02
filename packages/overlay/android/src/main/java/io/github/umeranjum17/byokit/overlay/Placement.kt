package io.github.umeranjum17.byokit.overlay

import kotlin.math.hypot
import kotlin.math.roundToInt

/** A width and height in pixels. */
data class Size(val w: Int, val h: Int)

/** The screen edge the bubble rests on. */
enum class Edge { LEFT, RIGHT }

/** Where the bubble rests: an edge, and y as 0..1 of the usable height (docs/capability-kits.md 7.3, 7.5). */
data class Spot(val edge: Edge, val y: Float)

/**
 * A box the bubble and its pill keep clear of, such as a text field or a send button: its top-left corner and size in
 * screen pixels (full display, origin top-left), as an accessibility node's bounds in screen report them.
 */
data class ClearRect(val left: Int, val top: Int, val width: Int, val height: Int)

/** Pure placement maths for the bubble, in pixels of the screen it sits on. */
object Placement {
  /** How far a touch moves before it is a drag, in dp. */
  const val DRAG_SLOP_DP = 8

  /** Whether a touch that moved (dxPx, dyPx) is a drag. */
  fun isDrag(dxPx: Float, dyPx: Float, density: Float): Boolean = hypot(dxPx, dyPx) > DRAG_SLOP_DP * density

  /** The spot for a bubble dropped with its top-left at (xPx, yPx): the nearest edge, y clamped into the usable band. */
  fun snap(xPx: Int, yPx: Int, screen: Size, bubble: Size, insetTopPx: Int, imeTopPx: Int?): Spot {
    val edge = if (xPx + bubble.w / 2 < screen.w / 2) Edge.LEFT else Edge.RIGHT
    val (top, bottom) = band(screen, bubble, insetTopPx)
    val y = yPx.coerceAtMost(restBottom(bottom, bubble, imeTopPx)).coerceIn(top, bottom)
    return Spot(edge, if (bottom > top) (y - top).toFloat() / (bottom - top) else 0f)
  }

  /** The top-left pixel for a spot. The keyboard only lifts the bubble; the spot itself is kept for when it closes. */
  fun toPixels(spot: Spot, screen: Size, bubble: Size, insetTopPx: Int, imeTopPx: Int?): Pair<Int, Int> {
    val x = if (spot.edge == Edge.LEFT) 0 else (screen.w - bubble.w).coerceAtLeast(0)
    val (top, bottom) = band(screen, bubble, insetTopPx)
    val y = (top + spot.y.coerceIn(0f, 1f) * (bottom - top)).roundToInt()
    return x to y.coerceAtMost(restBottom(bottom, bubble, imeTopPx)).coerceIn(top, bottom)
  }

  private fun band(screen: Size, bubble: Size, insetTopPx: Int): Pair<Int, Int> {
    val top = insetTopPx.coerceAtLeast(0)
    return top to (screen.h - bubble.h).coerceAtLeast(top)
  }

  private fun restBottom(bottom: Int, bubble: Size, imeTopPx: Int?): Int =
    if (imeTopPx == null) bottom else minOf(bottom, imeTopPx - bubble.h)

  /**
   * The top for the whole row (bubble and pill, [row] big, its left at [x]) with [rects] kept clear: [restY] when the
   * row there covers none of them, else the nearest top in the usable band (below the status bar, above the keyboard)
   * where it covers none, the higher one on a tie. Null when there is no such top: the caller keeps [restY] rather
   * than moving onto other text, and says so. Only the top moves; the edge and the remembered spot stay.
   */
  fun keepClear(
    x: Int, restY: Int, row: Size, screen: Size, insetTopPx: Int, imeTopPx: Int?, rects: List<ClearRect>,
  ): Int? {
    val near = rects.filter { it.width > 0 && it.height > 0 && it.left < x + row.w && it.left + it.width > x }
    fun clear(y: Int) = near.none { y < it.top + it.height && y + row.h > it.top }
    if (clear(restY)) return restY
    val (top, bottom) = band(screen, row, insetTopPx).let { (t, b) -> t to restBottom(b, row, imeTopPx) }
    return (listOf(top, bottom) + near.flatMap { listOf(it.top - row.h, it.top + it.height) })
      .filter { it in top..bottom && clear(it) }
      .minWithOrNull(compareBy({ kotlin.math.abs(it - restY) }, { it }))
  }
}

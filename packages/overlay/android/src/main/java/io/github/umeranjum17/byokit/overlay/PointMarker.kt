package io.github.umeranjum17.byokit.overlay

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.roundToInt

class PointRecord : Record {
  @Field val x: Double = 0.0
  @Field val y: Double = 0.0
  @Field val width: Double = 0.0
  @Field val height: Double = 0.0
  @Field val label: String = ""
  @Field val space: ScreenSpaceRecord? = null
  @Field val ms: Double = 2500.0
}

/** A rectangle in screen pixels. */
data class Box(val l: Float, val t: Float, val r: Float, val b: Float) {
  val w get() = r - l
  val h get() = b - t
}

/**
 * Where the ring and its callout go, in screen pixels. [corner] is the ring's corner radius; [below] is false when the
 * callout flipped above the target; [arrowX] is where the callout's arrow points from.
 */
data class PointPlan(val ring: Box, val corner: Float, val callout: Box, val below: Boolean, val arrowX: Float)

/** Pure placement for the point marker: the ring hugs the target and the callout sits beside it, never on it. */
object PointLayout {
  /** The smallest ring, as a 48 dp touch target, for a point with no size. */
  const val MIN_DP = 48f
  /** The ring's outset from the target, so its stroke stays outside the target. */
  const val OUTSET_DP = 6f
  /** The space between the ring and the callout, which holds the arrow. */
  const val GAP_DP = 10f
  /** The callout's distance from the screen's safe edges. */
  const val MARGIN_DP = 8f
  /** Half the ring's stroke with its halo: how far the ring's line stays inside the screen. */
  const val STROKE_DP = 2.5f
  /** The largest corner on a ring around a sized target that still clears the target's own corners. */
  const val CORNER_DP = 14f

  /**
   * [target] is the target's bounds (zero size for a bare point), [screen] the display, [safe] the part of it clear of
   * system bars and cutouts, [callout] the callout's size. The callout goes below the ring when it fits, otherwise above,
   * otherwise on the roomier side; horizontally it centres on the target, kept inside [safe].
   */
  fun plan(target: Box, screen: Size, safe: Box, callout: Size, density: Float): PointPlan {
    val min = MIN_DP * density / 2
    val cx = (target.l + target.r) / 2; val cy = (target.t + target.b) / 2
    val out = OUTSET_DP * density
    val ring = Box(
      minOf(target.l - out, cx - min), minOf(target.t - out, cy - min),
      maxOf(target.r + out, cx + min), maxOf(target.b + out, cy + min),
    ).let {
      val e = STROKE_DP * density
      Box(it.l.coerceAtLeast(e), it.t.coerceAtLeast(e), it.r.coerceAtMost(screen.w - e), it.b.coerceAtMost(screen.h - e))
    }
    val half = minOf(ring.w, ring.h) / 2
    val corner = if (target.w == 0f && target.h == 0f) half else minOf(half, CORNER_DP * density)
    val gap = GAP_DP * density; val margin = MARGIN_DP * density
    val top = safe.t + margin; val bottom = safe.b - margin
    val roomBelow = bottom - (ring.b + gap); val roomAbove = (ring.t - gap) - top
    val below = roomBelow >= callout.h || (roomAbove < callout.h && roomBelow >= roomAbove)
    val y = if (below) (ring.b + gap).coerceAtMost(bottom - callout.h) else (ring.t - gap - callout.h).coerceAtLeast(top)
    val left = safe.l + margin; val right = safe.r - margin
    val x = if (right - left <= callout.w) left else (cx - callout.w / 2).coerceIn(left, right - callout.w)
    val box = Box(x, y, x + callout.w, y + callout.h)
    val end = callout.h / 2f
    val arrowX = if (box.w <= 2 * end) (box.l + box.r) / 2 else cx.coerceIn(box.l + end, box.r - end)
    return PointPlan(ring, corner, box, below, arrowX)
  }
}

/** The marker is its own window, so dismissing it never removes the bubble. One marker at a time. */
internal class PointMarker(private val context: Context, private val type: Int) {
  private val windows = context.getSystemService(WindowManager::class.java)
  private val main = Handler(Looper.getMainLooper())
  private var view: View? = null
  private var space: ScreenSpace? = null
  private val displays = context.getSystemService(android.hardware.display.DisplayManager::class.java)
  private val changes = object : android.hardware.display.DisplayManager.DisplayListener {
    override fun onDisplayAdded(id: Int) {}
    override fun onDisplayRemoved(id: Int) { if (space?.displayId == id) dismiss() }
    override fun onDisplayChanged(id: Int) { if (view != null && space != ScreenSpace.current(context)) dismiss() }
  }
  private val dismiss = Runnable { dismiss() }

  fun show(o: PointRecord): String {
    require(o.x.isFinite() && o.y.isFinite() && o.label.isNotBlank() && o.ms.isFinite() && o.ms in 1.0..60000.0)
    require(o.width.isFinite() && o.height.isFinite() && o.width >= 0 && o.height >= 0)
    val s = ScreenSpace.current(context)
    if (o.space?.let { !s.matches(it) } == true) return "display-changed"
    require(o.x >= 0 && o.y >= 0 && o.x < s.width && o.y < s.height)
    dismiss()
    val d = s.density
    val ink = callInk(d)
    val textMax = (s.width - 2 * PointLayout.MARGIN_DP * d - 2 * PAD_DP * d).coerceAtMost(280 * d).coerceAtLeast(0f)
    val text = android.text.TextUtils.ellipsize(o.label, android.text.TextPaint(ink), textMax, android.text.TextUtils.TruncateAt.END).toString()
    val callout = Size(ceil(ink.measureText(text) + 2 * PAD_DP * d).toInt(), (CALLOUT_DP * d).roundToInt())
    val (w, h) = o.width.toFloat() / 2 to o.height.toFloat() / 2
    val target = Box(o.x.toFloat() - w, o.y.toFloat() - h, o.x.toFloat() + w, o.y.toFloat() + h)
    val plan = PointLayout.plan(target, Size(s.width, s.height), safe(s), callout, d)
    // The window spans the ring, the arrow and the callout; the view draws in window-local pixels.
    val pad = HALO_DP * d
    val l = floor(minOf(plan.ring.l, plan.callout.l) - pad).toInt(); val t = floor(minOf(plan.ring.t, plan.callout.t) - pad).toInt()
    val r = ceil(maxOf(plan.ring.r, plan.callout.r) + pad).toInt(); val b = ceil(maxOf(plan.ring.b, plan.callout.b) + pad).toInt()
    val v = RingView(context, o.label, text, plan, l.toFloat(), t.toFloat(), d, ink)
    val params = WindowManager.LayoutParams(
      r - l, b - t, type,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
      PixelFormat.TRANSLUCENT,
    ).apply {
      title = "byokit-point-marker"
      gravity = Gravity.TOP or Gravity.LEFT
      x = l; y = t
      // Android 12+ passes touches through an untrusted application overlay only at or below 0.8 opacity.
      alpha = 0.75f
      if (Build.VERSION.SDK_INT >= 30) fitInsetsTypes = 0
      if (Build.VERSION.SDK_INT >= 28) layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
    }
    windows.addView(v, params)
    view = v
    space = s
    displays.registerDisplayListener(changes, main)
    // Announcement is an event, not a focusable/touchable accessibility target.
    @Suppress("DEPRECATION")
    v.announceForAccessibility(o.label)
    main.postDelayed(dismiss, o.ms.toLong())
    return "shown"
  }
  fun dismiss() {
    main.removeCallbacks(dismiss)
    displays.unregisterDisplayListener(changes)
    space = null
    val v = view ?: return
    view = null
    runCatching { windows.removeView(v) }
  }

  /** The display minus status bar, navigation bar and cutout, in the same full-display pixels as [s]. */
  private fun safe(s: ScreenSpace): Box {
    if (Build.VERSION.SDK_INT >= 30) {
      val i = windows.maximumWindowMetrics.windowInsets
        .getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
      return Box(i.left.toFloat(), i.top.toFloat(), (s.width - i.right).toFloat(), (s.height - i.bottom).toFloat())
    }
    val res = context.resources
    val top = res.getIdentifier("status_bar_height", "dimen", "android").let { if (it != 0) res.getDimensionPixelSize(it) else 0 }
    // The app area is the display minus the navigation bar, which sits at the bottom or, in landscape, on one side.
    @Suppress("DEPRECATION") val app = android.graphics.Point().also { windows.defaultDisplay.getSize(it) }
    val side = (s.width - app.x).coerceAtLeast(0); val bottom = (s.height - app.y).coerceAtLeast(0)
    val left = if (s.rotation == android.view.Surface.ROTATION_270) side else 0
    return Box(left.toFloat(), top.toFloat(), (s.width - side + left).toFloat(), (s.height - bottom).toFloat())
  }

  private class RingView(
    context: Context, label: String, private val text: String, private val plan: PointPlan,
    private val ox: Float, private val oy: Float, private val d: Float, private val ink: Paint,
  ) : View(context) {
    private val shape = Path()
    private val arrow = Path()
    init { contentDescription = label; isFocusable = false; isClickable = false }
    override fun onDraw(canvas: Canvas) {
      canvas.translate(-ox, -oy)
      val ring = plan.ring; val c = plan.callout
      val radius = plan.corner
      // A white halo under a green stroke reads on light and dark pages alike.
      ink.style = Paint.Style.STROKE; ink.strokeWidth = 5 * d; ink.color = Color.WHITE
      canvas.drawRoundRect(ring.l, ring.t, ring.r, ring.b, radius, radius, ink)
      ink.strokeWidth = 3 * d; ink.color = GREEN
      canvas.drawRoundRect(ring.l, ring.t, ring.r, ring.b, radius, radius, ink)
      // The arrow points from the callout's edge at the target.
      val half = 7 * d
      val edge = if (plan.below) c.t else c.b
      val tip = if (plan.below) edge - 7 * d else edge + 7 * d
      arrow.reset(); arrow.moveTo(plan.arrowX - half, edge); arrow.lineTo(plan.arrowX, tip); arrow.lineTo(plan.arrowX + half, edge); arrow.close()
      shape.reset(); shape.addRoundRect(c.l, c.t, c.r, c.b, c.h / 2, c.h / 2, Path.Direction.CW); shape.op(arrow, Path.Op.UNION)
      // A white edge keeps the dark callout visible on dark pages.
      ink.style = Paint.Style.STROKE; ink.strokeWidth = 3 * d; ink.color = Color.WHITE
      canvas.drawPath(shape, ink)
      ink.style = Paint.Style.FILL; ink.color = INK
      canvas.drawPath(shape, ink)
      ink.style = Paint.Style.FILL; ink.color = Color.WHITE
      canvas.drawText(text, c.l + PAD_DP * d, (c.t + c.b) / 2 - (ink.ascent() + ink.descent()) / 2, ink)
    }
  }

  private companion object {
    const val PAD_DP = 14f
    const val CALLOUT_DP = 36f
    const val HALO_DP = 3f
    val GREEN = Color.rgb(0, 103, 78)
    val INK = Color.rgb(0, 46, 35)
    fun callInk(d: Float) = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 15 * d; typeface = android.graphics.Typeface.DEFAULT_BOLD }
  }
}

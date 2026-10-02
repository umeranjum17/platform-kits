package io.github.umeranjum17.byokit.overlay

import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.ImageView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class BubbleTest {
  @Test fun accessibilityClickAndTouchTapEachEmitExactlyOneTap() {
    val context = RuntimeEnvironment.getApplication()
    val bubble = Bubble(WindowOverlayHost(context), PrefsSpotStore(context), { null }, { true })
    val seen = mutableListOf<OverlayEvent>()
    bubble.events.add(seen::add)
    bubble.show("calm")
    try {
      val image = Bubble::class.java.getDeclaredField("image").apply { isAccessible = true }.get(bubble) as ImageView
      assertTrue(image.performAccessibilityAction(AccessibilityNodeInfo.ACTION_CLICK, null))
      assertEquals(listOf(OverlayEvent.Tap), seen)
      for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
        val event = MotionEvent.obtain(0, 10, action, 10f, 10f, 0)
        try { assertTrue(image.dispatchTouchEvent(event)) } finally { event.recycle() }
      }
      assertEquals(listOf(OverlayEvent.Tap, OverlayEvent.Tap), seen)
    } finally { bubble.hide() }
  }

  /** The real window host, recording where the row goes. */
  private class Recording(context: android.content.Context) :
    WindowManagerHost(context, android.view.WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY) {
    var at = 0 to 0
    override fun add(view: android.view.View, x: Int, y: Int) { super.add(view, x, y); at = x to y }
    override fun move(x: Int, y: Int) { super.move(x, y); at = x to y }
  }

  private class Spots : SpotStore {
    val puts = mutableListOf<Spot>()
    override fun get(key: String): Spot? = null
    override fun put(key: String, spot: Spot) { puts += spot }
  }

  private fun field(bubble: Bubble, name: String) =
    Bubble::class.java.getDeclaredField(name).apply { isAccessible = true }.get(bubble) as android.view.View

  /** The row's box on screen: the host's position and the row view's measured size. */
  private fun box(host: Recording, bubble: Bubble): ClearRect {
    val row = field(bubble, "row")
    row.measure(android.view.View.MeasureSpec.UNSPECIFIED, android.view.View.MeasureSpec.UNSPECIFIED)
    return ClearRect(host.at.first, host.at.second, row.measuredWidth, row.measuredHeight)
  }

  private fun ClearRect.covers(o: ClearRect) =
    left < o.left + o.width && o.left < left + width && top < o.top + o.height && o.top < top + height

  @Test @Config(sdk = [35], manifest = Config.NONE, qualifiers = "w360dp-h800dp-xxhdpi")
  fun keepClearMovesTheWholeRowOffTheBoxesAndBackWithoutTouchingTheSavedSpot() {
    val context = RuntimeEnvironment.getApplication()
    val host = Recording(context)
    val spots = Spots()
    val bubble = Bubble(host, spots, { null }, { true })
    val seen = mutableListOf<OverlayEvent>()
    bubble.events.add(seen::add)
    bubble.show("calm")
    try {
      val rest = host.at
      val alone = box(host, bubble)
      // The field under the bubble at its rest spot.
      val input = ClearRect(84, alone.top - 40, 986, 360)
      assertTrue(alone.covers(input))
      bubble.keepClear(listOf(input))
      val moved = box(host, bubble)
      assertEquals(rest.first, moved.left)
      assertFalse(moved.covers(input))
      assertEquals(input.top - moved.height, moved.top) // the nearest clear top: just above the field

      // The pill widens the row; a line of text left of the bubble is covered by the pill only.
      bubble.keepClear(emptyList())
      assertEquals(rest, host.at)
      bubble.say("Inserted. Send it yourself.", null, 60_000)
      val said = box(host, bubble)
      assertTrue(said.width > alone.width)
      val line = ClearRect(said.left, said.top, alone.left - said.left - 20, said.height)
      assertFalse(alone.covers(line))
      bubble.keepClear(listOf(line))
      assertFalse(box(host, bubble).covers(line))
      assertTrue(host.at.second != rest.second)

      // The keyboard opening under the row: it stays above the keyboard and clear of the line.
      bubble.imeTopPx = said.top + said.height + 10
      val typed = box(host, bubble)
      assertTrue(typed.top + typed.height <= said.top + said.height + 10)
      assertFalse(typed.covers(line))
      bubble.imeTopPx = null

      // No clear spot: the row stays at the saved spot and says so; clearing says it is clear again.
      bubble.keepClear(listOf(ClearRect(0, 0, 1080, 2400)))
      assertEquals(rest.second, host.at.second)
      assertEquals(OverlayEvent.KeepClear(false), seen.last())
      bubble.keepClear(emptyList())
      assertEquals(OverlayEvent.KeepClear(true), seen.last())
      assertEquals(rest.second, host.at.second)

      org.robolectric.shadows.ShadowLooper.idleMainLooper(60_001, java.util.concurrent.TimeUnit.MILLISECONDS) // the pill goes
      // A display size change drops boxes measured on the old one: a band that would cover the turned rest spot.
      bubble.keepClear(listOf(ClearRect(0, 300, 2400, 600)))
      RuntimeEnvironment.setQualifiers("w800dp-h360dp-xxhdpi")
      bubble.imeTopPx = 1 // any re-place
      bubble.imeTopPx = null
      val fresh = Recording(context)
      val turned = Bubble(fresh, Spots(), { null }, { true })
      turned.show("calm")
      try {
        assertTrue(ClearRect(0, 300, 2400, 600).covers(box(fresh, turned)))
        assertEquals(fresh.at, host.at)
      } finally { turned.hide() }

      // None of it moved the saved spot.
      assertEquals(emptyList<Spot>(), spots.puts)
      assertTrue(seen.none { it is OverlayEvent.Moved })
    } finally { bubble.hide() }
  }
}

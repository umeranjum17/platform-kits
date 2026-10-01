package io.github.umeranjum17.byokit.overlay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PointLayoutTest {
  // A 1080 x 2400 phone at density 2.625: 63 px status bar, 63 px gesture bar.
  private val d = 2.625f
  private val screen = Size(1080, 2400)
  private val safe = Box(0f, 63f, 1080f, 2337f)
  private val callout = Size(420, 95)

  private fun target(cx: Float, cy: Float, w: Float, h: Float) = Box(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
  private fun overlaps(a: Box, b: Box) = a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b
  private fun inside(a: Box, b: Box) = a.l >= b.l && a.t >= b.t && a.r <= b.r && a.b <= b.b
  private fun encloses(ring: Box, t: Box) = ring.l < t.l && ring.t < t.t && ring.r > t.r && ring.b > t.b

  private fun check(t: Box, avoid: List<Box> = emptyList()): PointPlan {
    val p = PointLayout.plan(t, screen, safe, callout, d, avoid)
    for (a in avoid) assertFalse("callout covers text", overlaps(p.callout, a))
    assertFalse("callout covers the target", overlaps(p.callout, t))
    assertFalse("callout covers the ring", overlaps(p.callout, p.ring))
    assertTrue("callout leaves the safe area", inside(p.callout, safe))
    assertTrue("arrow leaves the callout", p.arrowX > p.callout.l && p.arrowX < p.callout.r)
    return p
  }

  @Test fun topTargetPutsTheCalloutBelow() {
    val t = target(540f, 170f, 600f, 150f)
    val p = check(t)
    assertTrue(p.below)
    assertTrue(encloses(p.ring, t))
    assertEquals(540f, p.arrowX, 0.01f)
  }

  @Test fun middleTargetPutsTheCalloutBelow() {
    val p = check(target(540f, 1200f, 500f, 160f))
    assertTrue(p.below)
    assertEquals(540f - 210f, p.callout.l, 0.01f)
  }

  @Test fun bottomTargetFlipsTheCalloutAbove() {
    val t = target(540f, 2240f, 1000f, 150f)
    val p = check(t)
    assertFalse(p.below)
    assertTrue(p.callout.b <= p.ring.t)
  }

  @Test fun edgeTargetsKeepTheCalloutOnScreenAndPointTheArrowAtTheTarget() {
    val left = check(target(130f, 900f, 260f, 150f))
    assertEquals(PointLayout.MARGIN_DP * d, left.callout.l, 0.01f)
    assertEquals(130f, left.arrowX, 0.01f)
    val right = check(target(980f, 1500f, 200f, 150f))
    assertEquals(1080f - PointLayout.MARGIN_DP * d, right.callout.r, 0.01f)
    assertEquals(980f, right.arrowX, 0.01f)
    // A flush target's ring stays on screen rather than being cut off.
    val flush = check(target(60f, 600f, 120f, 120f))
    assertEquals(PointLayout.STROKE_DP * d, flush.ring.l, 0.01f)
  }

  @Test fun cornerArrowStaysOnTheCalloutsStraightEdge() {
    val p = check(target(8f, 900f, 16f, 16f))
    assertEquals(p.callout.l + callout.h / 2f, p.arrowX, 0.01f)
  }

  @Test fun aBarePointGetsACircleTheSizeOfATouchTarget() {
    val p = check(target(540f, 1200f, 0f, 0f))
    assertEquals(PointLayout.MIN_DP * d, p.ring.w, 0.01f)
    assertEquals(p.ring.w / 2, p.corner, 0.01f)
  }

  @Test fun aSizedTargetGetsCornersThatClearItsOwn() {
    val p = check(target(540f, 1200f, 500f, 160f))
    assertEquals(PointLayout.CORNER_DP * d, p.corner, 0.01f)
    assertTrue(encloses(p.ring, target(540f, 1200f, 500f, 160f)))
  }

  @Test fun textBelowTheTargetFlipsTheCalloutAbove() {
    val t = target(540f, 1200f, 900f, 160f)
    // A sentence right under the button, as wide as the card.
    val sentence = Box(60f, 1300f, 1020f, 1360f)
    val p = check(t, listOf(sentence))
    assertFalse(p.below)
    assertEquals(540f, p.arrowX, 0.01f)
  }

  @Test fun textUnderTheCentredSpotNudgesTheCalloutSideways() {
    val t = target(540f, 1200f, 600f, 160f)
    // A short word below and right of centre, and a caption across the whole width above.
    val word = Box(620f, 1300f, 800f, 1360f)
    val caption = Box(0f, 1000f, 1080f, 1100f)
    val p = check(t, listOf(word, caption))
    assertTrue(p.below)
    assertTrue(p.callout.r <= 620f)
    assertEquals(540f, p.arrowX, 0.01f)
  }

  @Test fun withNoClearSpotTheCalloutCoversTheLeastText() {
    val t = target(540f, 1200f, 600f, 160f)
    val block = Box(0f, 1280f, 1080f, 1500f)
    val line = Box(0f, 1000f, 1080f, 1012f)
    val p = PointLayout.plan(t, screen, safe, callout, d, listOf(block, line))
    assertFalse(p.below)
    assertFalse(overlaps(p.callout, t))
  }

  @Test fun aTargetFillingTheScreenUsesTheRoomierSideAndStaysInTheSafeArea() {
    val p = PointLayout.plan(target(540f, 1300f, 1080f, 2200f), screen, safe, callout, d)
    assertTrue(inside(p.callout, safe))
  }
}

package io.github.umeranjum17.byokit.overlay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlacementTest {
  private val screen = Size(1000, 2000)
  private val bubble = Size(100, 100)
  private val top = 100 // status bar

  @Test fun snapsToTheNearestEdge() {
    assertEquals(Edge.LEFT, Placement.snap(300, 500, screen, bubble, top, null).edge)
    assertEquals(Edge.RIGHT, Placement.snap(600, 500, screen, bubble, top, null).edge)
    // The bubble's centre decides: its left side is left of the middle, its centre is not.
    assertEquals(Edge.RIGHT, Placement.snap(460, 500, screen, bubble, top, null).edge)
    // y 0.2 of the 100..1900 band.
    assertEquals(0 to 460, Placement.toPixels(Spot(Edge.LEFT, 0.2f), screen, bubble, top, null))
    assertEquals(900 to 460, Placement.toPixels(Spot(Edge.RIGHT, 0.2f), screen, bubble, top, null))
  }

  @Test fun clampsInsideTheInsets() {
    // Usable band for the bubble's top: 100 (below the status bar) to 1900 (its bottom on the screen's).
    assertEquals(0f, Placement.snap(0, -50, screen, bubble, top, null).y)
    assertEquals(0f, Placement.snap(0, 40, screen, bubble, top, null).y)
    assertEquals(1f, Placement.snap(0, 5000, screen, bubble, top, null).y)
    assertEquals(0.5f, Placement.snap(0, 1000, screen, bubble, top, null).y)
    assertEquals(0 to 100, Placement.toPixels(Spot(Edge.LEFT, -1f), screen, bubble, top, null))
    assertEquals(0 to 1900, Placement.toPixels(Spot(Edge.LEFT, 2f), screen, bubble, top, null))
    // A spot survives the round trip.
    val spot = Placement.snap(900, 1000, screen, bubble, top, null)
    assertEquals(900 to 1000, Placement.toPixels(spot, screen, bubble, top, null))
  }

  @Test fun restsAboveTheKeyboard() {
    val ime = 1200 // the keyboard's top edge
    assertEquals(900 to 1100, Placement.toPixels(Spot(Edge.RIGHT, 1f), screen, bubble, top, ime))
    // A spot above the keyboard is left where it is.
    assertEquals(900 to 280, Placement.toPixels(Spot(Edge.RIGHT, 0.1f), screen, bubble, top, ime))
    // Dropped under the keyboard, it snaps to just above it.
    val spot = Placement.snap(900, 1600, screen, bubble, top, ime)
    assertEquals(900 to 1100, Placement.toPixels(spot, screen, bubble, top, ime))
    // The keyboard closing gives the lower rest back (the spot is kept relative to the full height).
    assertEquals(900 to 1900, Placement.toPixels(Spot(Edge.RIGHT, 1f), screen, bubble, top, null))
  }

  @Test fun dragSlopThreshold() {
    val density = 2f // 8 dp = 16 px
    assertFalse(Placement.isDrag(0f, 0f, density))
    assertFalse(Placement.isDrag(16f, 0f, density))
    assertFalse(Placement.isDrag(9f, 13f, density)) // hypot ≈ 15.8
    assertTrue(Placement.isDrag(16.1f, 0f, density))
    assertTrue(Placement.isDrag(-12f, -12f, density)) // hypot ≈ 17
    assertEquals(8, Placement.DRAG_SLOP_DP)
  }

  // keepClear: the row (bubble plus pill) is 500 wide and 100 high on the right edge, so its left is at 500.
  private val row = Size(500, 100)
  private val rowX = 500
  private fun covers(y: Int, r: ClearRect, w: Int = row.w, x: Int = rowX) =
    x < r.left + r.width && r.left < x + w && y < r.top + r.height && r.top < y + row.h

  @Test fun keepsTheRestSpotWhenNothingIsCovered() {
    assertEquals(1000, Placement.keepClear(rowX, 1000, row, screen, top, null, emptyList()))
    // A box beside the row, or touching its bottom edge, is not covered.
    assertEquals(1000, Placement.keepClear(rowX, 1000, row, screen, top, null, listOf(ClearRect(0, 900, 500, 400))))
    assertEquals(1000, Placement.keepClear(rowX, 1000, row, screen, top, null, listOf(ClearRect(0, 1100, 1000, 300))))
    // An empty box covers nothing.
    assertEquals(1000, Placement.keepClear(rowX, 1000, row, screen, top, null, listOf(ClearRect(600, 1000, 0, 0))))
  }

  @Test fun movesTheWholeRowToTheNearestClearTop() {
    // The field (and its first line of text) at the rest spot, as in the inserted-text captures.
    val field = ClearRect(84, 950, 986, 350)
    val y = Placement.keepClear(rowX, 1000, row, screen, top, null, listOf(field))
    assertEquals(850, y) // just above the field: 150 away, nearer than 1300 below it
    assertFalse(covers(y!!, field))
  }

  @Test fun countsThePillNotJustTheBubble() {
    // A box under the pill only: the bubble alone (its left at 900) is clear, the bubble with its pill is not.
    val text = ClearRect(500, 980, 300, 60)
    assertEquals(1000, Placement.keepClear(900, 1000, Size(100, 100), screen, top, null, listOf(text)))
    assertEquals(1040, Placement.keepClear(rowX, 1000, row, screen, top, null, listOf(text))) // just under it
    // A pill taller than the bubble makes the row taller: a box 5 px under the 100-high row is under the 120-high one.
    val below = ClearRect(500, 1105, 300, 95)
    assertEquals(1000, Placement.keepClear(rowX, 1000, row, screen, top, null, listOf(below)))
    assertEquals(985, Placement.keepClear(rowX, 1000, Size(500, 120), screen, top, null, listOf(below)))
  }

  @Test fun neverMovesOntoAnotherBox() {
    val field = ClearRect(84, 950, 986, 350)
    val send = ClearRect(850, 800, 150, 100) // a control just above the field, where the row would otherwise go
    val y = Placement.keepClear(rowX, 1000, row, screen, top, null, listOf(field, send))!!
    assertEquals(700, y) // above both; 1300 below the field is as far, and the higher top wins a tie
    assertFalse(covers(y, field)); assertFalse(covers(y, send))
  }

  @Test fun staysAboveTheKeyboardAndBelowTheStatusBar() {
    val ime = 1200
    // Under the field is under the keyboard, so the row goes above the field.
    val tall = ClearRect(0, 300, 1000, 850)
    assertEquals(200, Placement.keepClear(rowX, 1100, row, screen, top, ime, listOf(tall)))
    // The field from the status bar to the keyboard leaves no clear top: null, and the caller keeps its rest spot.
    assertEquals(null, Placement.keepClear(rowX, 1100, row, screen, top, ime, listOf(ClearRect(0, 150, 1000, 1000))))
    // The keyboard closing gives the room under the field back.
    assertEquals(1150, Placement.keepClear(rowX, 1100, row, screen, top, null, listOf(ClearRect(0, 150, 1000, 1000))))
  }

  @Test fun noClearTopAnywhere() {
    assertEquals(null, Placement.keepClear(rowX, 1000, row, screen, top, null, listOf(ClearRect(0, 0, 1000, 2000))))
    // Two boxes leaving a gap smaller than the row are no room either.
    val boxes = listOf(ClearRect(0, 0, 1000, 1000), ClearRect(0, 1050, 1000, 950))
    assertEquals(null, Placement.keepClear(rowX, 1000, row, screen, top, null, boxes))
    // A gap exactly the row's height is.
    assertEquals(1000, Placement.keepClear(rowX, 990, row, screen, top, null, listOf(ClearRect(0, 0, 1000, 1000), ClearRect(0, 1100, 1000, 900))))
  }
}

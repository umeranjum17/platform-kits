package io.github.umeranjum17.byokit.example.a11y

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.umeranjum17.byokit.overlay.FocusedFields
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A deterministic regression guard for the 303832b3 port. A provider lookup can answer with the field that just
 * lost focus (or a child snapshot whose focus flag is not yet readable), so the kit resolves current virtual focus
 * from a refreshed child snapshot before trusting that lookup. Chromium publishes DOM focus late enough that the
 * real-WebView test cannot reliably enter that race; a fake provider tree reproduces it on every run, so this test
 * fails on the pre-port code and passes after it.
 */
@RunWith(AndroidJUnit4::class)
class FocusedFieldsTransientTest {
  private class FakeNode(
    private val editable: Boolean = false,
    private val password: Boolean = false,
    private val inputFocused: Boolean = editable,
    private val accessibilityFocused: Boolean = false,
    private val text: String? = "",
    private val kids: List<FakeNode> = emptyList(),
    private var deadReads: Int = 0,
  ) : AccessibilityNodeInfo() {
    override fun findFocus(focus: Int): AccessibilityNodeInfo? {
      if (if (focus == FOCUS_INPUT) inputFocused else accessibilityFocused) return this
      return kids.firstNotNullOfOrNull { it.findFocus(focus) }
    }
    override fun isEditable() = editable
    override fun isPassword() = password
    override fun isFocused() = inputFocused
    override fun isAccessibilityFocused() = accessibilityFocused
    override fun refresh(): Boolean = if (deadReads > 0) { deadReads--; false } else true
    override fun getText(): CharSequence? = text
    override fun getChildCount() = kids.size
    override fun getChild(index: Int): AccessibilityNodeInfo = kids[index]
    override fun getParent(): AccessibilityNodeInfo? = null
    override fun getViewIdResourceName(): String? = null
    override fun getPackageName(): CharSequence = "app"
    override fun getBoundsInScreen(outBounds: Rect) { outBounds.set(10, 20, 100, 80) }
    @Deprecated("Deprecated in Java") override fun recycle() {}
  }

  private class FakeService(
    private val root: AccessibilityNodeInfo? = null,
    private val focus: AccessibilityNodeInfo? = null,
    private val accessible: AccessibilityNodeInfo? = null,
  ) : AccessibilityService() {
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}
    @Suppress("DEPRECATION")
    override fun getWindows(): List<AccessibilityWindowInfo>? = null
    override fun getRootInActiveWindow(): AccessibilityNodeInfo? = root
    override fun findFocus(focus: Int): AccessibilityNodeInfo? =
      if (focus == AccessibilityNodeInfo.FOCUS_INPUT) this.focus else accessible
  }

  /** The first child snapshot is not yet readable; the kit must refresh it and resolve the child on the first
   * agreeing pair, not spend an extra settling round. */
  @Suppress("DEPRECATION")
  @Test fun aTransientChildSnapshotResolvesTheCurrentFieldOnTheFirstSnapshot() {
    val accessible = FakeNode(editable = true, inputFocused = false, accessibilityFocused = true, text = "other")
    val field = FakeNode(editable = true, text = "web field", deadReads = 1)
    val page = FakeNode(inputFocused = true, kids = listOf(FakeNode(editable = true, inputFocused = false), field))
    val service = FakeService(root = page, accessible = accessible)
    val pauses = mutableListOf<Long>()
    val focused = FocusedFields.focusedNode(service) { pauses += it }
    try {
      assertSame("the transient child, not the accessibility fallback", field, focused)
      assertEquals("web field", focused?.text?.toString())
      // A later lookup gets past the dead read; two agreeing snapshots are enough. Needing an extra settling
      // round is the pre-port behaviour that Chromium's late DOM publish makes expensive.
      assertEquals(listOf(75L), pauses)
    } finally {
      @Suppress("DEPRECATION") focused?.recycle()
      @Suppress("DEPRECATION") accessible.recycle()
    }
  }
}

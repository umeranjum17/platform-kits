package io.github.umeranjum17.byokit.example.a11y

import android.app.UiAutomation
import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.umeranjum17.byokit.overlay.FocusedFields
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class WebFocusedFieldTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)

  private fun shell(command: String): String = automation.executeShellCommand(command).use {
    android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().readText().trim()
  }

  private fun js(activity: WebFieldActivity, script: String): String {
    val done = CountDownLatch(1)
    var result = ""
    instrumentation.runOnMainSync {
      activity.web.evaluateJavascript(script) { result = it; done.countDown() }
    }
    assertTrue("JavaScript completed", done.await(10, TimeUnit.SECONDS))
    return result
  }

  private fun pageReady(activity: WebFieldActivity): Boolean {
    var ready = false
    instrumentation.runOnMainSync {
      ready = activity.web.run {
        isAttachedToWindow && isShown && hasWindowFocus() && isLaidOut && width > 0 && height > 0
      }
    }
    return ready
  }

  private fun pageState(activity: WebFieldActivity): String {
    var state = ""
    instrumentation.runOnMainSync {
      state = activity.web.run {
        "attached=$isAttachedToWindow, shown=$isShown, windowFocus=${hasWindowFocus()}, " +
          "laidOut=$isLaidOut, size=${width}x$height, layoutRequested=$isLayoutRequested"
      }
    }
    return state
  }

  private fun awaitPage(activity: WebFieldActivity) {
    assertTrue("Local WebView page loaded", activity.loaded.await(60, TimeUnit.SECONDS))
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
    var observed = ""
    while (!pageReady(activity)) {
      val state = pageState(activity)
      if (state != observed) { println("WebView waiting for page: $state"); observed = state }
      assertTrue("WebView attached, laid out and window focused: $state", System.nanoTime() < deadline)
      instrumentation.runOnMainSync { activity.web.requestFocus() }
      Thread.sleep(100)
    }
    println("WebView page ready: ${pageState(activity)}")
    // onPageFinished does not guarantee that the DOM has reached the next rendered frame.
    val drawn = CountDownLatch(1)
    instrumentation.runOnMainSync {
      activity.web.postVisualStateCallback(0, object : WebView.VisualStateCallback() {
        override fun onComplete(requestId: Long) { drawn.countDown() }
      })
    }
    assertTrue("Local WebView page ready to draw", drawn.await(60, TimeUnit.SECONDS))
  }

  /**
   * The field's on-screen pixel bounds: its DOM rect snapped out to whole CSS pixels (as Chromium reports it), times
   * the device pixel ratio, plus the WebView's screen spot.
   */
  private fun domBounds(activity: WebFieldActivity, id: String): Rect {
    val (l, t, r, b) = js(activity, """
      (() => { const b = document.getElementById('$id').getBoundingClientRect(), d = devicePixelRatio;
        return [Math.floor(b.left), Math.floor(b.top), Math.ceil(b.right), Math.ceil(b.bottom)]
          .map(v => v * d).join(','); })()
    """.trimIndent()).trim('"').split(',').map { it.toDouble().toInt() }
    val at = IntArray(2)
    instrumentation.runOnMainSync { activity.web.getLocationOnScreen(at) }
    return Rect(at[0] + l, at[1] + t, at[0] + r, at[1] + b)
  }

  /** DOM focus completes before Chromium publishes it to Android. Wait on that independent test precondition,
   * not on repeated kit reads: once ready, each run still requires read/capture/insert to succeed on its first call.
   */
  @Suppress("DEPRECATION")
  private fun awaitFocus(service: AccessibilityService, activity: WebFieldActivity, id: String,
    description: String, text: String? = null, password: Boolean = false) {
    require(password || text != null)
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
    var nextRequest = 0L
    var requests = 0
    var observed = "no snapshot"
    val app = instrumentation.targetContext.packageName
    do {
      val editors = mutableListOf<AccessibilityNodeInfo>()
      fun visit(node: AccessibilityNodeInfo) {
        var kept = false
        try {
          if (!node.refresh() || node.packageName?.toString() != app) return
          if (node.isEditable) {
            editors += node
            kept = true
          }
          for (i in 0 until node.childCount) node.getChild(i)?.let(::visit)
        } finally {
          if (!kept) node.recycle()
        }
      }
      try {
        // Read raw framework snapshots, including virtual nodes, without exercising the kit's resolver.
        for (window in service.windows) {
          try { window.root?.let(::visit) } finally { window.recycle() }
        }
        service.rootInActiveWindow?.let(::visit)
        val unique = editors.distinct() // active root can repeat a window's independently owned snapshot
        val focused = unique.filter { it.isFocused }
        val ready = focused.singleOrNull()?.let {
          it.isPassword == password && (password || it.text?.toString() == text)
        } ?: false
        observed = "editors=${unique.size}, focused=${focused.size}, expected=${ready}"
        if (ready && pageReady(activity)) {
          println("Android accessibility focus ready: $description; requests=$requests; $observed")
          return
        }
      } finally {
        editors.forEach { it.recycle() }
      }
      if (System.nanoTime() >= nextRequest && pageReady(activity)) {
        instrumentation.runOnMainSync { activity.web.requestFocus() }
        // A DOM editor can remain active after an early native focus request was lost. Blur/refocus
        // generates a fresh Chromium focus event instead of waiting forever on that one request.
        assertEquals("\"$id\"", js(activity, """
          (() => { const field = document.getElementById('$id'); field.blur(); field.focus();
            ${if (password) "" else "field.setSelectionRange(0, field.value.length);"}
            return document.activeElement.id; })()
        """.trimIndent()))
        requests++
        nextRequest = System.nanoTime() + TimeUnit.SECONDS.toNanos(1)
      }
      Thread.sleep(100) // polling interval, never a substitute for the focus/text condition
    } while (System.nanoTime() < deadline)
    fail("Android accessibility focus did not settle: $description; requests=$requests; $observed; pageReady=${pageReady(activity)}")
  }

  @Test fun textareaAndInputResolveAndInsertTenTimesAndPasswordsStayHidden() {
    val context = instrumentation.targetContext
    val previous = shell("settings get secure enabled_accessibility_services")
    val enabled = shell("settings get secure accessibility_enabled")
    var activity: WebFieldActivity? = null
    try {
      val component = "${context.packageName}/${WebFieldService::class.java.name}"
      shell("settings put secure enabled_accessibility_services $component")
      shell("settings put secure accessibility_enabled 1")
      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
      while (WebFieldService.connected == null && System.nanoTime() < deadline) Thread.sleep(50)
      val service = WebFieldService.connected ?: error("Test accessibility service did not connect")
      val page = instrumentation.startActivitySync(Intent(context, WebFieldActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as WebFieldActivity
      activity = page
      awaitPage(page)

      assertEquals("\"\"", js(page, "document.activeElement.id"))
      assertNull("No focus never guesses the decoy", FocusedFields.read(service))
      assertNull("No focus gives no node", FocusedFields.focusedNode(service))
      var last: AccessibilityNodeInfo? = null
      repeat(10) { run ->
        for ((id, label) in listOf("area" to "textarea", "line" to "input")) {
          val seed = "$label seed $run" // a prior run's cached text cannot satisfy the readiness condition
          instrumentation.runOnMainSync { page.web.requestFocus() }
          assertEquals("\"$id\"", js(page, """
            (() => { const field = document.getElementById('$id'); field.value = '$seed';
              field.focus(); field.setSelectionRange(0, field.value.length); return document.activeElement.id; })()
          """.trimIndent()))
          awaitFocus(service, page, id, "$id ${run + 1}/10", text = seed)
          val read = FocusedFields.read(service)
          assertNotNull("$id read ${run + 1}/10", read)
          assertEquals("$id resolves the right node", seed, read!!.text)
          val node = FocusedFields.focusedNode(service) ?: error("$id focusedNode ${run + 1}/10 was null")
          // The field before this one (A) lost DOM focus to this one (B): B, never the stale A.
          assertEquals("$id focusedNode ${run + 1}/10 text", seed, node.text?.toString())
          assertNotEquals("$id focusedNode ${run + 1}/10 is not the previous field", last, node)
          @Suppress("DEPRECATION") last?.recycle()
          last = node
          val bounds = Rect().also(node::getBoundsInScreen)
          val expected = domBounds(page, id)
          // 1 px slack for rounding the scaled rect to device pixels.
          val off = listOf(bounds.left - expected.left, bounds.top - expected.top,
            bounds.right - expected.right, bounds.bottom - expected.bottom)
          println("$id ${run + 1}/10 bounds $bounds, DOM $expected")
          assertTrue("$id bounds $bounds match the field's $expected", off.all { Math.abs(it) <= 1 })
          val field = FocusedFields.capture(service) ?: error("$id capture ${run + 1}/10 was null")
          try {
            assertEquals("$id insert ${run + 1}/10", "inserted", FocusedFields.insert(field, "$id-$run", replace = "all",
              copy = { error("A focused web field must insert, never copy") }, service = service))
          } finally { field.recycle() }
          assertEquals("\"$id-$run\"", js(page, "document.getElementById('$id').value"))
          // focusedNode is the node capture()/insert() wrote into.
          assertTrue("$id focusedNode refreshes", node.refresh())
          assertEquals("$id focusedNode ${run + 1}/10 is the inserted field", "$id-$run", node.text?.toString())
          assertEquals("\"leave me alone\"", js(page, "document.getElementById('decoy').value"))
        }
      }
      @Suppress("DEPRECATION") last?.recycle()
      assertEquals("\"password\"", js(page, "document.getElementById('password').focus(); document.activeElement.id"))
      awaitFocus(service, page, "password", "password editor", password = true)
      assertNull("Password read is hidden", FocusedFields.read(service))
      assertNull("Password capture is hidden", FocusedFields.capture(service))
      assertNull("Password gives no node", FocusedFields.focusedNode(service))
      val root = service.rootInActiveWindow ?: error("Password window root unavailable")
      try {
        assertEquals("failed", FocusedFields.insert(root, "never write", service = service,
          copy = { error("A password must never reach the clipboard") }))
      } finally {
        @Suppress("DEPRECATION") root.recycle()
      }
      assertEquals("\"private\"", js(page, "document.getElementById('password').value"))
      println("WebView focused fields: textarea 10/10, input 10/10 (focusedNode matched, A->B, bounds); password hidden; decoy untouched")
    } finally {
      activity?.let { page -> instrumentation.runOnMainSync { page.finish() } }
      if (previous == "null") shell("settings delete secure enabled_accessibility_services")
      else shell("settings put secure enabled_accessibility_services $previous")
      if (enabled == "null") shell("settings delete secure accessibility_enabled")
      else shell("settings put secure accessibility_enabled $enabled")
    }
  }
}

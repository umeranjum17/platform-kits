package io.github.umeranjum17.byokit.overlay

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.view.accessibility.AccessibilityWindowInfo

/** The app in the foreground, from the app's own accessibility service. */
interface ForegroundApp {
  /** The foreground app's package name, or null when unknown. */
  val current: String?
  /** Calls [fn] with each change; the returned function stops it. */
  fun onChange(fn: (String?) -> Unit): () -> Unit
}

/** The keyboard's top edge in screen pixels while it is open. */
interface KeyboardInset {
  /** The keyboard's top in screen pixels, or null while it is closed. */
  val imeTopPx: Int?
  /** Calls [fn] with each change; the returned function stops it. */
  fun onChange(fn: (Int?) -> Unit): () -> Unit
}

/** The focused text field's box in screen pixels; never its text. */
interface FocusedFieldBox {
  /** Calls [fn] on the main thread with the current box and each change; null with no editable field in focus. */
  fun onChange(fn: (ClearRect?) -> Unit): () -> Unit
}

/**
 * The package of the window the person is using: the service's active window's root (needs `canRetrieveWindowContent`).
 * Only the root is fetched where Android allows it (13+), so no other node of that app's screen is read.
 */
class AccessibilityForegroundApp(private val service: AccessibilityService) : ForegroundApp {
  private val watch = Watch { current }
  @Suppress("DEPRECATION")
  override val current: String? get() = runCatching {
    val root = if (Build.VERSION.SDK_INT >= 33) service.getRootInActiveWindow(0) else service.rootInActiveWindow
    if (root == null) return@runCatching null
    try {
      val window = root.window
      val overlay = try {
        window?.type == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY ||
          (root.packageName?.toString() == service.packageName &&
            (window?.type == AccessibilityWindowInfo.TYPE_SYSTEM || PanelActivity.current != null))
      } finally { window?.recycle() }
      if (!overlay) return@runCatching root.packageName?.toString()?.takeIf { it.isNotBlank() }
      // A host overlay can become the active root. Resolve only an active/focused application window,
      // never an arbitrary background app and never children or screen text.
      val windows = service.windows
      try {
        val underlying = windows.firstOrNull {
          it.type == AccessibilityWindowInfo.TYPE_APPLICATION && (it.isActive || it.isFocused) &&
            (PanelActivity.current == null || it.id != root.windowId)
        } ?: return@runCatching null
        val appRoot = if (Build.VERSION.SDK_INT >= 33) underlying.getRoot(0) else underlying.root
        try { appRoot?.packageName?.toString()?.takeIf { it.isNotBlank() } }
        finally { appRoot?.recycle() }
      } finally { windows.forEach { it.recycle() } }
    } finally { root.recycle() }
  }.getOrNull()
  override fun onChange(fn: (String?) -> Unit): () -> Unit = watch.onChange(fn)
  internal fun close() = watch.close()
}

/** The input method window's top, from the service's window list (needs `flagRetrieveInteractiveWindows`). */
class AccessibilityKeyboardInset(private val service: AccessibilityService) : KeyboardInset {
  private val watch = Watch { imeTopPx }
  override val imeTopPx: Int? get() = runCatching {
    service.windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
      ?.let { Rect().also(it::getBoundsInScreen).top }
  }.getOrNull()
  override fun onChange(fn: (Int?) -> Unit): () -> Unit = watch.onChange(fn)
  internal fun close() = watch.close()
}

/**
 * The focused editable field's screen bounds (needs `canRetrieveWindowContent`), from one focus snapshot on a worker
 * thread; null with no focus or on a password path. Only the bounds leave it, never the text.
 */
class AccessibilityFocusedFieldBox(private val service: AccessibilityService) : FocusedFieldBox {
  private val thread = HandlerThread("byokit-focused-field").apply { start() }
  private val worker = Handler(thread.looper)
  private val main = Handler(Looper.getMainLooper())
  // ponytail: walks the focused window's tree every POLL_MS while the bubble is on; take focus events from the app's
  // service if that ever costs too much.
  private val watch = Watch(worker, ::box)

  private fun box(): ClearRect? = runCatching {
    FocusedFields.focusNow(service)?.let { node ->
      try { Rect().also(node::getBoundsInScreen) } finally { @Suppress("DEPRECATION") node.recycle() }
    }
  }.getOrNull()?.let { ClearRect(it.left, it.top, it.width(), it.height()) }

  override fun onChange(fn: (ClearRect?) -> Unit): () -> Unit {
    val off = watch.onChange(fn)
    var on = true
    // The current box too, so a field already in focus is kept clear at once.
    worker.post { val now = box(); main.post { if (on) fn(now) } }
    return { on = false; off() }
  }

  internal fun close() { watch.close(); thread.quitSafely() }
}

/**
 * A value read from the service on [thread] (the main thread by default), re-read while anyone listens and reported
 * on the main thread when it changes. The kit gets the app's service only through attach, not its events, so it
 * polls. Listen from the main thread.
 * ponytail: polls every POLL_MS while a listener exists; take events from the app's service if that ever costs too much.
 */
internal class Watch<T>(private val thread: Handler = Handler(Looper.getMainLooper()), private val read: () -> T) {
  private val main = Handler(Looper.getMainLooper())
  private val listeners = Listeners<T>()
  private var count = 0
  @Volatile private var running = false
  private var last: T? = null // on [thread] only
  private val tick = object : Runnable {
    override fun run() {
      if (!running) return
      val now = read()
      if (now != last) { last = now; main.post { if (running) listeners.emit(now) } }
      thread.postDelayed(this, POLL_MS)
    }
  }
  // One poll at a time, even after a quick stop and start left the last one queued.
  private val start = Runnable { thread.removeCallbacks(tick); last = read(); thread.postDelayed(tick, POLL_MS) }

  fun onChange(fn: (T) -> Unit): () -> Unit {
    val remove = listeners.add(fn)
    if (count++ == 0) { running = true; thread.post(start) }
    var removed = false
    return {
      if (!removed) {
        removed = true
        remove()
        if (--count == 0) { running = false; thread.removeCallbacks(start); thread.removeCallbacks(tick) }
      }
    }
  }

  fun close() { count = 0; running = false; thread.removeCallbacks(start); thread.removeCallbacks(tick) }

  companion object {
    const val POLL_MS = 400L
  }
}

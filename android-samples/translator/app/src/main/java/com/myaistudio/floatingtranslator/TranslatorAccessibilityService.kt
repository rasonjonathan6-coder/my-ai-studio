package com.myaistudio.floatingtranslator

import android.accessibilityservice.AccessibilityService
import android.os.Build
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Tracks the field the user is typing into, and injects translated text into it.
 *
 * Two things limit this in practice and neither is hidden from the user:
 *  - the target app must expose its view tree to accessibility; an app that
 *    opts out returns an empty window, so there is no node to read or write;
 *  - injection uses `ACTION_SET_TEXT`, which an app may refuse. The write is
 *    always read back to confirm, and a refusal is reported rather than assumed
 *    to have worked.
 */
class TranslatorAccessibilityService : AccessibilityService() {

    /** The bubble and panel shown while the service is enabled. */
    private var overlay: OverlayView? = null

    override fun onServiceConnected() {
        instance = this
        // The overlay lives and dies with the service: without accessibility
        // there is nothing to translate, so the bubble would only be in the way.
        overlay = OverlayView(applicationContext).also {
            OverlayController.attach(it)
            it.showBubble()
        }
        announce("service connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val ev = event ?: return
        if (ev.packageName?.toString() == packageName) return
        when (ev.eventType) {
            AccessibilityEvent.TYPE_VIEW_FOCUSED,
            AccessibilityEvent.TYPE_VIEW_CLICKED,
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
            AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED,
            AccessibilityEvent.TYPE_VIEW_SCROLLED,
            -> {
                refreshFocusedField(ev)
                if (ev.eventType != AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED) captureVisibleText(ev)
            }
        }
    }

    override fun onInterrupt() {
        // Nothing to interrupt: the service only reacts to events.
    }

    override fun onDestroy() {
        OverlayController.detach()
        overlay?.shutdown()
        overlay = null
        if (instance === this) instance = null
        super.onDestroy()
    }

    /**
     * Records the node the user is interacting with so a later injection has a
     * target. The reference is refreshed on every event because
     * AccessibilityNodeInfo objects are invalidated when the window is rebuilt.
     */
    private fun refreshFocusedField(event: AccessibilityEvent) {
        val fromEvent = event.source
        if (fromEvent != null && isEditableField(fromEvent)) {
            focusedField = fromEvent
            announce("focus: ${describe(fromEvent)}")
            return
        }
        // Fall back to asking the active window, which is what most events need.
        val root = runCatching { rootInActiveWindow }.getOrNull() ?: return
        val found = runCatching { root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }.getOrNull()
        if (found != null && isEditableField(found)) {
            focusedField = found
            announce("focus: ${describe(found)}")
        }
    }

    private fun isEditableField(node: AccessibilityNodeInfo): Boolean {
        if (node.isEditable) return true
        val cls = node.className?.toString() ?: return false
        return cls.contains("EditText")
    }

    private fun describe(node: AccessibilityNodeInfo): String {
        val cls = node.className?.toString()?.substringAfterLast('.') ?: "?"
        // hintText is API 26+; minSdk is 24, so it must be guarded or the app
        // would crash on older devices the moment a field gains focus.
        val hint = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            node.hintText?.toString().orEmpty()
        } else {
            ""
        }
        return if (hint.isBlank()) cls else "$cls($hint)"
    }

    /** Collects text the target app exposes, newest last, for "translate the last message". */
    private fun captureVisibleText(event: AccessibilityEvent) {
        val collected = mutableListOf<String>()
        val fromEvent = eventText(event)
        if (fromEvent.isNotBlank()) collected.add(fromEvent)

        val root = runCatching { rootInActiveWindow }.getOrNull()
        if (root != null) {
            val out = mutableListOf<String>()
            runCatching { walk(root, out) }
            collected.addAll(out)
        }
        if (collected.isEmpty()) return

        lastVisible = collected
        val newest = TranslatorCore.lastNewMessage(collected, lastTranslatedSource)
        if (newest != null) {
            announce("last message candidate: ${TranslatorCore.preview(newest)}")
        }
        OverlayController.onTextAvailable(collected, newest)
    }

    private fun eventText(event: AccessibilityEvent): String =
        TranslatorCore.normalize(event.text.joinToString(" "))

    private fun walk(node: AccessibilityNodeInfo, out: MutableList<String>) {
        val cls = node.className?.toString()
        var text: CharSequence? = node.text
        if (text.isNullOrBlank()) text = node.contentDescription
        if (TranslatorCore.isReadableMessageNode(cls, text?.toString(), node.isEditable)) {
            out.add(text.toString())
        }
        for (i in 0 until node.childCount) {
            val child = runCatching { node.getChild(i) }.getOrNull() ?: continue
            walk(child, out)
        }
    }

    /**
     * Injects [text] into the tracked field and verifies the write.
     *
     * `ACTION_SET_TEXT` replaces the whole field; when the API is unavailable or
     * the app refuses, the failure is returned instead of a success.
     */
    fun injectIntoField(text: String): TranslatorAccessibilityService.InjectionResult {
        val target = focusedField ?: currentEditable() ?: return InjectionResult.NoField
        if (!isEditableField(target)) return InjectionResult.NotAField

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
            return InjectionResult.Unsupported("ACTION_SET_TEXT needs API 21+")
        }

        // Keep what the field held, so a refused write is reported as refused
        // rather than looking like it did something.
        val before = target.text?.toString().orEmpty()

        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        val accepted = runCatching {
            target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        }.getOrElse { return InjectionResult.Error(it.message ?: it.javaClass.simpleName) }

        if (!accepted) return InjectionResult.Refused

        // Re-reading is the only evidence the text landed. Some apps accept the
        // action and discard it, which would otherwise read as success.
        val after = reReadField(target)
        if (TranslatorCore.injectionLanded(text, after)) return InjectionResult.Injected
        return InjectionResult.NotVerified(expected = text, actual = after?.toString(), previous = before)
    }

    /** The field is re-read after the write because the action rebuilds the node. */
    private fun reReadField(node: AccessibilityNodeInfo): CharSequence? {
        val direct = runCatching { node.text }.getOrNull()
        if (TranslatorCore.injectionLanded(node.text?.toString().orEmpty(), direct)) return direct
        val root = runCatching { rootInActiveWindow }.getOrNull() ?: return direct
        val focus = runCatching { root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }.getOrNull() ?: return direct
        return runCatching { focus.text }.getOrNull() ?: direct
    }

    private fun currentEditable(): AccessibilityNodeInfo? {
        val root = runCatching { rootInActiveWindow }.getOrNull() ?: return null
        val focus = runCatching { root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }.getOrNull()
        return if (focus != null && isEditableField(focus)) focus else null
    }

    /** Text of the field the user is in, or null when accessibility cannot see one. */
    fun currentFieldText(): String? = focusedField?.text?.toString()?.takeIf { it.isNotBlank() }

    private fun announce(text: String) {
        OverlayController.onServiceStatus(text, "info")
    }

    sealed interface InjectionResult {
        object Injected : InjectionResult
        object NoField : InjectionResult
        object NotAField : InjectionResult
        object Refused : InjectionResult
        data class Unsupported(val reason: String) : InjectionResult
        data class Error(val reason: String) : InjectionResult
        data class NotVerified(val expected: String, val actual: String?, val previous: String) : InjectionResult
    }

    companion object {
        @Volatile
        var instance: TranslatorAccessibilityService? = null
            private set

        /** Node of the field the user is typing into, refreshed on each event. */
        @Volatile
        var focusedField: AccessibilityNodeInfo? = null

        /** Text nodes seen in the active window, oldest first. */
        @Volatile
        var lastVisible: List<String> = emptyList()

        /** The message already translated, so it is not translated twice. */
        @Volatile
        var lastTranslatedSource: String? = null

        fun isEnabled(): Boolean = instance != null
    }
}

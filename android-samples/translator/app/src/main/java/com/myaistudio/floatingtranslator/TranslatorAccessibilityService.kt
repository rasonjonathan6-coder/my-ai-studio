package com.myaistudio.floatingtranslator

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent

/**
 * Accessibility service that captures selected text and asks the backend
 * translation endpoint for a translation. Requires explicit user consent in
 * system settings; availability is not universal because many applications
 * restrict accessibility access.
 */
class TranslatorAccessibilityService : AccessibilityService() {
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val text = event?.text?.joinToString(" ")?.trim().orEmpty()
        if (text.isNotEmpty()) {
            lastSelectedText = text
        }
    }

    override fun onInterrupt() {
        // no-op
    }

    companion object {
        @Volatile
        var lastSelectedText: String = ""
    }
}

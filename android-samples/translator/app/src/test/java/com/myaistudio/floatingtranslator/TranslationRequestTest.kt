package com.myaistudio.floatingtranslator

import org.junit.Assert.assertTrue
import org.junit.Test

class TranslationRequestTest {
    @Test
    fun serviceExposesCapturedText() {
        TranslatorAccessibilityService.lastSelectedText = "hello"
        assertTrue(TranslatorAccessibilityService.lastSelectedText.isNotEmpty())
    }
}

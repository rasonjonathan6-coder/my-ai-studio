package com.myaistudio.floatingtranslator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for the logic that decides what the translator does.
 *
 * Everything here is a pure function, so it runs on the JVM with no device.
 * What the tests cannot cover is whether a given third-party app exposes its
 * views or accepts injection; that needs a phone and is recorded as such.
 */
class TranslatorCoreTest {

    // ---------------------------------------------------------------- JSON body

    @Test
    fun bodyEscapesTheCharactersThatWouldBreakTheJson() {
        val body = TranslatorCore.buildTranslateBody("say \"hi\"\nnow\\then", null, null)
        assertEquals("{\"text\":\"say \\\"hi\\\"\\nnow\\\\then\"}", body)
    }

    @Test
    fun bodyOmitsLanguagesItDoesNotHave() {
        assertEquals("{\"text\":\"hi\"}", TranslatorCore.buildTranslateBody("hi", null, null))
        assertEquals("{\"text\":\"hi\"}", TranslatorCore.buildTranslateBody("hi", "", "  "))
    }

    @Test
    fun bodyIncludesLanguagesWhenGiven() {
        val body = TranslatorCore.buildTranslateBody("hi", "French", "English")
        assertEquals("{\"text\":\"hi\",\"source\":\"French\",\"target\":\"English\"}", body)
    }

    @Test
    fun bodyEscapesControlCharacters() {
        // A tab and a form feed would otherwise be literal bytes in a JSON string.
        val body = TranslatorCore.buildTranslateBody("a\tb\u000Cc", null, null)
        assertTrue(body.contains("\\t"))
        assertTrue(body.contains("\\f"))
    }

    // ------------------------------------------------------- response handling

    @Test
    fun successfulResponseIsRead() {
        val result = TranslatorCore.parseTranslation(
            "{\"ok\":true,\"translation\":\"Hello\",\"provider\":\"gemini\",\"model\":\"flash\"}",
        )
        assertTrue(result is TranslatorCore.TranslationResult.Ok)
        val ok = result as TranslatorCore.TranslationResult.Ok
        assertEquals("Hello", ok.translation)
        assertEquals("gemini", ok.provider)
    }

    @Test
    fun failureResponseKeepsTheProviderReason() {
        val result = TranslatorCore.parseTranslation(
            "{\"ok\":false,\"error\":\"translation_failed\",\"message\":\"rate limited\"}",
        )
        assertTrue(result is TranslatorCore.TranslationResult.Failed)
        val failed = result as TranslatorCore.TranslationResult.Failed
        assertTrue(failed.reason.contains("translation_failed"))
        assertTrue(failed.reason.contains("rate limited"))
    }

    @Test
    fun anEmptyTranslationIsAFailureNotAnEmptyString() {
        val result = TranslatorCore.parseTranslation("{\"ok\":true,\"translation\":\"   \"}")
        assertTrue(result is TranslatorCore.TranslationResult.Failed)
    }

    @Test
    fun unparseableBodyIsReportedAsSuch() {
        // A proxy error page, a truncated response: never treated as a translation.
        val result = TranslatorCore.parseTranslation("<html>502 Bad Gateway</html>")
        assertTrue(result is TranslatorCore.TranslationResult.Failed)
    }

    @Test
    fun missingOkFlagIsFailure() {
        val result = TranslatorCore.parseTranslation("{\"translation\":\"Hello\"}")
        assertTrue(result is TranslatorCore.TranslationResult.Failed)
    }

    // ------------------------------------------------------------- injection

    @Test
    fun injectionIsConfirmedOnlyWhenTheFieldMatches() {
        assertTrue(TranslatorCore.injectionLanded("Hello", "Hello"))
        // The field may reformat whitespace; that is not a different value.
        assertTrue(TranslatorCore.injectionLanded("Hello there", "Hello   there "))
    }

    @Test
    fun aRefusedOrRewrittenWriteIsNotSuccess() {
        assertFalse(TranslatorCore.injectionLanded("Hello", "Hello there"))
        assertFalse(TranslatorCore.injectionLanded("Hello", ""))
        assertFalse(TranslatorCore.injectionLanded("Hello", null))
        assertFalse(TranslatorCore.injectionLanded("Hello", "hello world"))
    }

    // ---------------------------------------------------------- last message

    @Test
    fun newestMessageIsChosen() {
        val picked = TranslatorCore.lastNewMessage(listOf("old one", "middle", "newest here"), null)
        assertEquals("newest here", picked)
    }

    @Test
    fun theMessageAlreadyTranslatedIsSkipped() {
        // Re-translating the same bubble on every event would spam the overlay.
        val picked = TranslatorCore.lastNewMessage(listOf("first", "second"), "second")
        assertEquals("first", picked)
    }

    @Test
    fun nothingNewYieldsNothing() {
        assertNull(TranslatorCore.lastNewMessage(listOf("only message"), "only message"))
        assertNull(TranslatorCore.lastNewMessage(emptyList(), null))
    }

    @Test
    fun timestampsAndBulletsAreNotMessages() {
        // A chat list exposes plenty of these; they must not be picked.
        val picked = TranslatorCore.lastNewMessage(listOf("12:04", "\u2022", "a", "the real message"), null)
        assertEquals("the real message", picked)
    }

    @Test
    fun dedupIgnoresCaseAndWhitespace() {
        assertTrue(TranslatorCore.isSameMessage("Hello  There", "hello there"))
        assertNull(TranslatorCore.lastNewMessage(listOf("Hello There"), "hello   there"))
    }

    // ------------------------------------------------------------- node filter

    @Test
    fun textViewsAreReadableButEditableFieldsAreNot() {
        assertTrue(TranslatorCore.isReadableMessageNode("android.widget.TextView", "hi", editable = false))
        assertFalse(TranslatorCore.isReadableMessageNode("android.widget.EditText", "typed", editable = true))
        // An editable node is excluded even if it does not call itself an EditText.
        assertFalse(TranslatorCore.isReadableMessageNode("android.widget.TextView", "typed", editable = true))
    }

    @Test
    fun chromeAndButtonsAreNotMessages() {
        assertFalse(TranslatorCore.isReadableMessageNode("android.widget.Button", "Send", editable = false))
        assertFalse(TranslatorCore.isReadableMessageNode("android.widget.ImageButton", "Back", editable = false))
        assertFalse(TranslatorCore.isReadableMessageNode("android.widget.CheckBox", "Yes", editable = false))
        assertFalse(TranslatorCore.isReadableMessageNode("android.view.View", "x", editable = false))
        assertFalse(TranslatorCore.isReadableMessageNode(null, "x", editable = false))
    }

    @Test
    fun blankTextIsNeverAMessage() {
        assertFalse(TranslatorCore.isReadableMessageNode("android.widget.TextView", "", editable = false))
        assertFalse(TranslatorCore.isReadableMessageNode("android.widget.TextView", "   ", editable = false))
        assertFalse(TranslatorCore.isReadableMessageNode("android.widget.TextView", null, editable = false))
    }

    // ---------------------------------------------------------------- preview

    @Test
    fun previewCollapsesWhitespaceAndTruncates() {
        assertEquals("a b", TranslatorCore.preview("a \n  b"))
        val long = "x".repeat(200)
        val preview = TranslatorCore.preview(long, 10)
        assertEquals(11, preview.length) // 10 characters plus the ellipsis
        assertTrue(preview.endsWith("\u2026"))
    }

    @Test
    fun previewDoesNotSplitASurrogatePair() {
        // An emoji is two chars; truncating between them would render as a box.
        val emoji = "\uD83D\uDE00"
        val preview = TranslatorCore.preview(emoji.repeat(4), 1)
        assertFalse(preview.startsWith(emoji.substring(0, 1)))
    }

    // ------------------------------------------------------------- endpoint

    @Test
    fun endpointIsBuiltFromTheServerUrl() {
        assertEquals(
            "http://10.0.2.2:8080/api/translate",
            TranslationClient.endpointFor("http://10.0.2.2:8080"),
        )
        assertEquals(
            "http://10.0.2.2:8080/api/translate",
            TranslationClient.endpointFor("http://10.0.2.2:8080/"),
        )
        // Already pointing at the endpoint: do not append it twice.
        assertEquals(
            "https://studio.example/api/translate",
            TranslationClient.endpointFor("https://studio.example/api/translate"),
        )
    }

    @Test
    fun anUnconfiguredClientFailsWithoutSendingAnything() {
        val noUrl = TranslationClient.translate(TranslationClient.Config("", "token"), "hi", null, null)
        assertTrue(noUrl is TranslatorCore.TranslationResult.Failed)
        val noToken = TranslationClient.translate(TranslationClient.Config("http://localhost:1", ""), "hi", null, null)
        assertTrue(noToken is TranslatorCore.TranslationResult.Failed)
    }

    @Test
    fun anInvalidUrlIsReportedRatherThanThrown() {
        val result = TranslationClient.translate(TranslationClient.Config("not a url", "token"), "hi", null, null)
        assertTrue(result is TranslatorCore.TranslationResult.Failed)
        assertTrue((result as TranslatorCore.TranslationResult.Failed).reason.contains("invalid server URL"))
    }
}

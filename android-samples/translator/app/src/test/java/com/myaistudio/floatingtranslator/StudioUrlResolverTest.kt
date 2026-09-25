package com.myaistudio.floatingtranslator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for reading the studio address out of the discovery document.
 *
 * Everything here is a pure function, so it runs on the JVM with no device. What
 * the tests cannot cover is whether the published document is reachable from a
 * given phone; that is a network fact and is reported at runtime instead.
 */
class StudioUrlResolverTest {

    private fun resolved(body: String): String? =
        (StudioUrlResolver.parseStudioUrl(body) as? StudioUrlResolver.Result.Resolved)?.studioUrl

    private fun failure(body: String): String? =
        (StudioUrlResolver.parseStudioUrl(body) as? StudioUrlResolver.Result.Failed)?.reason

    // ------------------------------------------------------------ reading `url`

    @Test
    fun thePublishedDocumentIsRead() {
        val body = """
            {
              "schema": 1,
              "service": "my-ai-studio",
              "url": "https://work-1-mhfmdgfvdofypukx.prod-runtime.all-hands.dev",
              "previousUrl": null,
              "updatedAt": "2026-09-25T08:25:51.288Z",
              "status": "online"
            }
        """.trimIndent()

        assertEquals("https://work-1-mhfmdgfvdofypukx.prod-runtime.all-hands.dev", resolved(body))
    }

    @Test
    fun theAddressIsReadEvenWhenTheDocumentReportsItOffline() {
        // Reachability is decided by the request succeeding, not by a flag someone
        // else wrote, so a stale status must not hide a usable address.
        val body = """{"schema":1,"service":"my-ai-studio","url":"https://studio.example","status":"offline"}"""
        assertEquals("https://studio.example", resolved(body))
    }

    @Test
    fun aPathOnTheAddressIsDroppedSoEndpointsDoNotInheritIt() {
        val body = """{"schema":1,"service":"my-ai-studio","url":"https://studio.example/prefix"}"""
        assertEquals("https://studio.example", resolved(body))
    }

    @Test
    fun aPortIsKept() {
        val body = """{"schema":1,"service":"my-ai-studio","url":"http://10.0.2.2:8080"}"""
        assertEquals("http://10.0.2.2:8080", resolved(body))
    }

    // ------------------------------------------------------------ refusing bad input

    @Test
    fun aDocumentForAnotherServiceIsRefused() {
        val body = """{"schema":1,"service":"something-else","url":"https://studio.example"}"""
        assertTrue(failure(body)!!.contains("not for this service"))
    }

    @Test
    fun aNewerSchemaIsRefusedRatherThanGuessedAt() {
        // A future document may move `url`; reading it anyway could silently point
        // the app at the wrong host.
        val body = """{"schema":2,"service":"my-ai-studio","url":"https://studio.example"}"""
        assertTrue(failure(body)!!.contains("unsupported schema"))
    }

    @Test
    fun aMissingSchemaIsRefused() {
        val body = """{"service":"my-ai-studio","url":"https://studio.example"}"""
        assertTrue(failure(body)!!.contains("unsupported schema"))
    }

    @Test
    fun aDocumentWithoutAUrlIsRefused() {
        val body = """{"schema":1,"service":"my-ai-studio"}"""
        assertTrue(failure(body)!!.contains("has no url"))
    }

    @Test
    fun anEmptyUrlIsRefused() {
        val body = """{"schema":1,"service":"my-ai-studio","url":"   "}"""
        assertTrue(failure(body)!!.contains("has no url"))
    }

    @Test
    fun anUnparseableDocumentIsAFailureNotAnAddress() {
        assertTrue(failure("not json at all")!!.contains("unreadable document"))
        assertTrue(failure("")!!.contains("unreadable document"))
    }

    // ------------------------------------------------------------------- validation

    @Test
    fun onlyHttpAndHttpsAreAccepted() {
        assertEquals("https://studio.example", StudioUrlResolver.normalizeBaseUrl("https://studio.example"))
        assertEquals("http://studio.example", StudioUrlResolver.normalizeBaseUrl("http://studio.example"))
        // A non-http scheme must never reach the network layer.
        assertEquals(null, StudioUrlResolver.normalizeBaseUrl("javascript:alert(1)"))
        assertEquals(null, StudioUrlResolver.normalizeBaseUrl("file:///etc/passwd"))
        assertEquals(null, StudioUrlResolver.normalizeBaseUrl("ftp://studio.example"))
    }

    @Test
    fun blankAndHostlessValuesAreRefused() {
        assertEquals(null, StudioUrlResolver.normalizeBaseUrl(""))
        assertEquals(null, StudioUrlResolver.normalizeBaseUrl("   "))
        // A scheme with no authority parses as a URI but has no host.
        assertEquals(null, StudioUrlResolver.normalizeBaseUrl("https:"))
    }

    @Test
    fun theDiscoveryHostItselfIsRefusedToAvoidAResolutionLoop() {
        assertEquals(null, StudioUrlResolver.normalizeBaseUrl("https://raw.githubusercontent.com/x/y/main/url.json"))
        assertEquals(null, StudioUrlResolver.normalizeBaseUrl("https://github.com/rasonjonathan6-coder/my-ai-studio"))
        assertTrue(StudioUrlResolver.isDiscoveryHost("raw.githubusercontent.com"))
        assertTrue(StudioUrlResolver.isDiscoveryHost("GitHub.com"))
        assertTrue(StudioUrlResolver.isDiscoveryHost("objects.githubusercontent.com"))
        assertFalse(StudioUrlResolver.isDiscoveryHost("studio.example"))
        assertFalse(StudioUrlResolver.isDiscoveryHost("notgithub.com"))
    }

    @Test
    fun theSourceUrlIsThePublishedDocument() {
        assertEquals(
            "https://raw.githubusercontent.com/rasonjonathan6-coder/my-ai-studio/main/url.json",
            StudioUrlResolver.SOURCE_URL,
        )
    }

    // ------------------------------------------------------------------- end-to-end of parse

    @Test
    fun aValidatedAddressSurvivesTheWholeParse() {
        val body = """{"schema":1,"service":"my-ai-studio","url":"https://studio.example/api/translate"}"""
        assertEquals("https://studio.example", resolved(body))
    }

    @Test
    fun aDocumentPointingAtItsOwnHostIsRefused() {
        val body = """{"schema":1,"service":"my-ai-studio","url":"https://raw.githubusercontent.com/a/b/main/url.json"}"""
        assertTrue(failure(body)!!.contains("not a usable"))
    }
}

package com.myaistudio.floatingtranslator

import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

/**
 * Discovers where the My AI Studio backend currently lives.
 *
 * The studio runs on an ephemeral host, so its address cannot be compiled into
 * the APK: that would tie a shipped build to one host and force a new APK every
 * time the host moves. Instead the address is published at [SOURCE_URL] and read
 * at runtime, so moving the backend never requires rebuilding this app.
 *
 * The source holds a public URL and nothing else. No token or key is read, sent
 * or stored here, and the request carries no credentials.
 */
object StudioUrlResolver {

    /**
     * Public, unauthenticated document holding `{ schema, service, url, ... }`.
     * Served by raw.githubusercontent.com, whose cache is short-lived and which
     * answers without an API token.
     */
    const val SOURCE_URL =
        "https://raw.githubusercontent.com/rasonjonathan6-coder/my-ai-studio/main/url.json"

    /** Only a document that names this service is trusted. */
    const val EXPECTED_SERVICE = "my-ai-studio"

    /**
     * The only schema this build understands. A newer document may move `url`
     * elsewhere, and reading the field anyway would silently point the app at the
     * wrong host, so an unknown version is refused rather than guessed at.
     */
    const val EXPECTED_SCHEMA = 1

    sealed interface Result {
        data class Resolved(val studioUrl: String) : Result
        data class Failed(val reason: String) : Result
    }

    /**
     * Reads `url` out of the discovery document. Deliberately ignores every other
     * field, including `status`: reachability is decided by the request actually
     * succeeding, not by a flag someone else wrote.
     */
    fun parseStudioUrl(body: String): Result = try {
        val json = JSONObject(body)

        val service = json.optString("service", "")
        val schema = json.optInt("schema", -1)
        val raw = json.optString("url", "")

        when {
            service != EXPECTED_SERVICE ->
                Result.Failed("document is not for this service (service=\"$service\")")
            schema != EXPECTED_SCHEMA ->
                Result.Failed("unsupported schema $schema, this build reads $EXPECTED_SCHEMA")
            raw.isBlank() ->
                Result.Failed("document has no url")
            else -> normalizeBaseUrl(raw)
                ?.let { Result.Resolved(it) }
                ?: Result.Failed("document url is not a usable http(s) address")
        }
    } catch (e: Exception) {
        Result.Failed("unreadable document: ${e.message ?: e.javaClass.simpleName}")
    }

    /**
     * Returns the origin of [raw] - scheme, host and port, with any path, query and
     * fragment dropped - or null when it is not an http(s) address.
     *
     * The path is dropped on purpose: callers append `/api/...` to this value, so a
     * leftover path would be carried into every endpoint.
     */
    fun normalizeBaseUrl(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null

        val uri = try {
            URI(trimmed)
        } catch (e: Exception) {
            return null
        }

        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null

        // URI parses "javascript:alert(1)" with a scheme but no authority at all.
        val host = uri.host ?: return null
        if (host.isBlank()) return null

        // A discovery document pointing at its own host would make the app resolve
        // to the document instead of the studio, so that address is refused.
        if (isDiscoveryHost(host)) return null

        val port = if (uri.port == -1) "" else ":${uri.port}"
        return "$scheme://$host$port"
    }

    /** Hosts that serve the discovery document rather than the studio itself. */
    fun isDiscoveryHost(host: String): Boolean {
        val h = host.lowercase()
        return h == "github.com" || h == "raw.githubusercontent.com" || h.endsWith(".githubusercontent.com")
    }

    /**
     * The address callers should talk to: a manually entered override when one is
     * set, otherwise the address published in the discovery document.
     *
     * The override exists for the cases discovery cannot serve - a dev server on
     * the LAN, or a studio whose document has not caught up - and it is validated
     * the same way so a typo is reported instead of used.
     */
    fun resolveBaseUrl(overrideUrl: String): Result {
        val trimmed = overrideUrl.trim()
        if (trimmed.isEmpty()) return fetch()

        return normalizeBaseUrl(trimmed)
            ?.let { Result.Resolved(it) }
            ?: Result.Failed("the override address is not a usable http(s) address")
    }

    /**
     * Fetches [sourceUrl] and resolves the studio address from it.
     *
     * Blocks, so callers must invoke it off the main thread. Every failure - no
     * network, timeout, non-2xx, truncated or invalid document - comes back as
     * [Result.Failed] with the reason, never as an exception and never as a
     * made-up address.
     */
    fun fetch(sourceUrl: String = SOURCE_URL, connectTimeoutMs: Int = 10_000, readTimeoutMs: Int = 15_000): Result {
        val url = try {
            URL(sourceUrl)
        } catch (e: Exception) {
            return Result.Failed("invalid source url: ${e.message}")
        }

        var connection: HttpURLConnection? = null
        return try {
            connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                setRequestProperty("Accept", "application/json")
                // No Authorization header: the document is public and carries no secret.
                instanceFollowRedirects = true
                connectTimeout = connectTimeoutMs
                readTimeout = readTimeoutMs
            }

            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()

            if (status !in 200..299) {
                Result.Failed("discovery document answered HTTP $status")
            } else if (body.isBlank()) {
                Result.Failed("discovery document is empty")
            } else {
                parseStudioUrl(body)
            }
        } catch (e: Exception) {
            Result.Failed("could not reach the discovery document: ${e.message ?: e.javaClass.simpleName}")
        } finally {
            runCatching { connection?.disconnect() }
        }
    }
}

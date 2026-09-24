package com.myaistudio.floatingtranslator

import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * Calls the studio's own `/api/translate` endpoint.
 *
 * The provider key lives on the server, so nothing secret is compiled into this
 * APK. The call carries the session bearer token the user pasted into settings;
 * without it the endpoint answers 401 and the error is surfaced.
 */
object TranslationClient {

    data class Config(val baseUrl: String, val token: String)

    fun endpointFor(baseUrl: String): String {
        val trimmed = baseUrl.trim().trimEnd('/')
        return if (trimmed.endsWith("/api/translate")) trimmed else "$trimmed/api/translate"
    }

    /**
     * Runs one translation. Blocks, so callers must invoke it off the main
     * thread. Every failure path returns [TranslatorCore.TranslationResult.Failed]
     * with the reason the server or the network gave.
     */
    fun translate(config: Config, text: String, source: String?, target: String?): TranslatorCore.TranslationResult {
        if (config.baseUrl.isBlank()) return TranslatorCore.TranslationResult.Failed("server URL is not set")
        if (config.token.isBlank()) return TranslatorCore.TranslationResult.Failed("session token is not set")

        val url = try {
            URL(endpointFor(config.baseUrl))
        } catch (e: Exception) {
            return TranslatorCore.TranslationResult.Failed("invalid server URL: ${e.message}")
        }

        var connection: HttpURLConnection? = null
        return try {
            connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Authorization", "Bearer ${config.token}")
                connectTimeout = 10_000
                readTimeout = 30_000
            }
            val body = TranslatorCore.buildTranslateBody(text, source, target)
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }

            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val payload = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()

            if (payload.isBlank()) {
                TranslatorCore.TranslationResult.Failed("server answered HTTP $status with an empty body")
            } else {
                val parsed = TranslatorCore.parseTranslation(payload)
                // A non-2xx body can still be well-formed; the status must win so
                // a rejected request is not mistaken for a translation.
                if (status !in 200..299 && parsed is TranslatorCore.TranslationResult.Ok) {
                    TranslatorCore.TranslationResult.Failed("server answered HTTP $status")
                } else {
                    parsed
                }
            }
        } catch (e: Exception) {
            TranslatorCore.TranslationResult.Failed("request failed: ${e.message ?: e.javaClass.simpleName}")
        } finally {
            runCatching { connection?.disconnect() }
        }
    }
}

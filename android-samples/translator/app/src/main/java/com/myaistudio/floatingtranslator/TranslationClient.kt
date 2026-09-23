package com.myaistudio.floatingtranslator

import java.net.HttpURLConnection
import java.net.URL

/**
 * Minimal HTTP client. Translation must be requested from a server-side
 * endpoint so no API key is ever embedded in the APK.
 */
object TranslationClient {
    fun buildBody(text: String): String {
        val escaped = text.replace("\\", "\\\\").replace("\"", "\\\"")
        return "{\"text\": \"" + escaped + "\"}"
    }

    fun translate(text: String, endpoint: String): String {
        val connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            connectTimeout = 10000
            readTimeout = 15000
        }
        connection.outputStream.use { it.write(buildBody(text).toByteArray()) }
        return connection.inputStream.bufferedReader().use { it.readText() }
    }
}

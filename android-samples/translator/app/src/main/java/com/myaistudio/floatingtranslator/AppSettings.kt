package com.myaistudio.floatingtranslator

import android.content.Context
import androidx.core.content.edit

/**
 * User-supplied connection settings.
 *
 * The server URL and the session token are entered by the user and kept in this
 * app's private preferences. No provider key is stored here, because none is
 * needed: the APK only ever talks to the studio backend.
 */
object AppSettings {

    private const val FILE = "floating_translator_settings"
    private const val KEY_BASE_URL = "base_url"
    private const val KEY_TOKEN = "session_token"
    private const val KEY_TARGET = "reply_target_language"
    private const val KEY_SOURCE = "read_target_language"
    private const val KEY_AUTO_READ = "auto_translate_last_message"

    /** Default points at the emulator's loopback alias for the host machine. */
    const val DEFAULT_BASE_URL = "http://10.0.2.2:8080"

    data class Snapshot(
        val baseUrl: String,
        val token: String,
        /** Language injected text is produced in (reply flow, FR -> EN by default). */
        val replyTarget: String,
        /** Language the last message is shown in (read flow, EN -> FR by default). */
        val readTarget: String,
        val autoTranslateLastMessage: Boolean,
    ) {
        val configured: Boolean get() = baseUrl.isNotBlank() && token.isNotBlank()
    }

    fun load(context: Context): Snapshot {
        val prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        return Snapshot(
            baseUrl = prefs.getString(KEY_BASE_URL, DEFAULT_BASE_URL).orEmpty(),
            token = prefs.getString(KEY_TOKEN, "").orEmpty(),
            replyTarget = prefs.getString(KEY_TARGET, "English").orEmpty().ifBlank { "English" },
            readTarget = prefs.getString(KEY_SOURCE, "French").orEmpty().ifBlank { "French" },
            autoTranslateLastMessage = prefs.getBoolean(KEY_AUTO_READ, true),
        )
    }

    fun save(context: Context, snapshot: Snapshot) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit {
            putString(KEY_BASE_URL, snapshot.baseUrl.trim())
            putString(KEY_TOKEN, snapshot.token.trim())
            putString(KEY_TARGET, snapshot.replyTarget.trim())
            putString(KEY_SOURCE, snapshot.readTarget.trim())
            putBoolean(KEY_AUTO_READ, snapshot.autoTranslateLastMessage)
        }
    }
}

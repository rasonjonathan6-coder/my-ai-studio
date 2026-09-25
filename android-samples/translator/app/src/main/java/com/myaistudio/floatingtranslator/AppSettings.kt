package com.myaistudio.floatingtranslator

import android.content.Context
import androidx.core.content.edit

/**
 * User-supplied connection settings.
 *
 * The session token is entered by the user and kept in this app's private
 * preferences. No provider key is stored here, because none is needed: the APK
 * only ever talks to the studio backend.
 *
 * The server address is *not* kept here. It is discovered at runtime from
 * [StudioUrlResolver.SOURCE_URL], so a shipped APK does not have to be rebuilt
 * when the studio moves. A manually entered address survives only as an override
 * for cases the discovery document cannot cover, such as a dev server on the LAN.
 */
object AppSettings {

    private const val FILE = "floating_translator_settings"
    private const val KEY_TOKEN = "session_token"
    private const val KEY_OVERRIDE_URL = "base_url_override"
    private const val KEY_TARGET = "reply_target_language"
    private const val KEY_SOURCE = "read_target_language"
    private const val KEY_AUTO_READ = "auto_translate_last_message"

    data class Snapshot(
        /** Manual override, or blank to use the address read from the discovery document. */
        val baseUrlOverride: String,
        val token: String,
        /** Language injected text is produced in (reply flow, FR -> EN by default). */
        val replyTarget: String,
        /** Language the last message is shown in (read flow, EN -> FR by default). */
        val readTarget: String,
        val autoTranslateLastMessage: Boolean,
    ) {
        /**
         * Only the session token is required up front, because the server address
         * arrives from the discovery document. Requiring an address here would
         * defeat the point of discovering it.
         */
        val configured: Boolean get() = token.isNotBlank()
    }

    fun load(context: Context): Snapshot {
        val prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        return Snapshot(
            baseUrlOverride = prefs.getString(KEY_OVERRIDE_URL, "").orEmpty(),
            token = prefs.getString(KEY_TOKEN, "").orEmpty(),
            replyTarget = prefs.getString(KEY_TARGET, "English").orEmpty().ifBlank { "English" },
            readTarget = prefs.getString(KEY_SOURCE, "French").orEmpty().ifBlank { "French" },
            autoTranslateLastMessage = prefs.getBoolean(KEY_AUTO_READ, true),
        )
    }

    fun save(context: Context, snapshot: Snapshot) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit {
            putString(KEY_OVERRIDE_URL, snapshot.baseUrlOverride.trim())
            putString(KEY_TOKEN, snapshot.token.trim())
            putString(KEY_TARGET, snapshot.replyTarget.trim())
            putString(KEY_SOURCE, snapshot.readTarget.trim())
            putBoolean(KEY_AUTO_READ, snapshot.autoTranslateLastMessage)
        }
    }
}

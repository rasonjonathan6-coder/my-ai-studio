package com.myaistudio.floatingtranslator

import org.json.JSONObject

/**
 * Pure, Android-free logic.
 *
 * Everything here is a decision the app has to make that can be reasoned about
 * without a device: how a request is encoded, what a backend answer means,
 * whether injected text actually landed, and which node text counts as "the last
 * message". Keeping it out of the service means it is covered by real unit tests
 * instead of only by looking at the screen.
 */
object TranslatorCore {

    /** JSON string escaping. Written out rather than pulled in, so the APK has no JSON writer dep. */
    fun escapeJson(value: String): String {
        val sb = StringBuilder(value.length + 16)
        for (ch in value) {
            when (ch) {
                '\\' -> sb.append("\\\\")
                '"' -> sb.append("\\\"")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                else -> if (ch < ' ') sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
            }
        }
        return sb.toString()
    }

    fun buildTranslateBody(text: String, source: String?, target: String?): String {
        val sb = StringBuilder("{\"text\":\"").append(escapeJson(text)).append('"')
        if (!source.isNullOrBlank()) sb.append(",\"source\":\"").append(escapeJson(source)).append('"')
        if (!target.isNullOrBlank()) sb.append(",\"target\":\"").append(escapeJson(target)).append('"')
        return sb.append('}').toString()
    }

    /** What the backend told us. A failure keeps the provider's reason instead of inventing a translation. */
    sealed interface TranslationResult {
        data class Ok(val translation: String, val provider: String?, val model: String?) : TranslationResult
        data class Failed(val reason: String) : TranslationResult
    }

    /**
     * Reads the `/api/translate` contract: `{ ok, translation, provider, model }` on
     * success, `{ ok:false, error, message }` on failure. An unrecognised body is a
     * failure, never an empty translation.
     */
    fun parseTranslation(responseBody: String): TranslationResult = try {
        val json = JSONObject(responseBody)
        if (json.optBoolean("ok", false)) {
            val text = json.optString("translation", "")
            if (text.isBlank()) {
                TranslationResult.Failed("backend returned an empty translation")
            } else {
                TranslationResult.Ok(
                    translation = text,
                    provider = json.optString("provider", "").ifBlank { null },
                    model = json.optString("model", "").ifBlank { null },
                )
            }
        } else {
            val kind = json.optString("error", "error")
            val message = json.optString("message", "").ifBlank { json.optString("kind", "") }
            TranslationResult.Failed(if (message.isBlank()) kind else "$kind: $message")
        }
    } catch (e: Exception) {
        TranslationResult.Failed("unreadable backend response: ${e.message ?: e.javaClass.simpleName}")
    }

    /** Collapse whitespace so a comparison is not defeated by line-wrapping or trailing spaces. */
    fun normalize(value: String): String = value.replace(Regex("\\s+"), " ").trim()

    /**
     * Whether the field now holds what we asked for.
     *
     * ACTION_SET_TEXT replaces the whole field, so the read-back has to match the
     * text we asked for. A mismatch means the target app rejected or rewrote the
     * write, and the caller must not report success.
     */
    fun injectionLanded(expected: String, actual: CharSequence?): Boolean {
        if (actual == null) return false
        return normalize(actual.toString()) == normalize(expected)
    }

    /** Two texts are the same message when they differ only by whitespace or letter case. */
    fun isSameMessage(a: String, b: String): Boolean =
        normalize(a).equals(normalize(b), ignoreCase = true)

    /**
     * Picks the last message out of the text the target app exposes.
     *
     * Input is ordered oldest-first; the newest entry that is not a repeat of the
     * one already translated is what the user wants. Blank and single-character
     * fragments ("•", "12:04") are dropped, because a chat list exposes plenty of
     * those and they are never the message.
     */
    fun lastNewMessage(candidates: List<String>, alreadyTranslated: String?): String? {
        for (candidate in candidates.asReversed()) {
            val text = normalize(candidate)
            if (text.length < 2) continue
            if (text.none { it.isLetterOrDigit() }) continue
            if (alreadyTranslated != null && isSameMessage(text, alreadyTranslated)) continue
            return text
        }
        return null
    }

    /**
     * Whether a node is worth reading as a message. Chat bubbles are usually
     * `android.widget.TextView`; an editable field is excluded because that is the
     * text the user has not sent yet.
     */
    fun isReadableMessageNode(className: String?, text: String?, editable: Boolean): Boolean {
        if (editable) return false
        if (text.isNullOrBlank()) return false
        val cls = className ?: return false
        // Exclude chrome and containers; keep anything text-like.
        if (cls.endsWith("EditText")) return false
        if (cls.endsWith("Button") || cls.endsWith("ImageButton") || cls.endsWith("CheckBox")) return false
        return cls.contains("TextView", ignoreCase = true) ||
            cls.contains("WebView", ignoreCase = true) ||
            cls.endsWith("Text")
    }

    /** A short, safe rendering of text for an overlay label; never truncates mid-surrogate. */
    fun preview(value: String, max: Int = 80): String {
        val oneLine = normalize(value)
        if (oneLine.length <= max) return oneLine
        val cut = oneLine.substring(0, max)
        // Do not split a surrogate pair, which would render as a replacement char.
        val safe = if (cut.isNotEmpty() && Character.isHighSurrogate(cut.last())) cut.dropLast(1) else cut
        return "$safe…"
    }
}

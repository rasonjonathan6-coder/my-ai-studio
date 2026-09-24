package com.myaistudio.floatingtranslator

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout

/**
 * Settings and permission screen.
 *
 * This is where the user grants the two permissions the translator needs and
 * pastes the server URL and session token. It reports each permission as it
 * actually is, rather than as if it were granted.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var permissionsStatus: TextView
    private lateinit var urlField: TextInputEditText
    private lateinit var tokenField: TextInputEditText
    private lateinit var replyLangField: TextInputEditText
    private lateinit var readLangField: TextInputEditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildLayout())
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun matchWrap(): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)

    private fun text(value: String, size: Float, colorRes: Int): TextView = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(getColor(colorRes))
    }

    private fun hint(value: String): TextView = text(value, 12f, R.color.text_secondary)

    /** Builds a labelled input and returns both the wrapper and the field itself. */
    private fun input(label: String, value: String, password: Boolean = false): Pair<TextInputLayout, TextInputEditText> {
        val wrapper = TextInputLayout(this).apply {
            hint = label
            setPadding(0, dp(6), 0, 0)
        }
        val edit = TextInputEditText(this).apply {
            setText(value)
            textSize = 14f
            inputType = if (password) {
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            } else {
                InputType.TYPE_CLASS_TEXT
            }
        }
        wrapper.addView(edit)
        return wrapper to edit
    }

    private fun buildLayout(): View {
        val settings = AppSettings.load(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(24), dp(18), dp(24))
        }

        root.addView(text("Floating AI Translator", 22f, R.color.text_primary))
        root.addView(
            hint(
                "Translate text and inject it into other apps, or read the last visible message. " +
                    "No provider key is stored in this app: translation runs on your My AI Studio server.",
            ),
        )

        root.addView(card("Permissions") {
            permissionsStatus = text("", 13f, R.color.text_primary)
            addView(permissionsStatus)
            addView(button("Open accessibility settings") { openAccessibilitySettings() })
            addView(button("Open overlay settings") { openOverlaySettings() })
            addView(button("Refresh status") { refreshStatus() })
        })

        root.addView(card("Server") {
            val (urlWrap, urlEdit) = input("Server URL (e.g. http://10.0.2.2:8080)", settings.baseUrl)
            urlField = urlEdit
            addView(urlWrap)
            val (tokenWrap, tokenEdit) = input("Session token from /api/auth/login", settings.token, password = true)
            tokenField = tokenEdit
            addView(tokenWrap)
            addView(
                hint(
                    "Sign in to My AI Studio in a browser and copy the session token. " +
                        "This app sends it as a bearer token; the provider key never leaves the server.",
                ),
            )
        })

        root.addView(card("Languages") {
            val (replyWrap, replyEdit) = input("Language to reply in (injection target)", settings.replyTarget)
            replyLangField = replyEdit
            addView(replyWrap)
            val (readWrap, readEdit) = input("Language to read messages in", settings.readTarget)
            readLangField = readEdit
            addView(readWrap)
        })

        root.addView(Button(this).apply {
            text = "Save"
            setOnClickListener { saveSettings() }
            layoutParams = matchWrap().apply { topMargin = dp(14) }
        })

        root.addView(
            hint(
                "Reading other apps' text and injecting into them only works when the target app exposes " +
                    "its views to accessibility and accepts ACTION_SET_TEXT. Apps that block accessibility " +
                    "cannot be read or written, and the app will say so.",
            ),
        )

        return ScrollView(this).apply { addView(root) }
    }

    private fun button(label: String, onClick: () -> Unit): MaterialButton = MaterialButton(this).apply {
        text = label
        setOnClickListener { onClick() }
        layoutParams = matchWrap()
    }

    private fun card(title: String, build: LinearLayout.() -> Unit): View {
        val card = MaterialCardView(this).apply {
            setPadding(dp(14), dp(14), dp(14), dp(14))
            layoutParams = matchWrap().apply { topMargin = dp(16) }
            radius = dp(16).toFloat()
        }
        val inner = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(text(title, 16f, R.color.text_primary).apply { setPadding(0, 0, 0, dp(6)) })
            build()
        }
        card.addView(inner)
        return card
    }

    private fun openAccessibilitySettings() {
        runCatching { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
            .onFailure { toast("could not open accessibility settings") }
    }

    private fun openOverlaySettings() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            runCatching {
                startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            }.onFailure { toast("could not open overlay settings") }
        } else {
            toast("overlay permission is already granted")
        }
    }

    /** Reads the live permission state; nothing here is assumed to be granted. */
    private fun refreshStatus() {
        val overlay = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) Settings.canDrawOverlays(this) else true
        val accessibility = TranslatorAccessibilityService.isEnabled()
        permissionsStatus.text = listOf(
            "${mark(overlay)} Overlay permission (draw over other apps)",
            "${mark(accessibility)} Accessibility service running",
        ).joinToString("\n")
    }

    private fun mark(ok: Boolean): String = if (ok) "\u2713" else "\u2717"

    private fun saveSettings() {
        AppSettings.save(
            this,
            AppSettings.Snapshot(
                baseUrl = urlField.text?.toString().orEmpty(),
                token = tokenField.text?.toString().orEmpty(),
                replyTarget = replyLangField.text?.toString().orEmpty().ifBlank { "English" },
                readTarget = readLangField.text?.toString().orEmpty().ifBlank { "French" },
                autoTranslateLastMessage = true,
            ),
        )
        toast("settings saved")
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }
}

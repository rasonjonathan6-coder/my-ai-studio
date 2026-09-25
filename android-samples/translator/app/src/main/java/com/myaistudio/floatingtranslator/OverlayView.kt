package com.myaistudio.floatingtranslator

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors

/**
 * The floating UI: a small draggable bubble that expands into a compact panel.
 *
 * The bubble is a separate, touchable, non-focusable window so it can be moved
 * and tapped without stealing the keyboard from the app underneath. The panel is
 * the one window that takes focus, because it contains the text field.
 *
 * Pressing Enter in the field inserts a newline - the field is multiline and no
 * IME action is bound to send. Injection happens only from the Send button.
 */
@SuppressLint("ViewConstructor")
class OverlayView(private val context: Context) : OverlayController.Listener {

    private val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private val io = Executors.newSingleThreadExecutor()

    private var bubble: View? = null
    private var panel: View? = null
    private var statusView: TextView? = null
    private var lastMessageView: TextView? = null
    private var input: EditText? = null

    /** Latest candidate for "the last message", translated on demand. */
    private var pendingLastMessage: String? = null

    private fun dp(value: Int): Int = (value * context.resources.displayMetrics.density).toInt()

    private fun bubbleParams(): WindowManager.LayoutParams = WindowManager.LayoutParams(
        dp(56), dp(56),
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        // Not focusable: the bubble must never take the keyboard away from the
        // app the user is typing in.
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    ).apply { gravity = Gravity.TOP or Gravity.START; x = dp(12); y = dp(160) }

    private fun panelParams(): WindowManager.LayoutParams = WindowManager.LayoutParams(
        dp(320), WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        // Focusable so the field can take the keyboard; the panel is dismissed by
        // its own close control rather than by touching the app behind it.
        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    ).apply { gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL; y = dp(120) }

    private fun surfaceColor(): Int = Color.parseColor("#EE1B1B2F")
    private fun accentColor(): Int = Color.parseColor("#B14BFF")
    private fun accentColor2(): Int = Color.parseColor("#00D4FF")

    private fun rounded(bg: Int, radiusDp: Int): GradientDrawable = GradientDrawable().apply {
        setColor(bg)
        cornerRadius = dp(radiusDp).toFloat()
    }

    fun showBubble() {
        if (bubble != null) return
        val view = TextView(context).apply {
            text = "\uD83C\uDF10" // globe
            textSize = 22f
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(accentColor(), accentColor2())).apply {
                shape = GradientDrawable.OVAL
            }
            elevation = dp(6).toFloat()
            contentDescription = "Floating translator bubble. Tap to open, drag to move."
            isClickable = true
        }
        attachDrag(view, bubbleParams())
        view.setOnClickListener { togglePanel() }
        runCatching { windowManager.addView(view, bubbleParams()) }
            .onSuccess { bubble = view }
            .onFailure { OverlayController.onServiceStatus("overlay permission missing", "error") }
    }

    fun dismissBubble() {
        bubble?.let { runCatching { windowManager.removeView(it) } }
        bubble = null
        dismissPanel()
    }

    private fun togglePanel() {
        if (panel != null) dismissPanel() else showPanel()
    }

    private fun showPanel() {
        if (panel != null) return
        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = rounded(surfaceColor(), 18)
            setPadding(dp(14), dp(12), dp(14), dp(12))
            elevation = dp(8).toFloat()
        }

        // Header: title on the left, close on the right. The language labels are
        // not crammed into the header; each action states its own direction.
        val header = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        header.addView(TextView(context).apply {
            text = "AI Translator"
            setTextColor(Color.WHITE)
            textSize = 16f
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        })
        header.addView(TextView(context).apply {
            text = "\u2715"
            setTextColor(Color.parseColor("#BBBBBB"))
            textSize = 16f
            setPadding(dp(10), dp(4), dp(4), dp(4))
            contentDescription = "Close panel"
            isClickable = true
            setOnClickListener { dismissPanel() }
        })
        root.addView(header)

        statusView = TextView(context).apply {
            text = "idle"
            setTextColor(Color.parseColor("#9AA0B5"))
            textSize = 11f
            setPadding(0, dp(2), 0, dp(6))
        }
        root.addView(statusView)

        // Input. Multiline with no IME action, so the Enter key is a newline and
        // never sends. Sending is the button's job alone.
        input = EditText(context).apply {
            hint = "Text to translate"
            setHintTextColor(Color.parseColor("#7A7F94"))
            setTextColor(Color.WHITE)
            textSize = 15f
            background = rounded(Color.parseColor("#2A2A3D"), 12)
            setPadding(dp(10), dp(8), dp(10), dp(8))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            maxLines = 4
            minLines = 2
            gravity = Gravity.TOP or Gravity.START
            isSingleLine = false
            imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_NONE
            contentDescription = "Text to translate"
        }
        root.addView(input)

        val actions = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(8), 0, 0)
        }

        val send = Button(context).apply {
            text = "Send"
            textSize = 14f
            setTextColor(Color.WHITE)
            background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(accentColor(), accentColor2())).apply {
                cornerRadius = dp(12).toFloat()
            }
            minHeight = dp(46)
            contentDescription = "Translate and inject the text into the focused field"
        }
        send.setOnClickListener { onSend() }
        actions.addView(send, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

        val read = Button(context).apply {
            text = "Read last"
            textSize = 14f
            setTextColor(Color.WHITE)
            background = rounded(Color.parseColor("#3A2E52"), 12)
            minHeight = dp(46)
            contentDescription = "Translate the last visible message into the read language"
        }
        read.setOnClickListener { onReadLast() }
        actions.addView(read, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(8) })

        root.addView(actions)

        lastMessageView = TextView(context).apply {
            text = ""
            setTextColor(Color.parseColor("#D6D9E6"))
            textSize = 13f
            setPadding(dp(10), dp(10), dp(10), dp(10))
            visibility = View.GONE
        }
        root.addView(ScrollView(context).apply {
            addView(lastMessageView)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(120))
        })

        runCatching { windowManager.addView(root, panelParams()) }
            .onSuccess { panel = root }
            .onFailure { OverlayController.onServiceStatus("could not show panel", "error") }

        if (pendingLastMessage != null) renderCandidate()
    }

    fun dismissPanel() {
        input?.let { runCatching { windowManager.removeViewImmediate(it.rootView) } }
        panel = null
        input = null
        statusView = null
        lastMessageView = null
    }

    fun isPanelVisible(): Boolean = panel != null

    /** Drag is handled on the bubble only; the panel stays put so it cannot be lost off-screen. */
    private fun attachDrag(view: View, params: WindowManager.LayoutParams) {
        var startX = 0
        var startY = 0
        var touchX = 0f
        var touchY = 0f
        view.setOnTouchListener { v, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startX = params.x; startY = params.y
                    touchX = event.rawX; touchY = event.rawY
                    false
                }
                MotionEvent.ACTION_MOVE -> {
                    params.x = startX + (event.rawX - touchX).toInt()
                    params.y = startY + (event.rawY - touchY).toInt()
                    runCatching { windowManager.updateViewLayout(v, params) }
                    true
                }
                else -> false
            }
        }
    }

    /**
     * Send: translate the typed text, inject it into the focused field, and report
     * which of the two actually happened. The overlay never shows "injected"
     * unless the field was read back and matched.
     */
    private fun onSend() {
        val text = input?.text?.toString()?.trim().orEmpty()
        if (text.isEmpty()) {
            setStatus("nothing to send", "error"); return
        }
        val settings = AppSettings.load(context)
        if (!settings.configured) {
            setStatus("set the session token in the app", "error"); return
        }

        setStatus("translating…", "info")
        io.execute {
            // The studio address is read here rather than from settings, so this
            // APK keeps working after the studio moves. On the IO thread, because
            // discovery performs a network call.
            val baseUrl = when (val resolved = StudioUrlResolver.resolveBaseUrl(settings.baseUrlOverride)) {
                is StudioUrlResolver.Result.Resolved -> resolved.studioUrl
                is StudioUrlResolver.Result.Failed -> {
                    post { setStatus("studio address unavailable: ${resolved.reason}", "error") }
                    return@execute
                }
            }
            val result = TranslationClient.translate(
                TranslationClient.Config(baseUrl, settings.token),
                text,
                source = null,       // let the model detect the source
                target = settings.replyTarget,
            )
            post {
                when (result) {
                    is TranslatorCore.TranslationResult.Failed -> setStatus("translation failed: ${result.reason}", "error")
                    is TranslatorCore.TranslationResult.Ok -> {
                        setStatus("translated by ${result.provider ?: "provider"}; injecting…", "info")
                        val injected = TranslatorAccessibilityService.instance?.injectIntoField(result.translation)
                        reportInjection(injected, result.translation)
                    }
                }
            }
        }
    }

    private fun reportInjection(result: TranslatorAccessibilityService.InjectionResult?, translation: String) {
        when (result) {
            null -> setStatus("accessibility service is not running; cannot inject", "error")
            TranslatorAccessibilityService.InjectionResult.Injected ->
                setStatus("injected into the focused field (${TranslatorCore.preview(translation, 24)})", "ok")
            TranslatorAccessibilityService.InjectionResult.NoField ->
                setStatus("no focused text field found in the other app", "error")
            TranslatorAccessibilityService.InjectionResult.NotAField ->
                setStatus("the focused view is not an editable field", "error")
            TranslatorAccessibilityService.InjectionResult.Refused ->
                setStatus("the app refused ACTION_SET_TEXT; showing the translation instead", "error")
            is TranslatorAccessibilityService.InjectionResult.Unsupported ->
                setStatus("injection unsupported: ${result.reason}", "error")
            is TranslatorAccessibilityService.InjectionResult.Error ->
                setStatus("injection error: ${result.reason}", "error")
            is TranslatorAccessibilityService.InjectionResult.NotVerified ->
                setStatus("not injected: the field still reads \"${TranslatorCore.preview(result.actual ?: "", 20)}\"", "error")
        }
        if (result !is TranslatorAccessibilityService.InjectionResult.Injected) {
            showResult(translation, noField = true)
        }
    }

    /** Read last: translate the newest visible message into the read language. */
    private fun onReadLast() {
        val candidate = pendingLastMessage ?: TranslatorCore.lastNewMessage(
            TranslatorAccessibilityService.lastVisible,
            TranslatorAccessibilityService.lastTranslatedSource,
        )
        if (candidate == null) {
            setStatus("no readable message exposed by the other app", "error"); return
        }
        val settings = AppSettings.load(context)
        if (!settings.configured) {
            setStatus("set the session token in the app", "error"); return
        }

        setStatus("translating last message…", "info")
        io.execute {
            // Resolved per attempt, as in the send flow, so a studio that moved
            // between two translations is picked up without restarting the app.
            val baseUrl = when (val resolved = StudioUrlResolver.resolveBaseUrl(settings.baseUrlOverride)) {
                is StudioUrlResolver.Result.Resolved -> resolved.studioUrl
                is StudioUrlResolver.Result.Failed -> {
                    post { setStatus("studio address unavailable: ${resolved.reason}", "error") }
                    return@execute
                }
            }
            val result = TranslationClient.translate(
                TranslationClient.Config(baseUrl, settings.token),
                candidate,
                source = null,
                target = settings.readTarget,
            )
            post {
                when (result) {
                    is TranslatorCore.TranslationResult.Failed -> setStatus("translation failed: ${result.reason}", "error")
                    is TranslatorCore.TranslationResult.Ok -> {
                        // Record the source so the same message is not translated again.
                        TranslatorAccessibilityService.lastTranslatedSource = candidate
                        showResult("${TranslatorCore.preview(candidate, 40)}\n→ ${result.translation}")
                        setStatus("translated by ${result.provider ?: "provider"}", "ok")
                    }
                }
            }
        }
    }

    private fun showResult(text: String, noField: Boolean = false) {
        val view = lastMessageView ?: return
        view.visibility = View.VISIBLE
        view.text = if (noField) "$text\n(not injected)" else text
    }

    private fun setStatus(message: String, level: String) {
        val view = statusView ?: return
        view.text = message
        view.setTextColor(
            when (level) {
                "ok" -> Color.parseColor("#5BE49B")
                "error" -> Color.parseColor("#FF7A8A")
                else -> Color.parseColor("#9AA0B5")
            },
        )
    }

    private fun post(block: () -> Unit) {
        android.os.Handler(context.mainLooper).post(block)
    }

    private fun renderCandidate() {
        val candidate = pendingLastMessage ?: return
        showResult("last message: ${TranslatorCore.preview(candidate, 60)}\nTap “Read last” to translate.")
    }

    override fun onServiceStatus(message: String, level: String) {
        post { setStatus(message, level) }
    }

    override fun onTextAvailable(allText: List<String>, newest: String?) {
        pendingLastMessage = newest
        post {
            if (panel != null && newest != null) renderCandidate()
            // Auto-read is off by default in spirit: it only translates when asked,
            // because injecting text without the user pressing Send is surprising.
        }
    }

    fun shutdown() {
        dismissBubble()
        io.shutdownNow()
    }
}

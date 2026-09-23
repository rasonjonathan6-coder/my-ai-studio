package com.myaistudio.floatingtranslator

import android.content.Context
import android.graphics.PixelFormat
import android.view.Gravity
import android.view.WindowManager
import android.widget.TextView

/** Simple system overlay used to display the translated text. */
class OverlayView(private val context: Context) {
    private val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private var view: TextView? = null

    fun show(text: String) {
        dismiss()
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL }

        val textView = TextView(context).apply { this.text = text }
        windowManager.addView(textView, params)
        view = textView
    }

    fun dismiss() {
        view?.let {
            runCatching { windowManager.removeView(it) }
            view = null
        }
    }
}

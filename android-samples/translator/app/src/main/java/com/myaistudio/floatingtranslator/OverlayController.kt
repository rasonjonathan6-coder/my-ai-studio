package com.myaistudio.floatingtranslator

import android.app.Application
import java.lang.ref.WeakReference

/**
 * The bridge between the accessibility service and the overlay.
 *
 * The service can be created before, after or independently of the overlay, so
 * neither holds a hard reference to the other. Updates raised while no overlay
 * exists are dropped rather than queued: showing a stale "last message" long
 * after it was seen would be worse than showing nothing.
 */
object OverlayController {

    /** Set once by the app so the overlay can build its UI without a Service context. */
    @Volatile
    var appContext: Application? = null

    interface Listener {
        fun onServiceStatus(message: String, level: String)
        fun onTextAvailable(allText: List<String>, newest: String?)
    }

    private var listener: WeakReference<Listener>? = null

    fun attach(target: Listener) {
        listener = WeakReference(target)
    }

    fun detach() {
        listener = null
    }

    fun onServiceStatus(message: String, level: String) {
        listener?.get()?.onServiceStatus(message, level)
    }

    fun onTextAvailable(allText: List<String>, newest: String?) {
        listener?.get()?.onTextAvailable(allText, newest)
    }
}

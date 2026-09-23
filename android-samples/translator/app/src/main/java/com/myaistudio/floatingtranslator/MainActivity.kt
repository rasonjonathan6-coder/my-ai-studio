package com.myaistudio.floatingtranslator

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val layout = android.widget.LinearLayout(this).apply { orientation = android.widget.LinearLayout.VERTICAL }
        val info = TextView(this).apply {
            text = "Enable the accessibility service to show the translate overlay.\n" +
                "Some apps block accessibility APIs; translation may be unavailable there."
        }
        val open = Button(this).apply { text = "Open accessibility settings" }
        open.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        layout.addView(info)
        layout.addView(open)
        setContentView(layout)
    }
}

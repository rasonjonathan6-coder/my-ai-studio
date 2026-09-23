package com.myaistudio.calculator

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val layout = android.widget.LinearLayout(this).apply { orientation = android.widget.LinearLayout.VERTICAL }
        val left = EditText(this).apply { hint = "First number" }
        val right = EditText(this).apply { hint = "Second number" }
        val result = TextView(this)
        val add = Button(this).apply { text = "Add" }
        add.setOnClickListener {
            val a = left.text.toString().toDoubleOrNull() ?: 0.0
            val b = right.text.toString().toDoubleOrNull() ?: 0.0
            result.text = Calculator.add(a, b).toString()
        }
        layout.addView(left)
        layout.addView(right)
        layout.addView(add)
        layout.addView(result)
        setContentView(layout)
    }
}

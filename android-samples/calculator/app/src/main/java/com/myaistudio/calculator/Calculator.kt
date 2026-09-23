package com.myaistudio.calculator

/** Pure arithmetic used by both the UI and the unit tests. */
object Calculator {
    fun add(a: Double, b: Double): Double = a + b
    fun subtract(a: Double, b: Double): Double = a - b
    fun multiply(a: Double, b: Double): Double = a * b
    fun divide(a: Double, b: Double): Double {
        require(b != 0.0) { "division by zero" }
        return a / b
    }
}

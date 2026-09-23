package com.myaistudio.calculator

import org.junit.Assert.assertEquals
import org.junit.Test

class CalculatorTest {
    @Test
    fun addWorks() {
        assertEquals(5.0, Calculator.add(2.0, 3.0), 0.0001)
    }

    @Test
    fun subtractWorks() {
        assertEquals(1.0, Calculator.subtract(3.0, 2.0), 0.0001)
    }

    @Test
    fun multiplyWorks() {
        assertEquals(12.0, Calculator.multiply(3.0, 4.0), 0.0001)
    }

    @Test
    fun divideWorks() {
        assertEquals(2.5, Calculator.divide(5.0, 2.0), 0.0001)
    }
}

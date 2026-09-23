package com.myaistudio.hello

import org.junit.Assert.assertEquals
import org.junit.Test

class GreetingTest {
    @Test
    fun messageIsStable() {
        assertEquals("Hello from My AI Studio", Greeting.message())
    }
}

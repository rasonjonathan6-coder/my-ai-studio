plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.myaistudio.floatingtranslator"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.myaistudio.floatingtranslator"
        minSdk = 24
        targetSdk = 34
        versionCode = 2
        versionName = "2.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    testImplementation("junit:junit:4.13.2")
    // The Android SDK ships org.json as a stub that throws under unit tests, so
    // the real implementation goes on the test classpath only.
    testImplementation("org.json:json:20240303")
}

// Note: the accessibility service and the overlay both need permissions the
// user grants by hand in system settings. Some applications deliberately block
// accessibility APIs for security, so field access and text injection do not
// work everywhere; the app reports what it could not do instead of pretending.

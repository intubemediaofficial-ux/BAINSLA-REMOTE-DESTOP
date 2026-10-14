plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val signingPath = providers.environmentVariable("KV_DESK_KEYSTORE_PATH")
    .orElse("${System.getProperty("user.home")}/kvdesk-keys/kvdesk-release.jks")
    .get()
val signingStorePassword = providers.environmentVariable("KV_DESK_KEYSTORE_PASSWORD").orNull
val signingKeyPassword = providers.environmentVariable("KV_DESK_KEY_PASSWORD").orNull
val signingAlias = providers.environmentVariable("KV_DESK_KEY_ALIAS").orElse("kvdesk").get()
val canSignRelease = !signingStorePassword.isNullOrBlank() &&
    !signingKeyPassword.isNullOrBlank() &&
    file(signingPath).exists()

android {
    namespace = "com.kvspt.kvdesk"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.bainsla.remote"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("release") {
            if (canSignRelease) {
                storeFile = file(signingPath)
                storePassword = signingStorePassword
                keyAlias = signingAlias
                keyPassword = signingKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (canSignRelease) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
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
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("io.socket:socket.io-client:2.1.1")
    implementation("io.getstream:stream-webrtc-android:1.3.10")

    testImplementation("junit:junit:4.13.2")
    debugImplementation("androidx.compose.ui:ui-tooling")
}

tasks.matching { it.name == "assembleRelease" }.configureEach {
    doFirst {
        check(canSignRelease) {
            "Release signing is required. Set KV_DESK_KEYSTORE_PATH, KV_DESK_KEYSTORE_PASSWORD, KV_DESK_KEY_PASSWORD, and KV_DESK_KEY_ALIAS."
        }
    }
}

val copyReleaseApk = tasks.register("copyReleaseApk") {
    doLast {
        val source = layout.buildDirectory.file("outputs/apk/release/app-release.apk").get().asFile
        source.copyTo(source.resolveSibling("BainslaRemote-1.0.0.apk"), overwrite = true)
    }
}

tasks.matching { it.name == "assembleRelease" }.configureEach {
    finalizedBy(copyReleaseApk)
}
